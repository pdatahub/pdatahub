import { describe, it, expect } from 'vitest';
import { parseArgs, loadConfig, ConfigError } from '../src/config.js';

describe('parseArgs', () => {
  it('extracts --hub-url', () => {
    expect(parseArgs(['--hub-url', 'http://hub:8080']).hubUrl).toBe('http://hub:8080');
  });

  it('extracts --token', () => {
    expect(parseArgs(['--token', 'xyz']).sessionToken).toBe('xyz');
  });

  it('extracts --log-level', () => {
    expect(parseArgs(['--log-level', 'debug']).logLevel).toBe('debug');
  });

  it('returns empty object for no args', () => {
    expect(parseArgs([])).toEqual({});
  });

  it('handles -h flag (prints help and exits)', () => {
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = () => true;
    try {
      expect(() => parseArgs(['-h'])).toThrow();
    } finally {
      (process.stderr.write as unknown) = orig;
    }
  });
});

describe('loadConfig', () => {
  it('loads from CLI args', () => {
    const cfg = loadConfig(['--hub-url', 'http://h:1', '--token', 't']);
    expect(cfg.hubUrl).toBe('http://h:1');
    expect(cfg.sessionToken).toBe('t');
    expect(cfg.logLevel).toBe('info');
  });

  it('CLI overrides env', () => {
    process.env.PDAHUB_HUB_URL = 'http://env:1';
    process.env.PDAHUB_SESSION_TOKEN = 'envtok';
    try {
      const cfg = loadConfig(['--hub-url', 'http://cli:2', '--token', 'clitok']);
      expect(cfg.hubUrl).toBe('http://cli:2');
      expect(cfg.sessionToken).toBe('clitok');
    } finally {
      delete process.env.PDAHUB_HUB_URL;
      delete process.env.PDAHUB_SESSION_TOKEN;
    }
  });

  it('falls back to env vars', () => {
    process.env.PDAHUB_HUB_URL = 'http://env-hub';
    process.env.PDAHUB_SESSION_TOKEN = 'env-tok';
    try {
      const cfg = loadConfig([]);
      expect(cfg.hubUrl).toBe('http://env-hub');
      expect(cfg.sessionToken).toBe('env-tok');
    } finally {
      delete process.env.PDAHUB_HUB_URL;
      delete process.env.PDAHUB_SESSION_TOKEN;
    }
  });

  it('throws ConfigError if hub URL missing', () => {
    expect(() => loadConfig([])).toThrow(ConfigError);
  });

  it('throws ConfigError if token missing', () => {
    expect(() => loadConfig(['--hub-url', 'http://x'])).toThrow(ConfigError);
  });
});
