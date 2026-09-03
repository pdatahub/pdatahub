/**
 * Load Hub config from CLI args + environment variables.
 *
 * Priority: CLI args > env vars > built-in defaults.
 *
 * Env vars:
 *   PDAHUB_HUB_URL       — Hub base URL
 *   PDAHUB_SESSION_TOKEN — Session token (Bearer)
 *   PDAHUB_LOG_LEVEL     — debug|info|warn|error
 *
 * CLI args:
 *   --hub-url <url>
 *   --token <token>
 *   --log-level <level>
 */

import type { HubConfig } from './types.js';
import { setLogLevel } from './logger.js';

export interface Config extends HubConfig {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function parseArgs(argv: string[]): Partial<Config> {
  const out: Partial<Config> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--hub-url':
        out.hubUrl = argv[++i];
        break;
      case '--token':
        out.sessionToken = argv[++i];
        break;
      case '--log-level':
        out.logLevel = argv[++i] as Config['logLevel'];
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
    }
  }
  return out;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const cli = parseArgs(argv);
  const config: Config = {
    hubUrl: cli.hubUrl ?? process.env.PDAHUB_HUB_URL ?? '',
    sessionToken: cli.sessionToken ?? process.env.PDAHUB_SESSION_TOKEN ?? '',
    logLevel: (cli.logLevel ?? process.env.PDAHUB_LOG_LEVEL ?? 'info') as Config['logLevel'],
  };
  if (!config.hubUrl) {
    throw new ConfigError('--hub-url or PDAHUB_HUB_URL is required');
  }
  if (!config.sessionToken) {
    throw new ConfigError('--token or PDAHUB_SESSION_TOKEN is required');
  }
  setLogLevel(config.logLevel);
  return config;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function printHelp(): void {
  const help = `
pdatahub-mcp — MCP server bridging AI agents to pdatahub Hub

Usage:
  pdatahub-mcp --hub-url <url> --token <token>
  pdatahub-mcp --hub-url <url> --token <token> --log-level debug

Options:
  --hub-url <url>      Hub base URL (or env PDAHUB_HUB_URL)
  --token <token>      Session token (or env PDAHUB_SESSION_TOKEN)
  --log-level <level>  debug|info|warn|error (default: info)
  -h, --help           Show this help

Examples:
  pdatahub-mcp --hub-url http://192.168.1.10:8080 --token abc123
  PDAHUB_HUB_URL=https://relay.example.com PDAHUB_SESSION_TOKEN=xyz pdatahub-mcp
`;
  process.stderr.write(help);
}
