/**
 * Stderr-only logger for pdatahub MCP server.
 *
 * stdout is reserved for the MCP protocol — logging there corrupts the stream.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function format(level: LogLevel, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
  return `${ts} [${level.toUpperCase()}] ${msg}${metaStr}`;
}

function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;
  const line = format(level, msg, meta) + '\n';
  process.stderr.write(line);
}

export const logger = {
  debug(msg: string, meta?: Record<string, unknown>): void {
    log('debug', msg, meta);
  },
  info(msg: string, meta?: Record<string, unknown>): void {
    log('info', msg, meta);
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    log('warn', msg, meta);
  },
  error(msg: string, meta?: Record<string, unknown>): void {
    log('error', msg, meta);
  },
};
