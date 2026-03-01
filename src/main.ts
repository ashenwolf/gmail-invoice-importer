// main.ts — entry points exposed to Apps Script runtime

// ---------------------------------------------------------------------------
// Public trigger functions (must be global, non-arrow, for Apps Script)
// ---------------------------------------------------------------------------

/**
 * Time-based trigger target.
 * Apps Script calls this automatically (e.g. every hour).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runInvoiceCollector(): void {
  processInvoiceThreads();
}

/**
 * One-shot manual run — useful to test from the editor.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runManually(): void {
  const result = processInvoiceThreads();
  Logger.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// First-time setup helpers
// ---------------------------------------------------------------------------

/**
 * Call this once to configure the script.
 *
 * @param rootFolderId      - Drive folder ID for YYYY/YYYY-MM structure
 * @param geminiApiKey      - Gemini API key from https://aistudio.google.com/app/apikey
 * @param serviceAccountKey - Full contents of the service account JSON key file
 * @param impersonateEmail  - Workspace user email the service account will act as
 * @param gmailLabel        - Gmail label to scan (default: "invoices")
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setupConfig(
  rootFolderId: string,
  geminiApiKey: string,
  serviceAccountKey: string,
  impersonateEmail: string,
  gmailLabel = "invoices",
): void {
  if (!rootFolderId) throw new Error("rootFolderId is required");
  if (!geminiApiKey) throw new Error("geminiApiKey is required");
  if (!serviceAccountKey) throw new Error("serviceAccountKey is required");
  if (!impersonateEmail) throw new Error("impersonateEmail is required");

  // Validate the key is parseable before storing
  try {
    JSON.parse(serviceAccountKey);
  } catch {
    throw new Error("serviceAccountKey must be the full JSON key file contents");
  }

  saveConfig({ rootFolderId, geminiApiKey, serviceAccountKey, impersonateEmail, gmailLabel });
  Logger.log(`Configured: rootFolderId=${rootFolderId}, impersonate=${impersonateEmail}, label=${gmailLabel}`);
}

/**
 * Installs a time-based trigger that runs every hour.
 * Safe to call multiple times — removes existing triggers first.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function installTrigger(): void {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "runInvoiceCollector")
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("runInvoiceCollector").timeBased().everyHours(1).create();

  Logger.log("Hourly trigger installed for runInvoiceCollector.");
}

/**
 * Removes all triggers for this script.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function removeTriggers(): void {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  Logger.log("All triggers removed.");
}

/**
 * Prints current config to Logger — sanity check before going live.
 * Does NOT print the service account key.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function printConfig(): void {
  Logger.log(
    JSON.stringify(
      {
        rootFolderId: getRootFolderId(),
        gmailLabel: getGmailLabel(),
        impersonateEmail: getImpersonateEmail(),
        serviceAccountKey: "<redacted>",
        geminiApiKey: "<redacted>",
      },
      null,
      2,
    ),
  );
}

/**
 * Clears all cached access tokens.
 * Run this after updating domain-wide delegation scopes.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function clearTokenCache(): void {
  CacheService.getScriptCache().removeAll([
    `sa_access_token_${getImpersonateEmail()}_https://www.googleapis.com/auth/gmail.modify`,
    `sa_access_token_${getImpersonateEmail()}_https://www.googleapis.com/auth/drive`,
  ]);
  Logger.log("Token cache cleared.");
}
