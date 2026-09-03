/**
 * Stderr-only logger.
 *
 * IMPORTANT: stdout is reserved for JSON-RPC protocol.
 * Never write logs to stdout from a plugin.
 *
 * Debug-level logs are suppressed unless `PDHUB_DEBUG=1` is set in the env.
 */
export class Logger {
  private readonly debugEnabled: boolean;

  constructor(private readonly prefix: string) {
    this.debugEnabled = process.env['PDHUB_DEBUG'] === '1';
  }

  info(message: string, ...args: unknown[]): void {
    this.write('INFO', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('WARN', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('ERROR', message, args);
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.debugEnabled) {
      this.write('DEBUG', message, args);
    }
  }

  private write(level: string, message: string, args: readonly unknown[]): void {
    const ts = new Date().toISOString();
    const formatted =
      args.length > 0
        ? `${message} ${args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ')}`
        : message;
    process.stderr.write(`[${ts}] [${level}] [${this.prefix}] ${formatted}\n`);
  }
}

/**
 * Best-effort JSON.stringify that never throws.
 * Circular refs and other errors fall back to String() or inspection.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  }
}