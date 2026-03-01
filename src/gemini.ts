// gemini.ts — PDF classification via Gemini 2.5 Flash

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DocumentType = "invoice" | "receipt" | "unknown";

type Classification = {
  type: DocumentType;
  /** ISO date string YYYY-MM-DD extracted from the document, or null if not found. */
  documentDate: string | null;
  /** Raw confidence note from the model, useful for debugging. */
  note: string;
};

/** Shape of the JSON we instruct Gemini to return. */
type GeminiClassificationPayload = {
  type: DocumentType;
  documentDate: string | null;
  note: string;
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * System-style instruction embedded in the user turn.
 * Gemini Flash doesn't support a separate system role via REST, so we prepend it.
 */
const CLASSIFICATION_PROMPT = `
You are a document classifier for accounting automation.
Analyze the attached PDF and respond ONLY with a valid JSON object — no markdown, no explanation.

Return this exact shape:
{
  "type": "invoice" | "receipt" | "unknown",
  "documentDate": "YYYY-MM-DD" | null,
  "note": "<one sentence explanation>"
}

Rules:
- "invoice" = a formal billing document requesting payment (has invoice number, payment terms, or "Facture"/"Rechnung"/"Factuur").
- "receipt" = proof of a completed payment (till receipt, credit card slip, expense receipt).
- "unknown" = cannot determine.
- "documentDate" = the invoice/receipt date (NOT due date, NOT today). Return null if absent or ambiguous.
- The date must be in ISO format YYYY-MM-DD.
`.trim();

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

const buildRequestPayload = (pdfBase64: string) => ({
  contents: [
    {
      parts: [
        { text: CLASSIFICATION_PROMPT },
        {
          inline_data: {
            mime_type: "application/pdf",
            data: pdfBase64,
          },
        },
      ],
    },
  ],
  generationConfig: {
    temperature: 0,
    maxOutputTokens: 1024,
    responseMimeType: "application/json",
  },
});

type GeminiPart = { text?: string; thought?: boolean };
type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
};

const callGemini = (pdfBase64: string, apiKey: string): string => {
  const response = withRetry(() =>
    UrlFetchApp.fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(buildRequestPayload(pdfBase64)),
      muteHttpExceptions: true,
    })
  );

  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`Gemini API error ${status}: ${response.getContentText()}`);
  }

  const body = JSON.parse(response.getContentText()) as GeminiResponse;
  const parts = body?.candidates?.[0]?.content?.parts ?? [];

  // Gemini 2.5 "thinking" models may return multiple parts.
  // The actual output is the last non-thought part with text.
  const outputPart = parts.filter((p) => p.text && !p.thought).pop();
  const text = outputPart?.text;

  if (!text) throw new Error("Gemini returned empty content");
  return text.trim();
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const parseClassification = (raw: string): GeminiClassificationPayload => {
  // Strip potential markdown code fences defensively, even though we asked not to include them.
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(cleaned) as GeminiClassificationPayload;

  // Validate the date format if present.
  if (parsed.documentDate && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.documentDate)) {
    Logger.log(`Gemini returned unexpected date format: ${parsed.documentDate} — treating as null`);
    return { ...parsed, documentDate: null };
  }

  return parsed;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classifies a PDF blob using Gemini 2.5 Flash.
 * Returns document type and the extracted date (or null).
 *
 * Throws if the API call fails after retries.
 */
const classifyPdf = (blob: GoogleAppsScript.Base.Blob): Classification => {
  const apiKey = getGeminiApiKey();
  const pdfBase64 = Utilities.base64Encode(blob.getBytes());

  const raw = callGemini(pdfBase64, apiKey);
  Logger.log(`Gemini raw response for "${blob.getName()}": ${raw}`);

  const payload = parseClassification(raw);
  return {
    type: payload.type,
    documentDate: payload.documentDate,
    note: payload.note,
  };
};

/**
 * Parses a YYYY-MM-DD string into a Date object.
 * Returns null if the string is null or unparseable.
 */
const parseDateString = (dateStr: string | null): Date | null => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
};
