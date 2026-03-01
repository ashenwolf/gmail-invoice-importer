// utils.ts — shared helpers available to all modules (Apps Script global scope)

/**
 * Retries a function with exponential backoff.
 * Used for external API calls (Gemini) that may hit transient rate limits.
 */
const withRetry = <T>(
  fn: () => T,
  delays = [1000, 2000, 4000],
): T => {
  try {
    return fn();
  } catch (e: unknown) {
    if (delays.length === 0) throw e;
    const [head, ...tail] = delays;
    Utilities.sleep(head);
    return withRetry(fn, tail);
  }
};

/**
 * Builds a URL query string from a key-value object.
 * Replacement for URLSearchParams which is not available in Apps Script.
 */
const buildQueryString = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
