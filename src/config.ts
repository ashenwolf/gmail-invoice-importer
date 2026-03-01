// config.ts — all user-configurable constants in one place

/** Script property keys stored via PropertiesService */
const PROP_KEYS = {
  rootFolderId:      "ROOT_FOLDER_ID",
  gmailLabel:        "GMAIL_LABEL",
  geminiApiKey:      "GEMINI_API_KEY",
  serviceAccountKey: "SA_KEY",        // full JSON key file contents
  impersonateEmail:  "IMPERSONATE_EMAIL", // Workspace user to act as
} as const;

type PropKey = (typeof PROP_KEYS)[keyof typeof PROP_KEYS];

/** Defaults used when no property is set yet */
const DEFAULTS = {
  gmailLabel: "invoices",
} as const;

// ---------------------------------------------------------------------------
// Properties helpers
// ---------------------------------------------------------------------------

// Service account credentials are sensitive — store in ScriptProperties
// (shared across all users of the script), not UserProperties.
const getScriptProps = () => PropertiesService.getScriptProperties();
const getUserProps  = () => PropertiesService.getUserProperties();

const SCRIPT_PROP_KEYS = new Set<PropKey>([
  PROP_KEYS.serviceAccountKey,
  PROP_KEYS.impersonateEmail,
]);

const getProps = (key: PropKey) =>
  SCRIPT_PROP_KEYS.has(key) ? getScriptProps() : getUserProps();

const getProp = (key: PropKey): string | null => getProps(key).getProperty(key);

const setProp = (key: PropKey, value: string): void =>
  void getProps(key).setProperty(key, value);

const getRequiredProp = (key: PropKey, fallback?: string): string => {
  const val = getProp(key) ?? fallback ?? null;
  if (!val) throw new Error(`Missing required setting: ${key}. Run setupConfig() first.`);
  return val;
};

// ---------------------------------------------------------------------------
// Public config accessors
// ---------------------------------------------------------------------------

/** Returns the Drive folder ID where invoices are stored (root). */
const getRootFolderId = (): string => getRequiredProp(PROP_KEYS.rootFolderId);

/** Returns the Gmail label name to scan for invoices. */
const getGmailLabel = (): string =>
  getProp(PROP_KEYS.gmailLabel) ?? DEFAULTS.gmailLabel;

/** Returns the Gemini API key. */
const getGeminiApiKey = (): string => getRequiredProp(PROP_KEYS.geminiApiKey);

/** Returns the raw service account JSON key string. */
const getServiceAccountKey = (): string => getRequiredProp(PROP_KEYS.serviceAccountKey);

/** Returns the Workspace email address the service account will impersonate. */
const getImpersonateEmail = (): string => getRequiredProp(PROP_KEYS.impersonateEmail);

/** Persists all config at once. */
const saveConfig = (opts: {
  rootFolderId: string;
  geminiApiKey: string;
  serviceAccountKey: string;
  impersonateEmail: string;
  gmailLabel?: string;
}): void => {
  setProp(PROP_KEYS.rootFolderId,      opts.rootFolderId);
  setProp(PROP_KEYS.geminiApiKey,      opts.geminiApiKey);
  setProp(PROP_KEYS.serviceAccountKey, opts.serviceAccountKey);
  setProp(PROP_KEYS.impersonateEmail,  opts.impersonateEmail);
  setProp(PROP_KEYS.gmailLabel,        opts.gmailLabel ?? DEFAULTS.gmailLabel);
  Logger.log("Config saved.");
};
