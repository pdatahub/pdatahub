/**
 * Typed error hierarchy for pdatahub plugins (v2).
 *
 * Each error class carries:
 *   - `code`: stable machine-readable string the Hub uses to route to the
 *     right recovery flow (re-OAuth for AUTH_EXPIRED, 400 for
 *     VALIDATION_FAILED, retry for NETWORK_ERROR, etc.).
 *   - `retryable`: hint to the Hub's retry layer. Non-retryable errors should
 *     surface immediately to the caller.
 *   - `details`: structured payload preserved through JSON-RPC.
 *   - `toJSON()`: serializable shape for transport.
 *
 * Backward compat: v1 plugins that throw plain `Error` are unaffected —
 * these classes only matter when explicitly imported and thrown.
 */

/**
 * Serializable shape of a PluginError, suitable for inclusion in
 * JSON-RPC error.data so the Hub can reconstruct the original class.
 */
export interface PluginErrorPayload {
  name: string;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  stack?: string;
}

/**
 * Base class for all pdatahub plugin errors.
 *
 * Subclasses set `code` and `retryable` via super() and may add their own
 * public readonly fields (e.g. `field` on ValidationError) for ergonomics.
 */
export class PluginError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    // Use the subclass name (e.g., "AuthExpiredError") instead of "Error".
    this.name = this.constructor.name;
  }

  /**
   * Serialize for transport over JSON-RPC `error.data`.
   *
   * The stack is included so the Hub can show it in PDHUB_DEBUG mode; in
   * production the Hub typically strips it before showing to the user.
   */
  toJSON(): PluginErrorPayload {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
      stack: this.stack,
    };
  }
}

/**
 * Generic authentication failure (401/403).
 *
 * Not retryable: the Hub must surface the failure to the user so they can
 * re-authorize or revoke access. Compare to {@link AuthExpiredError} which
 * is retryable after a silent refresh.
 */
export class AuthError extends PluginError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('AUTH_FAILED', message, false, details);
  }
}

/**
 * Access token expired and needs refresh / re-auth.
 *
 * Retryable: if the plugin transparently refreshes the token, the same
 * call can be retried. If not, the Hub will surface "please re-authorize".
 *
 * `expiresAt` is informational — the Hub uses it to decide whether a
 * background refresh should be triggered vs. an immediate user prompt.
 */
export class AuthExpiredError extends PluginError {
  public readonly expiresAt: Date | undefined;

  constructor(expiresAt?: Date) {
    super('AUTH_EXPIRED', 'Authentication expired', true, {
      expiresAt: expiresAt?.toISOString(),
    });
    this.expiresAt = expiresAt;
  }
}

/**
 * The OAuth grant did not include a scope the operation needs.
 *
 * The Hub uses `requiredScope` vs. `grantedScopes` to deny the call
 * (and surface an audit-log entry for the scope violation).
 */
export class ScopeError extends PluginError {
  constructor(
    public readonly requiredScope: string,
    public readonly grantedScopes: string[],
  ) {
    super(
      'SCOPE_MISSING',
      `Operation requires scope "${requiredScope}" but only granted: ${grantedScopes.join(', ')}`,
      false,
      { requiredScope, grantedScopes },
    );
  }
}

/**
 * Network-level failure (DNS, TCP reset, TLS handshake).
 *
 * Retryable. The original error is preserved via `cause` and a `causeName`
 * summary in `details` so the Hub can log it without losing structured
 * information across JSON-RPC boundaries.
 */
export class NetworkError extends PluginError {
  public readonly cause: Error | undefined;

  constructor(message: string, cause?: Error) {
    super('NETWORK_ERROR', message, true, { causeName: cause?.name });
    this.cause = cause;
  }
}

/**
 * Input failed JSON Schema validation.
 *
 * The Hub returns a 400 to the MCP client with the `field` + `constraint`
 * info so the AI agent can correct its request. Not retryable — the same
 * input will keep failing.
 */
export class ValidationError extends PluginError {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly constraint: string,
  ) {
    super(
      'VALIDATION_FAILED',
      `Field "${field}" failed validation: ${constraint}`,
      false,
      { field, value, constraint },
    );
  }
}

/**
 * Operation timed out.
 *
 * Retryable. `operation` is the human-readable name (e.g., "listMessages"),
 * `timeoutMs` is what was configured.
 */
export class TimeoutError extends PluginError {
  constructor(
    public readonly timeoutMs: number,
    public readonly operation: string,
  ) {
    super(
      'TIMEOUT',
      `Operation "${operation}" timed out after ${timeoutMs}ms`,
      true,
      { timeoutMs, operation },
    );
  }
}

/**
 * A referenced resource does not exist (404 from upstream, missing local
 * file, etc.). Not retryable.
 */
export class NotFoundError extends PluginError {
  constructor(
    public readonly resourceType: string,
    public readonly resourceId: string,
  ) {
    super(
      'NOT_FOUND',
      `${resourceType} "${resourceId}" not found`,
      false,
      { resourceType, resourceId },
    );
  }
}

/**
 * Rate limit hit on an upstream service (HTTP 429).
 *
 * Retryable. `retryAfterMs` is informational — when present, the Hub
 * schedules a backoff retry; otherwise it falls back to exponential
 * backoff. Distinct from `PluginError('RATE_LIMITED', ...)` so the Hub can
 * inspect `retryAfterMs` without parsing details.
 */
export class RateLimitError extends PluginError {
  public readonly retryAfterMs: number | undefined;

  constructor(retryAfterMs?: number) {
    super(
      'RATE_LIMITED',
      retryAfterMs !== undefined
        ? `Rate limited; retry after ${retryAfterMs}ms`
        : 'Rate limited',
      true,
      { retryAfterMs },
    );
    this.retryAfterMs = retryAfterMs;
  }
}