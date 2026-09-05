/**
 * Logger for Hub core.
 *
 * stderr-only (stdout is reserved for JSON-RPC if subprocess).
 * Levels: debug, info, warn, error.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function envLevel(): LogLevel {
  const raw = (process.env.HUB_LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

const ACTIVE_LEVEL = envLevel();

function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[ACTIVE_LEVEL]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  debug(msg: string, meta?: Record<string, unknown>): void {
    emit('debug', msg, meta);
  },
  info(msg: string, meta?: Record<string, unknown>): void {
    emit('info', msg, meta);
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    emit('warn', msg, meta);
  },
  error(msg: string, meta?: Record<string, unknown>): void {
    emit('error', msg, meta);
  },
};
