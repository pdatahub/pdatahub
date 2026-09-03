import { describe, it, expect } from 'vitest';
import {
  CreateSessionResponseSchema,
  ForwardMessageSchema,
  InitSessionRequestSchema,
  PingMessageSchema,
  RoleSchema,
  ServerMessageSchema,
} from '../src/messages.js';

describe('RoleSchema', () => {
  it('accepts hub and laptop', () => {
    expect(RoleSchema.parse('hub')).toBe('hub');
    expect(RoleSchema.parse('laptop')).toBe('laptop');
  });

  it('rejects other values', () => {
    expect(() => RoleSchema.parse('alien')).toThrow();
  });
});

describe('ForwardMessageSchema', () => {
  it('accepts any payload', () => {
    const msg = { type: 'forward', payload: { hello: 'world', n: 42 } };
    expect(ForwardMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing type', () => {
    expect(() => ForwardMessageSchema.parse({ payload: {} })).toThrow();
  });
});

describe('PingMessageSchema', () => {
  it('accepts ping', () => {
    expect(PingMessageSchema.parse({ type: 'ping' })).toEqual({ type: 'ping' });
  });
});

describe('ServerMessageSchema', () => {
  it('accepts registered', () => {
    const msg = { type: 'registered', sessionId: 'abc', role: 'hub' };
    expect(ServerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts error', () => {
    const msg = { type: 'error', reason: 'bad token' };
    expect(ServerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts pong', () => {
    expect(ServerMessageSchema.parse({ type: 'pong' })).toEqual({ type: 'pong' });
  });
});

describe('CreateSessionResponseSchema', () => {
  it('accepts a valid response', () => {
    const r = {
      sessionId: '00000000-0000-0000-0000-000000000000',
      hubToken: 'a'.repeat(32),
      laptopToken: 'b'.repeat(32),
    };
    expect(CreateSessionResponseSchema.parse(r)).toEqual(r);
  });

  it('rejects short tokens', () => {
    expect(() =>
      CreateSessionResponseSchema.parse({
        sessionId: '00000000-0000-0000-0000-000000000000',
        hubToken: 'short',
        laptopToken: 'b'.repeat(32),
      }),
    ).toThrow();
  });
});

describe('InitSessionRequestSchema', () => {
  it('accepts valid request', () => {
    const r = { hubToken: 'a'.repeat(32), laptopToken: 'b'.repeat(32) };
    expect(InitSessionRequestSchema.parse(r)).toEqual(r);
  });
});
