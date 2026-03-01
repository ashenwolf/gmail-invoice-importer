// drive.ts — Drive REST API calls via service account impersonation

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

type DriveFile = { id: string; name: string };
type FileListResponse = { files: DriveFile[] };

const driveGet = <T>(path: string, params?: Record<string, string>): T => {
  const token = getDriveToken();
  const query = params ? `?${buildQueryString(params)}` : "";
  const response = withRetry(() =>
    UrlFetchApp.fetch(`${DRIVE_API_BASE}/${path}${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true,
    })
  );
  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`Drive GET ${path} failed (${status}): ${response.getContentText()}`);
  }
  return JSON.parse(response.getContentText()) as T;
};

// ---------------------------------------------------------------------------
// Folder resolution
// ---------------------------------------------------------------------------

const padMonth = (month: number): string => String(month).padStart(2, "0");

const toFolderMonth = (date: Date): string =>
  `${date.getFullYear()}-${padMonth(date.getMonth() + 1)}`;

/** Finds a child folder by name under a given parent ID. Returns null if absent. */
const findChildFolder = (parentId: string, name: string): string | null => {
  const data = driveGet<FileListResponse>("files", {
    q: `'${parentId}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id,name)",
    pageSize: "1",
  });
  return data.files[0]?.id ?? null;
};

/** Creates a folder under parentId. Returns the new folder ID. */
const createFolder = (parentId: string, name: string): string => {
  const token = getDriveToken();
  const response = withRetry(() =>
    UrlFetchApp.fetch(`${DRIVE_API_BASE}/files`, {
      method: "post",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
      muteHttpExceptions: true,
    })
  );
  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`Drive folder creation failed (${status}): ${response.getContentText()}`);
  }
  return (JSON.parse(response.getContentText()) as DriveFile).id;
};

/** Gets or creates a child folder. Returns the folder ID. */
const ensureChildFolder = (parentId: string, name: string): string =>
  findChildFolder(parentId, name) ?? createFolder(parentId, name);

/**
 * Resolves (creating if needed): <rootFolder>/<YYYY>/<YYYY-MM>
 * Returns the leaf folder ID.
 */
const ensureInvoiceFolder = (date: Date, rootFolderId: string): string => {
  const yearFolder  = ensureChildFolder(rootFolderId, String(date.getFullYear()));
  return ensureChildFolder(yearFolder, toFolderMonth(date));
};

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------

/**
 * Uploads a blob to Drive using multipart upload.
 * Returns the created file's name (as stored in Drive).
 */
const uploadFileToDrive = (
  blob: GoogleAppsScript.Base.Blob,
  folderId: string,
): string => {
  const token = getDriveToken();
  const metadata = JSON.stringify({ name: blob.getName(), parents: [folderId] });
  const boundary = "invoice_collector_boundary";

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${blob.getContentType()}\r\n\r\n`;

  // Build multipart body as bytes to handle binary content correctly
  const bodyBytes = Utilities.newBlob(body).getBytes();
  const fileBytes = blob.getBytes();
  const closingBytes = Utilities.newBlob(`\r\n--${boundary}--`).getBytes();
  const fullBody = [...bodyBytes, ...fileBytes, ...closingBytes];

  const response = withRetry(() =>
    UrlFetchApp.fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart`, {
      method: "post",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      payload: Utilities.newBlob(fullBody).getBytes() as unknown as string,
      muteHttpExceptions: true,
    })
  );

  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`Drive upload failed (${status}): ${response.getContentText()}`);
  }
  return (JSON.parse(response.getContentText()) as DriveFile).name;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Saves a blob to the appropriate YYYY/YYYY-MM folder under rootFolderId.
 * Returns the filename as stored in Drive.
 */
const saveAttachmentToFolder = (
  blob: GoogleAppsScript.Base.Blob,
  date: Date,
  rootFolderId: string,
): { getName: () => string } => {
  const folderId = ensureInvoiceFolder(date, rootFolderId);
  const name = uploadFileToDrive(blob, folderId);
  return { getName: () => name };
};
