// gmail.ts — Gmail REST API calls via service account impersonation

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users";

// ---------------------------------------------------------------------------
// MIME type config
// ---------------------------------------------------------------------------

const PDF_MIME_TYPE = "application/pdf";

const NON_PDF_INVOICE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

const isSupportedMime = (mimeType: string): boolean =>
  mimeType === PDF_MIME_TYPE || NON_PDF_INVOICE_MIME_TYPES.has(mimeType);

const isPdfMime = (mimeType: string): boolean => mimeType === PDF_MIME_TYPE;

// ---------------------------------------------------------------------------
// Gmail REST helpers
// ---------------------------------------------------------------------------

type GmailLabel = { id: string; name: string };
type GmailMessageRef = { id: string; threadId: string };
type GmailMessagePart = {
  partId: string;
  mimeType: string;
  filename: string;
  body: { attachmentId?: string; size: number; data?: string };
  parts?: GmailMessagePart[];
};
type GmailMessage = {
  id: string;
  threadId: string;
  internalDate: string; // ms since epoch as string
  payload: GmailMessagePart;
};

const gmailGet = <T>(path: string): T => {
  const token = getGmailToken();
  const response = withRetry(() =>
    UrlFetchApp.fetch(`${GMAIL_API_BASE}/me/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true,
    })
  );
  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`Gmail GET ${path} failed (${status}): ${response.getContentText()}`);
  }
  return JSON.parse(response.getContentText()) as T;
};

const gmailPost = <T>(path: string, body: object): T => {
  const token = getGmailToken();
  const response = withRetry(() =>
    UrlFetchApp.fetch(`${GMAIL_API_BASE}/me/${path}`, {
      method: "post",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    })
  );
  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`Gmail POST ${path} failed (${status}): ${response.getContentText()}`);
  }
  return JSON.parse(response.getContentText()) as T;
};

// ---------------------------------------------------------------------------
// Label resolution
// ---------------------------------------------------------------------------

/** Returns the Gmail label ID for a given label name, creating it if absent. */
const ensureLabelId = (name: string): string => {
  const { labels } = gmailGet<{ labels: GmailLabel[] }>("labels");
  const existing = labels.find((l) => l.name === name);
  if (existing) return existing.id;

  const created = gmailPost<GmailLabel>("labels", { name });
  return created.id;
};

// ---------------------------------------------------------------------------
// Thread listing
// ---------------------------------------------------------------------------

type ThreadListResponse = { threads?: GmailMessageRef[]; nextPageToken?: string };

/** Returns all inbox thread IDs carrying the given label. Handles pagination. */
const listInboxThreadIds = (labelId: string): string[] => {
  const allThreads: string[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = {
      labelIds: labelId,
      q: "in:inbox",
      maxResults: "100",
      ...(pageToken ? { pageToken } : {}),
    };

    const data = gmailGet<ThreadListResponse>(`threads?${buildQueryString(params)}`);
    (data.threads ?? []).forEach((t) => allThreads.push(t.id));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allThreads;
};

// ---------------------------------------------------------------------------
// Message and attachment fetching
// ---------------------------------------------------------------------------

type ThreadData = { messages: GmailMessage[] };

const getThread = (threadId: string): GmailMessage[] =>
  gmailGet<ThreadData>(`threads/${threadId}?format=full`).messages;

/** Recursively flattens a MIME part tree to find all leaf parts. */
const flattenParts = (part: GmailMessagePart): GmailMessagePart[] =>
  part.parts
    ? part.parts.flatMap(flattenParts)
    : [part];

type AttachmentInfo = {
  filename: string;
  mimeType: string;
  attachmentId: string;
  messageId: string;
};

/** Extracts attachment metadata from a message's payload. */
const getAttachmentInfos = (message: GmailMessage): AttachmentInfo[] =>
  flattenParts(message.payload)
    .filter((p) => p.filename && p.body.attachmentId && isSupportedMime(p.mimeType))
    .map((p) => ({
      filename: p.filename,
      mimeType: p.mimeType,
      attachmentId: p.body.attachmentId!,
      messageId: message.id,
    }));

/** Downloads attachment bytes and returns a Blob. */
const downloadAttachment = (messageId: string, attachmentId: string, filename: string, mimeType: string): GoogleAppsScript.Base.Blob => {
  const token = getGmailToken();
  const response = withRetry(() =>
    UrlFetchApp.fetch(
      `${GMAIL_API_BASE}/me/messages/${messageId}/attachments/${attachmentId}`,
      { headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true }
    )
  );
  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`Attachment download failed (${status}): ${response.getContentText()}`);
  }
  const { data } = JSON.parse(response.getContentText()) as { data: string };
  // Gmail returns base64url — convert to standard base64 before decoding
  const bytes = Utilities.base64Decode(data.replace(/-/g, "+").replace(/_/g, "/"));
  return Utilities.newBlob(bytes, mimeType, filename);
};

// ---------------------------------------------------------------------------
// Thread archiving
// ---------------------------------------------------------------------------

/** Removes the INBOX label from a thread — equivalent to archiving. */
const archiveThread = (threadId: string): void => {
  gmailPost(`threads/${threadId}/modify`, { removeLabelIds: ["INBOX"] });
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

type SavedFile = {
  name: string;
  dateUsed: Date;
  dateSource: "gemini" | "thread";
};

type ProcessedThread = {
  threadId: string;
  savedFiles: SavedFile[];
  skippedAttachments: number;
};

type SkippedThread = {
  threadId: string;
  reason: string;
};

type ScanResult = {
  processed: ProcessedThread[];
  skipped: SkippedThread[];
};

// ---------------------------------------------------------------------------
// Per-attachment processing
// ---------------------------------------------------------------------------

const getThreadDate = (messages: GmailMessage[]): Date =>
  new Date(parseInt(messages[0].internalDate, 10));

const processPdfAttachment = (
  blob: GoogleAppsScript.Base.Blob,
  fallbackDate: Date,
  rootFolderId: string,
): SavedFile | null => {
  const classification = classifyPdf(blob);

  Logger.log(
    `"${blob.getName()}" → type: ${classification.type}, date: ${classification.documentDate}, note: ${classification.note}`
  );

  if (classification.type !== "invoice") {
    Logger.log(`Skipping "${blob.getName()}" — classified as ${classification.type}`);
    return null;
  }

  const geminiDate = parseDateString(classification.documentDate);
  const dateUsed = geminiDate ?? fallbackDate;
  const dateSource: "gemini" | "thread" = geminiDate ? "gemini" : "thread";

  if (!geminiDate) {
    Logger.log(`No date from Gemini for "${blob.getName()}", using thread date: ${fallbackDate.toISOString()}`);
  }

  const file = saveAttachmentToFolder(blob, dateUsed, rootFolderId);
  return { name: file.getName(), dateUsed, dateSource };
};

const processNonPdfAttachment = (
  blob: GoogleAppsScript.Base.Blob,
  threadDate: Date,
  rootFolderId: string,
): SavedFile => {
  const file = saveAttachmentToFolder(blob, threadDate, rootFolderId);
  return { name: file.getName(), dateUsed: threadDate, dateSource: "thread" };
};

const processAttachmentInfo = (
  info: AttachmentInfo,
  threadDate: Date,
  rootFolderId: string,
): SavedFile | null => {
  const blob = downloadAttachment(info.messageId, info.attachmentId, info.filename, info.mimeType);
  return isPdfMime(info.mimeType)
    ? processPdfAttachment(blob, threadDate, rootFolderId)
    : processNonPdfAttachment(blob, threadDate, rootFolderId);
};

// ---------------------------------------------------------------------------
// Main scan function
// ---------------------------------------------------------------------------

/**
 * Scans inbox threads with the invoice label via Gmail REST API,
 * classifies PDFs via Gemini, saves invoices to Drive, then archives threads.
 * All calls are authenticated as the configured Workspace user via service account
 * domain-wide delegation.
 */
const processInvoiceThreads = (): ScanResult => {
  const rootFolderId = getRootFolderId();
  const labelId = ensureLabelId(getGmailLabel());
  const threadIds = listInboxThreadIds(labelId);

  const results = threadIds.map((threadId): ProcessedThread | SkippedThread => {
    try {
      const messages = getThread(threadId);
      const threadDate = getThreadDate(messages);

      const attachmentInfos = messages.flatMap(getAttachmentInfos);

      if (attachmentInfos.length === 0) {
        archiveThread(threadId);
        return { threadId, reason: "no supported attachments" } satisfies SkippedThread;
      }

      const fileResults = attachmentInfos.map((info) =>
        processAttachmentInfo(info, threadDate, rootFolderId)
      );

      const savedFiles = fileResults.filter((r): r is SavedFile => r !== null);
      const skippedAttachments = fileResults.filter((r) => r === null).length;

      archiveThread(threadId);

      Logger.log(
        `Thread ${threadId}: saved ${savedFiles.length}, skipped ${skippedAttachments} → archived`
      );

      return { threadId, savedFiles, skippedAttachments } satisfies ProcessedThread;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      // Do NOT archive on error — leave in inbox for retry.
      Logger.log(`Error processing thread ${threadId}: ${reason}`);
      return { threadId, reason } satisfies SkippedThread;
    }
  });

  const processed = results.filter((r): r is ProcessedThread => "savedFiles" in r);
  const skipped   = results.filter((r): r is SkippedThread => "reason" in r);

  Logger.log(`Done — processed: ${processed.length}, skipped: ${skipped.length}`);
  return { processed, skipped };
};
