/**
 * Centralized error → HTTP response mapper for hub-core.
 *
 * Goal: NEVER leak server internals to clients.
 *
 * Categories of leaks this guards against (P0):
 *   - Stack traces (`err.stack`)
 *   - Filesystem paths (e.g. `/home/user/.pdatahub/...`)
 *   - SQL fragments (e.g. `SQLITE_CONSTRAINT: UNIQUE constraint failed: tokens.plugin`)
 *   - Library versions (e.g. `at Object.<anonymous> (better-sqlite3@9.4.0:...:)`)
 *   - Internal ports / IPs (e.g. `127.0.0.1:8081`)
 *   - Plugin source paths
 *   - Master key fingerprints (hex prefixes that could narrow brute-force)
 *
 * Strategy:
 *   - Whitelist: only known error types (PluginError with documented codes,
 *     HubError, custom HttpError) carry structured info to the client.
 *   - Unknown / 5xx errors → response shape is `{error: 'internal_error',
 *     code: 'INTERNAL_ERROR', request_id}`. The full error is logged
 *     server-side with the same request_id for forensics.
 *   - PluginError.code → HTTP status mapped in `mapErrorToHttpStatus`
 *     (already exists in server.ts).
 *
 * Audit history:
 *   - Pre-sanitize: line 478 of server.ts returned `\`internal error: ${err.message}\``
 *     which leaked SQLite error strings, stack frames, and plugin source paths.
 *   - Post-sanitize: response is opaque + request_id; server log retains the
 *     full error context keyed by request_id.
 */

/**
 * Known error categories that are SAFE to expose. Each maps to a stable
 * error code + status + safe message. Adding to this list requires a
 * security review — error messages here ARE user-visible.
 */
export type SafeError =
  | { kind: 'auth'; code: 'INVALID_TOKEN' | 'TOKEN_EXPIRED'; status: 401; message: string }
  | { kind: 'authz'; code: 'FORBIDDEN'; status: 403; message: string }
  | { kind: 'not_found'; code: 'NOT_FOUND'; status: 404; message: string }
  | { kind: 'validation'; code: 'VALIDATION_FAILED' | 'INVALID_INPUT'; status: 400; message: string }
  | { kind: 'conflict'; code: 'ALREADY_EXISTS' | 'STATE_CONFLICT'; status: 409; message: string }
  | { kind: 'rate_limit'; code: 'RATE_LIMITED'; status: 429; message: string; retryAfterMs?: number }
  | { kind: 'upstream'; code: 'UPSTREAM_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR'; status: 502; message: string }
  | { kind: 'identity'; code: 'IDENTITY_NOT_INITIALIZED' | 'IDENTITY_LOAD_FAILED'; status: 503; message: string };

/** A pre-sanitized response. Always include the opaque request_id. */
export interface SanitizedErrorResponse {
  error: string;
  code: string;
  request_id: string;
  /** Optional Retry-After in seconds (only for rate_limit). */
  retry_after_seconds?: number;
}

const SAFE_MESSAGE_MAX_LEN = 200;

/**
 * Validate that a string is safe to send to the client — strip control
 * chars, paths, IPs, and other internal-looking tokens.
 *
 * This is a belt-and-braces guard for the `message` field of SafeError
 * entries (and the auto-applied defense in `sendError`). It is NOT a
 * substitute for proper error typing — known-error paths should
 * construct SafeError directly.
 *
 * Strategy: replace each LEAK_PATTERN match with `<redacted>`. Then
 * strip control chars and truncate.
 */
export function safeClientMessage(input: string): string {
  let s = input;
  // Redact leak patterns (filesystem paths, stack frames, SQL fragments,
  // node_modules references, internal IPs+ports, semver, long hex blobs).
  for (const { re } of LEAK_PATTERNS) {
    s = s.replace(re, '<redacted>');
  }
  // Strip control chars + newlines + tabs (prevent header injection / log forgery).
  s = s.replace(/[\x00-\x1f\x7f]/g, '');
  // Truncate.
  if (s.length > SAFE_MESSAGE_MAX_LEN) s = s.slice(0, SAFE_MESSAGE_MAX_LEN) + '...';
  return s;
}

/** Default 500 response — opaque to client, log full context server-side. */
export function internalErrorResponse(requestId: string): SanitizedErrorResponse {
  return {
    error: 'internal_error',
    code: 'INTERNAL_ERROR',
    request_id: requestId,
  };
}

/** Construct a sanitized response from a SafeError + requestId. */
export function safeErrorResponse(safe: SafeError, requestId: string): SanitizedErrorResponse {
  const out: SanitizedErrorResponse = {
    error: safe.message,
    code: safe.code,
    request_id: requestId,
  };
  if (safe.kind === 'rate_limit' && safe.retryAfterMs !== undefined) {
    out.retry_after_seconds = Math.ceil(safe.retryAfterMs / 1000);
  }
  return out;
}

/**
 * Generate a short opaque request_id for correlating client-visible errors
 * with server-side logs. Format: 8-char base36 of (timestamp xor random).
 *
 * NOT a UUID — just enough entropy for log lookup without leaking timing
 * or per-request counter state.
 */
export function generateRequestId(): string {
  const t = Date.now();
  const r = Math.floor(Math.random() * 0xffffffff);
  return ((t ^ r) >>> 0).toString(36).padStart(8, '0');
}

/**
 * Convert an Error → sanitized HTTP response. Logs the full error
 * server-side with the request_id for forensics.
 *
 * Call this from the catch-all in handleRequest. Pre-sanitized errors
 * (e.g. from inside a handler that already produced a SafeError via
 * `toSafeError`) are returned as-is.
 */
export function sanitizeUnknownError(
  err: unknown,
  requestId: string,
  logFn: (msg: string, ctx: Record<string, unknown>) => void,
): SanitizedErrorResponse {
  // If the error is already an HttpError-like object with `safe` set, use it.
  if (err && typeof err === 'object' && 'safe' in err && (err as { safe: unknown }).safe) {
    return safeErrorResponse((err as { safe: SafeError }).safe, requestId);
  }
  // Otherwise log full context server-side, return opaque.
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logFn('request handler error (sanitized to client)', {
    request_id: requestId,
    error_message: message,
    error_stack: stack,
    error_type: err instanceof Error ? err.constructor.name : typeof err,
  });
  return internalErrorResponse(requestId);
}

/**
 * Detect if a thrown value carries any "leaky" content — used by tests
 * to verify that what shows up in a response is sanitized.
 *
 * Returns the list of patterns detected; empty array means safe.
 */
export const LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Order matters: node_modules BEFORE filesystem_path so we don't
  // destroy the `node_modules/...` match with a partial `/foo/...` redaction.
  { name: 'node_modules_path', re: /node_modules\/(?:@?[\w./-]+\/?)*/ },
  { name: 'filesystem_path', re: /(?:\/[\w.-]+){2,}/ },
  { name: 'stack_trace_marker', re: /\bat \w+ \(/ },
  { name: 'sqlite_error', re: /SQLITE_(?:CONSTRAINT|ERROR|BUSY|LOCKED|RANGE)/i },
  { name: 'ip_with_port', re: /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/ },
  { name: 'semver_version', re: /@\d+\.\d+\.\d+/ },
  // Master-key fingerprints are full 32-byte hex (64 chars). Requiring the
  // exact length avoids false positives on user-input strings (e.g. an
  // all-'a' string is hex but not a master key).
  { name: 'master_key_hex', re: /\b[0-9a-f]{64}\b/i },
];

export function detectLeaks(text: string): string[] {
  const found: string[] = [];
  for (const { name, re } of LEAK_PATTERNS) {
    if (re.test(text)) found.push(name);
  }
  return found;
}
