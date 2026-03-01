// auth.ts — Service account JWT minting and access token management
//
// Flow:
//   1. Load service account JSON from ScriptProperties
//   2. Build a JWT signed with the private key (RS256)
//   3. Exchange the JWT for a short-lived access token at Google's token endpoint
//   4. Cache the token for its lifetime (max 1 hour) to avoid redundant round-trips
//
// Domain-wide delegation must be granted in the Workspace Admin console
// for this service account before any impersonated calls will succeed.

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_CACHE_KEY_PREFIX = "sa_access_token_";
const TOKEN_LIFETIME_SEC = 3600; // Google max for service account tokens
// Refresh 5 minutes before expiry to avoid using a token that expires mid-run
const TOKEN_REFRESH_BUFFER_SEC = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  private_key_id: string;
  project_id: string;
};

type AccessToken = {
  token: string;
  expiresAt: number; // Unix timestamp ms
};

// ---------------------------------------------------------------------------
// Service account key loading
// ---------------------------------------------------------------------------

/**
 * Loads and parses the service account JSON key from ScriptProperties.
 * The full JSON key file contents should be stored under the SA_KEY property.
 */
const loadServiceAccountKey = (): ServiceAccountKey => {
  const raw = getRequiredProp(PROP_KEYS.serviceAccountKey);
  try {
    return JSON.parse(raw) as ServiceAccountKey;
  } catch {
    throw new Error("SA_KEY is not valid JSON. Store the full service account key file contents.");
  }
};

// ---------------------------------------------------------------------------
// JWT building (RS256)
// ---------------------------------------------------------------------------

const base64UrlEncode = (input: string): string =>
  Utilities.base64EncodeWebSafe(input).replace(/=+$/, "");

const buildJwtHeader = (): string =>
  base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));

const buildJwtClaims = (
  clientEmail: string,
  scopes: string[],
  impersonateEmail: string,
): string => {
  const now = Math.floor(Date.now() / 1000);
  return base64UrlEncode(JSON.stringify({
    iss: clientEmail,
    sub: impersonateEmail,   // the Workspace user to impersonate
    scope: scopes.join(" "),
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + TOKEN_LIFETIME_SEC,
  }));
};

const signJwt = (header: string, claims: string, privateKey: string): string => {
  const payload = `${header}.${claims}`;
  const signatureBytes = Utilities.computeRsaSha256Signature(payload, privateKey);
  // computeRsaSha256Signature returns signed bytes (-128 to 127).
  // Convert to unsigned (0-255) before encoding, then use Utilities for base64url.
  const signatureBase64 = Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, "");
  return `${payload}.${signatureBase64}`;
};

const buildJwt = (key: ServiceAccountKey, scopes: string[], impersonateEmail: string): string => {
  const header = buildJwtHeader();
  const claims = buildJwtClaims(key.client_email, scopes, impersonateEmail);
  return signJwt(header, claims, key.private_key);
};

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

const exchangeJwtForToken = (jwt: string): AccessToken => {
  const response = UrlFetchApp.fetch(GOOGLE_TOKEN_URL, {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`Token exchange failed (${status}): ${response.getContentText()}`);
  }

  const body = JSON.parse(response.getContentText()) as { access_token: string; expires_in: number };
  return {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
};

// ---------------------------------------------------------------------------
// Cached token retrieval
// ---------------------------------------------------------------------------

const tokenCacheKey = (impersonateEmail: string, scopes: string[]): string =>
  `${TOKEN_CACHE_KEY_PREFIX}${impersonateEmail}_${scopes.sort().join(",")}`;

const getCachedToken = (impersonateEmail: string, scopes: string[]): AccessToken | null => {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(tokenCacheKey(impersonateEmail, scopes));
  if (!hit) return null;
  const parsed = JSON.parse(hit) as AccessToken;
  return parsed.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_SEC * 1000 ? parsed : null;
};

const setCachedToken = (impersonateEmail: string, scopes: string[], token: AccessToken): void => {
  const cache = CacheService.getScriptCache();
  const ttlSec = Math.floor((token.expiresAt - Date.now()) / 1000) - TOKEN_REFRESH_BUFFER_SEC;
  if (ttlSec > 0) {
    cache.put(tokenCacheKey(impersonateEmail, scopes), JSON.stringify(token), ttlSec);
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a valid Bearer access token for the given scopes, impersonating
 * the configured Workspace user via domain-wide delegation.
 *
 * Tokens are cached for their lifetime minus a 5-minute buffer.
 */
const getAccessToken = (scopes: string[]): string => {
  const impersonateEmail = getImpersonateEmail();
  const cached = getCachedToken(impersonateEmail, scopes);
  if (cached) return cached.token;

  const key = loadServiceAccountKey();
  const jwt = buildJwt(key, scopes, impersonateEmail);
  const token = withRetry(() => exchangeJwtForToken(jwt));

  setCachedToken(impersonateEmail, scopes, token);
  return token.token;
};

/** Convenience: access token scoped for Gmail modify operations. */
const getGmailToken = (): string =>
  getAccessToken(["https://www.googleapis.com/auth/gmail.modify"]);

/** Convenience: access token scoped for Drive read/write. */
const getDriveToken = (): string =>
  getAccessToken(["https://www.googleapis.com/auth/drive"]);
