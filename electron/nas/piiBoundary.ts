const LOG_FIELD_ALLOWLIST = new Set(["operation", "recordId", "status", "attempt"]);
const SAFE_ERROR_CODES = new Set([
  "NAS_NETWORK_ERROR",
  "NAS_CREDENTIAL_INVALID",
  "NAS_CREDENTIAL_MISSING",
  "NAS_CREDENTIAL_DECRYPT_FAILED",
  "NAS_CREDENTIAL_ENCRYPT_FAILED",
  "NAS_RECORD_ACK_INVALID",
  "NAS_RECORDS_SNAPSHOT_INVALID",
  "NAS_RESPONSE_CONTENT_TYPE_INVALID",
  "NAS_RESPONSE_JSON_INVALID",
  "SAFE_STORAGE_UNAVAILABLE",
]);

export type PiiSafeError = { message: string; code?: string; status?: number };

export function piiSafeError(error: unknown): PiiSafeError {
  if (isObject(error)) {
    const candidate = typeof error.code === "string" ? error.code : undefined;
    const code = candidate != null && (SAFE_ERROR_CODES.has(candidate) || /^HTTP_(?:4\d\d|5\d\d)$/.test(candidate)) ? candidate : undefined;
    const status = typeof error.status === "number" && Number.isInteger(error.status) ? error.status : undefined;
    return { message: code ?? "NAS_OPERATION_FAILED", ...(code == null ? {} : { code }), ...(status == null ? {} : { status }) };
  }
  return { message: "NAS_OPERATION_FAILED" };
}

export function piiSafeLogFields(fields: Record<string, unknown>): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (LOG_FIELD_ALLOWLIST.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) safe[key] = value;
  }
  return safe;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
