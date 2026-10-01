// Never pass raw errors, request bodies, URLs, user identifiers, or session data
// to console. Even an upstream error.message/details can contain credentials.
export type AuthDiagnosticContext = {
  source: "login" | "logout" | "middleware" | "guard";
  attemptId: string;
};

export type AuthStep = "configuration" | "client.create" | "cookies.write" |
  "signInWithPassword" | "getUser" | "getClaims" | "pos_profiles.select" | "signOut" | "login.request" | "login.result";

const knownCodes = new Set([
  "invalid_credentials", "email_not_confirmed", "user_banned", "user_not_found",
  "email_provider_disabled", "signup_disabled", "unexpected_failure",
  "over_request_rate_limit", "over_email_send_rate_limit", "request_timeout",
  "bad_jwt", "session_not_found", "refresh_token_not_found", "refresh_token_already_used",
  "invalid_api_key", "captcha_failed", "validation_failed",
  "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "CERT_HAS_EXPIRED",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function safeCode(value: unknown) {
  return typeof value === "string" &&
    (knownCodes.has(value) || /^[0-9A-Z]{5}$/.test(value) || /^PGRST\d{3}$/.test(value))
    ? value : undefined;
}

export function safeAuthError(error: unknown, responseStatus?: number) {
  const value = record(error);
  const message = typeof value.message === "string" ? value.message : "";
  const status = responseStatus ?? value.status;
  const names = ["Error", "TypeError", "AbortError", "TimeoutError", "AuthApiError",
    "AuthRetryableFetchError", "AuthSessionMissingError", "AuthUnknownError"];
  // Classify known messages without ever emitting the original string.
  const category = /invalid api key/i.test(message) ? "invalid_api_key" :
    /fetch failed|failed to fetch|network/i.test(message) ? "network_failure" :
    /timeout|timed out/i.test(message) ? "timeout" :
    /supabaseurl|invalid url/i.test(message) ? "invalid_url" :
    /cookies can only be modified/i.test(message) ? "cookie_write_not_allowed" :
    "upstream_error";
  return {
    category,
    name: names.includes(String(value.name)) ? value.name : undefined,
    code: safeCode(value.code),
    causeCode: safeCode(record(value.cause).code),
    status: typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 599 ? status : undefined,
  };
}

export function authDiagnostic(
  context: AuthDiagnosticContext,
  step: AuthStep,
  outcome: "started" | "success" | "failed" | "denied" | "inactive" | "unauthenticated",
  error?: unknown,
  responseStatus?: number,
) {
  const entry = { ...context, step, outcome,
    ...(error !== undefined ? { error: safeAuthError(error, responseStatus) } : {}) };
  const line = `[nexo-pos-auth] ${JSON.stringify(entry)}`;
  if (outcome === "failed") console.error(line);
  else console.info(line);
}
