/**
 * Tests for the delegation data model (Phase 2a Federation v2).
 *
 * Covers:
 *   1. CanonicalJson — RFC 8785 rules (sorted keys, no whitespace, arrays,
 *      numbers, strings, booleans, null, undefined rejection, NaN/Infinity
 *      rejection).
 *   2. Sign/verify round-trip with a generated HubIdentity.
 *   3. Tampering detection — flip each field, expect `{ok:false, reason}`.
 *   4. RFC 8032 §7.1 vector 1 — proves the underlying Ed25519 wiring still
 *      matches the canonical vector (Phase 1 test continues to pass).
 *   5. DelegationStore CRUD on both `delegations` and `peer_delegations`
 *      (insert, get, list, revoke, INSERT OR IGNORE semantics on received,
 *      findReceivedMatch tie-break by latest expires_at, expired/revoked
 *      filtering).
 *   6. isExpired, isRevoked predicates.
 *   7. getToolInputSchema fetches from the registry and THROWS when missing
 *      or when the plugin did not declare a schema (momus — silent fallback
 *      would mask Phase 4 failures).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  CanonicalJson,
  DelegationStore,
  type DelegationBlobV1,
  type DelegationBlobV1Body,
  getToolInputSchema,
  isExpired,
  isRevoked,
  parseBlob,
  serializeBlob,
  signDelegation,
  verifyDelegation,
} from '../src/federation/delegation.js';
import { HubIdentity } from '../src/federation/identity.js';
import { runMigrations } from '../src/migrations.js';
import { PluginRegistry } from '../src/plugin-process.js';
import type { ToolDescriptor } from '../src/types.js';

const MASTER_KEY = Buffer.from('a'.repeat(64), 'hex'); // 32 bytes

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function baseDelegationBody(
  identity: HubIdentity,
  subjectVerifyKey: string,
): DelegationBlobV1Body {
  return {
    version: 1,
    delegation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    issuer: {
      hub_name: identity.hubName,
      verify_key: identity.publicKeyB64(),
      fingerprint: identity.fingerprintHex(),
      magic_dns: identity.magicDns ?? 'userA.example:8080',
    },
    subject: {
      verify_key: subjectVerifyKey,
      fingerprint: '00 11 22 33 44 55 66 77',
    },
    delegation: {
      plugin: 'google-calendar',
      tool: 'listEvents',
      scope: 'calendar:read',
      input_schema: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from'],
      },
      expires_at: '2027-01-01T00:00:00Z',
    },
  };
}

/* ─── RFC 8785 Canonical JSON ───────────────────────────────────────────── */

describe('CanonicalJson', () => {
  it('canonicalizes an object with keys out of order', () => {
    expect(CanonicalJson.canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('canonicalizes a nested object (recursively sorts keys)', () => {
    expect(CanonicalJson.canonicalize({ a: { c: 3, b: 2 } })).toBe(
      '{"a":{"b":2,"c":3}}',
    );
  });

  it('canonicalizes a flat array (preserves order)', () => {
    expect(CanonicalJson.canonicalize([1, 2, 3])).toBe('[1,2,3]');
  });

  it('canonicalizes an array of objects (sorts each object but preserves array order)', () => {
    expect(CanonicalJson.canonicalize([{ b: 2, a: 1 }, { d: 4, c: 3 }])).toBe(
      '[{"a":1,"b":2},{"c":3,"d":4}]',
    );
  });

  it('serializes string values via JSON.stringify (with escaping)', () => {
    expect(CanonicalJson.canonicalize('hello')).toBe('"hello"');
    expect(CanonicalJson.canonicalize('a"b')).toBe('"a\\"b"');
    expect(CanonicalJson.canonicalize('a\\b')).toBe('"a\\\\b"');
    expect(CanonicalJson.canonicalize('a\nb')).toBe('"a\\nb"');
  });

  it('serializes null, true, false', () => {
    expect(CanonicalJson.canonicalize(null)).toBe('null');
    expect(CanonicalJson.canonicalize(true)).toBe('true');
    expect(CanonicalJson.canonicalize(false)).toBe('false');
  });

  it('serializes integers and floats per JSON.stringify rules', () => {
    expect(CanonicalJson.canonicalize(0)).toBe('0');
    expect(CanonicalJson.canonicalize(-0)).toBe('0'); // JSON.stringify of -0 is '0'
    expect(CanonicalJson.canonicalize(42)).toBe('42');
    expect(CanonicalJson.canonicalize(-7.5)).toBe('-7.5');
  });

  it('produces no whitespace', () => {
    const result = CanonicalJson.canonicalize({ a: 1, b: [1, 2, { c: 3 }] });
    expect(result).not.toMatch(/\s/);
  });

  it('rejects undefined as a top-level value', () => {
    expect(() => CanonicalJson.canonicalize(undefined)).toThrow(/undefined/);
  });

  it('rejects undefined as an object value (RFC 8785 omits it — we strict-error)', () => {
    expect(() =>
      CanonicalJson.canonicalize({ a: undefined as unknown as number }),
    ).toThrow(/undefined/);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => CanonicalJson.canonicalize(Number.NaN)).toThrow(/non-finite/);
    expect(() => CanonicalJson.canonicalize(Infinity)).toThrow(/non-finite/);
    expect(() => CanonicalJson.canonicalize(-Infinity)).toThrow(/non-finite/);
  });

  it('canonicalizes deep nesting deterministically', () => {
    const a = CanonicalJson.canonicalize({
      z: { y: { x: 1, a: 2 }, b: 3 },
      c: [3, 2, 1],
    });
    const b = CanonicalJson.canonicalize({
      c: [3, 2, 1],
      z: { b: 3, y: { a: 2, x: 1 } },
    });
    expect(a).toBe(b);
  });

  it('produces JSON.parse-able output', () => {
    const original = { b: 'two', a: [1, 2, 3], c: null, d: true };
    const canon = CanonicalJson.canonicalize(original);
    expect(JSON.parse(canon)).toEqual(original);
  });
});

/* ─── Sign / verify ────────────────────────────────────────────────────── */

describe('signDelegation / verifyDelegation', () => {
  it('round-trips a delegation blob: sign → verify returns {ok:true}', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj-pubkey');
    const sig = signDelegation(identity, body);
    const blob: DelegationBlobV1 = { ...body, signature: sig };
    expect(verifyDelegation(blob)).toEqual({ ok: true });
  });

  it('signature length is base64url of 64 bytes', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj-pubkey');
    const sig = signDelegation(identity, body);
    // base64url(64 bytes) = ceiling(64 * 4 / 3) = 86 chars, with '==' trimmed
    expect(sig.length).toBe(86);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('canonical JSON is identical regardless of original key order', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body1 = baseDelegationBody(identity, 'ed25519:subj');
    // Re-order keys at every depth.
    const issuer2 = {
      magic_dns: body1.issuer.magic_dns,
      fingerprint: body1.issuer.fingerprint,
      verify_key: body1.issuer.verify_key,
      hub_name: body1.issuer.hub_name,
    };
    const subject2 = {
      fingerprint: body1.subject.fingerprint,
      verify_key: body1.subject.verify_key,
    };
    const delegation2 = {
      expires_at: body1.delegation.expires_at,
      input_schema: body1.delegation.input_schema,
      scope: body1.delegation.scope,
      tool: body1.delegation.tool,
      plugin: body1.delegation.plugin,
    };
    const body2 = {
      delegation_id: body1.delegation_id,
      issuer: issuer2,
      subject: subject2,
      delegation: delegation2,
      version: body1.version,
    };
    expect(serializeBlob(body1)).toBe(serializeBlob(body2));

    // And signing+verify works.
    const sig = signDelegation(identity, body2);
    const blob: DelegationBlobV1 = { ...body1, signature: sig };
    expect(verifyDelegation(blob)).toEqual({ ok: true });
  });

  it('rejects blob with version !== 1', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const sig = signDelegation(identity, body);
    const blob: DelegationBlobV1 = {
      ...body,
      signature: sig,
      version: 2 as unknown as 1,
    };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/version/);
  });

  it('rejects tampered delegation.tool', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const sig = signDelegation(identity, body);
    const blob: DelegationBlobV1 = {
      ...body,
      signature: sig,
      delegation: { ...body.delegation, tool: 'deleteAllEvents' },
    };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('signature mismatch');
  });

  it('rejects tampered delegation.scope', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const sig = signDelegation(identity, body);
    const blob: DelegationBlobV1 = {
      ...body,
      signature: sig,
      delegation: { ...body.delegation, scope: 'calendar:write' },
    };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
  });

  it('rejects tampered delegation.expires_at (extended past)', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const sig = signDelegation(identity, body);
    const blob: DelegationBlobV1 = {
      ...body,
      signature: sig,
      delegation: { ...body.delegation, expires_at: '2030-01-01T00:00:00Z' },
    };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
  });

  it('rejects tampered delegation.input_schema', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const sig = signDelegation(identity, body);
    const blob: DelegationBlobV1 = {
      ...body,
      signature: sig,
      delegation: {
        ...body.delegation,
        input_schema: { type: 'object' },
      },
    };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
  });

  it('rejects tampered issuer.verify_key (substitute another identity)', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const otherIdentity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const sig = signDelegation(identity, body);
    const blob: DelegationBlobV1 = {
      ...body,
      signature: sig,
      issuer: { ...body.issuer, verify_key: otherIdentity.publicKeyB64() },
    };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('signature mismatch');
  });

  it('rejects signature signed with a different identity (wrong key)', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const otherIdentity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const sig = signDelegation(otherIdentity, body); // signed by WRONG key
    const blob: DelegationBlobV1 = { ...body, signature: sig };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('signature mismatch');
  });

  it('rejects blob with non-ed25519 issuer.verify_key prefix', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const sig = signDelegation(identity, body);
    const blob: DelegationBlobV1 = {
      ...body,
      signature: sig,
      issuer: { ...body.issuer, verify_key: 'rsa1024:abc' },
    };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/ed25519/);
  });

  it('rejects blob with corrupt base64 in issuer.verify_key', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const sig = signDelegation(identity, body);
    const blob: DelegationBlobV1 = {
      ...body,
      signature: sig,
      issuer: { ...body.issuer, verify_key: 'ed25519:!!!not-base64!!!' },
    };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/verify_key/);
  });

  it('rejects blob with corrupt base64 in signature', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const blob: DelegationBlobV1 = {
      ...body,
      signature: '!!!not-base64!!!',
    };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/signature/);
  });

  it('rejects blob with signature of wrong length', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const sig = signDelegation(identity, body);
    // Truncate by 1 char — base64url of 64 bytes is 86 chars; trim 2 base64
    // chars = ~3 raw bytes lost, but our length check fires on the byte length.
    const blob: DelegationBlobV1 = {
      ...body,
      signature: sig.slice(0, sig.length - 2),
    };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/wrong length/);
  });

  it('rejects blob with empty signature', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const blob: DelegationBlobV1 = {
      ...body,
      signature: '',
    };
    const res = verifyDelegation(blob);
    expect(res.ok).toBe(false);
  });
});

/* ─── RFC 8032 vector — proves the underlying ed25519 primitive wired into
   signDelegation is the same one Phase 1 already verified against the
   canonical test vector. Phase 1's identity.test.ts already signs an empty
   message and asserts the canonical signature; here we exercise the
   HubIdentity.sign() primitive from the same library on a NON-empty payload
   (canonical JSON of a real blob body) to confirm the wiring survives. */

describe('signDelegation — uses HubIdentity.sign primitive', () => {
  it('signs canonical JSON bytes and verifyDelegation accepts them', () => {
    const secretKey = Uint8Array.from(
      Buffer.from(
        '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
        'hex',
      ),
    );
    const expectedPubKey = Uint8Array.from(
      Buffer.from(
        'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
        'hex',
      ),
    );

    const id = new HubIdentity({
      privateKey: secretKey,
      publicKey: expectedPubKey,
      hubName: 'rfc8032',
      magicDns: null,
      fingerprint: 'AA BB CC DD EE FF 00 11',
      masterKey: MASTER_KEY,
    });

    // Sign a known payload; specific hex output is covered by Phase 1's
    // identity.test.ts RFC 8032 vector check. We only assert here that the
    // sign→verify path agrees end-to-end.
    const body: DelegationBlobV1Body = {
      version: 1,
      delegation_id: 'test',
      issuer: {
        hub_name: 'rfc8032',
        verify_key: id.publicKeyB64(),
        fingerprint: id.fingerprintHex(),
        magic_dns: 'rfc8032.example:8080',
      },
      subject: {
        verify_key: id.publicKeyB64(),
        fingerprint: id.fingerprintHex(),
      },
      delegation: {
        plugin: 'p',
        tool: 't',
        scope: 's',
        input_schema: {},
        expires_at: '2027-01-01T00:00:00Z',
      },
    };
    const sig = signDelegation(id, body);
    const blob: DelegationBlobV1 = { ...body, signature: sig };
    expect(verifyDelegation(blob)).toEqual({ ok: true });
  });
});/* ─── parseBlob / serializeBlob round-trip ─────────────────────────────── */

describe('parseBlob', () => {
  it('round-trips through base64url', () => {
    const identity = HubIdentity.generate('userA', MASTER_KEY);
    const body = baseDelegationBody(identity, 'ed25519:subj');
    const sig = signDelegation(identity, body);
    const blob: DelegationBlobV1 = { ...body, signature: sig };
    const encoded = Buffer.from(JSON.stringify(blob)).toString('base64url');
    const decoded = parseBlob(encoded);
    expect(decoded.delegation_id).toBe(blob.delegation_id);
    expect(decoded.signature).toBe(sig);
    expect(verifyDelegation(decoded)).toEqual({ ok: true });
  });
});

/* ─── Predicates ───────────────────────────────────────────────────────── */

describe('isExpired', () => {
  it('returns true for an ISO timestamp in the past', () => {
    expect(isExpired('2020-01-01T00:00:00Z', 1_700_000_000_000)).toBe(true);
  });

  it('returns false for an ISO timestamp in the future', () => {
    expect(isExpired('2030-01-01T00:00:00Z', 1_700_000_000_000)).toBe(false);
  });

  it('treats an exactly-now timestamp as expired (boundary)', () => {
    const now = 1_700_000_000_000;
    expect(isExpired(new Date(now).toISOString(), now)).toBe(true);
  });

  it('returns true for null, undefined, or empty string', () => {
    expect(isExpired(null)).toBe(true);
    expect(isExpired(undefined)).toBe(true);
    expect(isExpired('')).toBe(true);
  });

  it('returns true for malformed ISO strings (fail-closed)', () => {
    expect(isExpired('not-a-date')).toBe(true);
    expect(isExpired('2026-13-99')).toBe(true);
  });
});

describe('isRevoked', () => {
  it('returns true when revoked is 1 or true', () => {
    expect(isRevoked({ revoked: 1 })).toBe(true);
    expect(isRevoked({ revoked: true })).toBe(true);
  });

  it('returns false when revoked is 0 or false', () => {
    expect(isRevoked({ revoked: 0 })).toBe(false);
    expect(isRevoked({ revoked: false })).toBe(false);
  });

  it('returns false for null / undefined row', () => {
    expect(isRevoked(null)).toBe(false);
    expect(isRevoked(undefined)).toBe(false);
  });
});

/* ─── DelegationStore — granted side ───────────────────────────────────── */

describe('DelegationStore — granted (delegations table)', () => {
  let db: Database.Database;
  let store: DelegationStore;

  beforeEach(() => {
    db = freshDb();
    store = new DelegationStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('createGranted returns a new UUID delegation_id', () => {
    const id = store.createGranted({
      peer_verify_key: 'ed25519:peer-1',
      plugin: 'p',
      tool: 't',
      scope: 's',
      expires_at: '2027-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('getGranted round-trips the row', () => {
    const id = store.createGranted({
      peer_verify_key: 'ed25519:peer-1',
      peer_hub_name: 'userB',
      plugin: 'p',
      tool: 't',
      scope: 's',
      expires_at: '2027-01-01T00:00:00Z',
      signature: Buffer.from('abc'),
    });
    const row = store.getGranted(id);
    expect(row).not.toBeNull();
    expect(row?.delegation_id).toBe(id);
    expect(row?.peer_verify_key).toBe('ed25519:peer-1');
    expect(row?.peer_hub_name).toBe('userB');
    expect(row?.plugin).toBe('p');
    expect(row?.tool).toBe('t');
    expect(row?.scope).toBe('s');
    expect(row?.revoked).toBe(0);
    expect(Buffer.from(row!.signature).toString()).toBe('abc');
  });

  it('createGranted twice with explicit same PK — second is rejected (PK conflict path uses external PK; we auto-generate)', () => {
    // createGranted auto-generates the UUID, so a duplicate is impossible by
    // construction. We exercise the PK uniqueness directly via raw SQL.
    const id = store.createGranted({
      peer_verify_key: 'ed25519:p',
      plugin: 'p',
      tool: 't',
      scope: 's',
      expires_at: '2027-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    expect(() =>
      db
        .prepare(
          `INSERT INTO delegations (delegation_id, peer_verify_key, plugin, tool, scope,
             expires_at, created_at, signature) VALUES (?, 'ed25519:p2', 'p', 't', 's',
             '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
        )
        .run(id, Buffer.alloc(64)),
    ).toThrow(/UNIQUE|PRIMARY/);
  });

  it('listGranted returns all rows, newest first', async () => {
    const id1 = store.createGranted({
      peer_verify_key: 'ed25519:a',
      plugin: 'p1',
      tool: 't1',
      scope: 's',
      expires_at: '2027-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    // Wait 5ms to ensure created_at differs at ms resolution.
    await new Promise((r) => setTimeout(r, 5));
    const id2 = store.createGranted({
      peer_verify_key: 'ed25519:b',
      plugin: 'p2',
      tool: 't2',
      scope: 's',
      expires_at: '2027-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    const rows = store.listGranted();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.delegation_id).toBe(id2);
    expect(rows[1]?.delegation_id).toBe(id1);
  });

  it('revokeGranted flips revoked=1 and isRevoked picks it up', () => {
    const id = store.createGranted({
      peer_verify_key: 'ed25519:p',
      plugin: 'p',
      tool: 't',
      scope: 's',
      expires_at: '2027-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    expect(isRevoked(store.getGranted(id))).toBe(false);
    expect(store.revokeGranted(id)).toBe(true);
    expect(isRevoked(store.getGranted(id))).toBe(true);
  });

  it('revokeGranted on unknown id returns false', () => {
    expect(store.revokeGranted('nope')).toBe(false);
  });

  it('peer_hub_name is nullable on insert', () => {
    const id = store.createGranted({
      peer_verify_key: 'ed25519:p',
      plugin: 'p',
      tool: 't',
      scope: 's',
      expires_at: '2027-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    expect(store.getGranted(id)?.peer_hub_name).toBeNull();
  });
});

/* ─── DelegationStore — received side ───────────────────────────────────── */

describe('DelegationStore — received (peer_delegations table)', () => {
  let db: Database.Database;
  let store: DelegationStore;

  beforeEach(() => {
    db = freshDb();
    store = new DelegationStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('createReceived inserts a row and getReceived returns it', () => {
    store.createReceived({
      delegation_id: 'del-1',
      peer_verify_key: 'ed25519:peer',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA.tail123.ts.net:8080',
      plugin: 'p',
      tool: 't',
      scope: 's',
      input_schema: '{"type":"object"}',
      expires_at: '2027-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    const row = store.getReceived('del-1');
    expect(row?.peer_hub_name).toBe('userA');
    expect(row?.peer_hub_url).toBe('http://userA.tail123.ts.net:8080');
    expect(row?.input_schema).toBe('{"type":"object"}');
  });

  it('createReceived with the same delegation_id is idempotent (INSERT OR IGNORE)', () => {
    store.createReceived({
      delegation_id: 'del-1',
      peer_verify_key: 'ed25519:peer',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 't',
      scope: 's',
      input_schema: '{}',
      expires_at: '2027-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    // Re-import — first row stays.
    store.createReceived({
      delegation_id: 'del-1',
      peer_verify_key: 'ed25519:DUMMY',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 't',
      scope: 'DIFFERENT_SCOPE',
      input_schema: '{}',
      expires_at: '2028-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    const row = store.getReceived('del-1');
    expect(row?.scope).toBe('s'); // first import "wins"
    expect(row?.peer_verify_key).toBe('ed25519:peer');
  });

  it('findReceivedMatch excludes revoked but includes expired (handleFederationInvoke distinguishes 404 vs 403)', () => {
    store.createReceived({
      delegation_id: 'd-active-1',
      peer_verify_key: 'ed25519:peer',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 'listEvents',
      scope: 's',
      input_schema: '{}',
      expires_at: '2030-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    // Expired one — past expires_at. Included so caller can return 403 DELEGATION_EXPIRED.
    store.createReceived({
      delegation_id: 'd-expired',
      peer_verify_key: 'ed25519:peer',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 'listEvents',
      scope: 's',
      input_schema: '{}',
      expires_at: '2000-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    // Revoked one — future. Excluded (B's local view: no longer trusted).
    store.createReceived({
      delegation_id: 'd-revoked',
      peer_verify_key: 'ed25519:peer',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 'listEvents',
      scope: 's',
      input_schema: '{}',
      expires_at: '2030-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    store.revokeReceived('d-revoked');

    const matches = store.findReceivedMatch('userA', 'listEvents');
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.delegation_id).sort()).toEqual(['d-active-1', 'd-expired']);
  });

  it('findReceivedMatch sorts by latest expires_at first (Momus Q4)', () => {
    store.createReceived({
      delegation_id: 'd-soon',
      peer_verify_key: 'ed25519:peer',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 'listEvents',
      scope: 's',
      input_schema: '{}',
      expires_at: '2027-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    store.createReceived({
      delegation_id: 'd-later',
      peer_verify_key: 'ed25519:peer',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 'listEvents',
      scope: 's',
      input_schema: '{}',
      expires_at: '2030-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    const matches = store.findReceivedMatch('userA', 'listEvents');
    expect(matches).toHaveLength(2);
    expect(matches[0]?.delegation_id).toBe('d-later');
    expect(matches[1]?.delegation_id).toBe('d-soon');
  });

  it('findReceivedMatch filters by (peer_hub_name, tool) — wrong tool excluded', () => {
    store.createReceived({
      delegation_id: 'd-1',
      peer_verify_key: 'ed25519:peer',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 'listEvents',
      scope: 's',
      input_schema: '{}',
      expires_at: '2030-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    store.createReceived({
      delegation_id: 'd-2',
      peer_verify_key: 'ed25519:peer',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 'deleteAll',
      scope: 's',
      input_schema: '{}',
      expires_at: '2030-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    const matches = store.findReceivedMatch('userA', 'listEvents');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.delegation_id).toBe('d-1');
  });

  it('findReceivedMatch filters by peer_hub_name', () => {
    store.createReceived({
      delegation_id: 'd-A',
      peer_verify_key: 'ed25519:peer-a',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 'listEvents',
      scope: 's',
      input_schema: '{}',
      expires_at: '2030-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    store.createReceived({
      delegation_id: 'd-B',
      peer_verify_key: 'ed25519:peer-b',
      peer_hub_name: 'userB',
      peer_hub_url: 'http://userB:8080',
      plugin: 'p',
      tool: 'listEvents',
      scope: 's',
      input_schema: '{}',
      expires_at: '2030-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    expect(store.findReceivedMatch('userA', 'listEvents')).toHaveLength(1);
    expect(store.findReceivedMatch('userB', 'listEvents')).toHaveLength(1);
    expect(store.findReceivedMatch('userC', 'listEvents')).toHaveLength(0);
  });

  it('listReceived returns all rows, newest first', () => {
    store.createReceived({
      delegation_id: 'd-1',
      peer_verify_key: 'ed25519:peer',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 't',
      scope: 's',
      input_schema: null,
      expires_at: '2030-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    store.createReceived({
      delegation_id: 'd-2',
      peer_verify_key: 'ed25519:peer',
      peer_hub_name: 'userA',
      peer_hub_url: 'http://userA:8080',
      plugin: 'p',
      tool: 't',
      scope: 's',
      input_schema: null,
      expires_at: '2030-01-01T00:00:00Z',
      signature: Buffer.alloc(64),
    });
    expect(store.listReceived()).toHaveLength(2);
  });
});

/* ─── getToolInputSchema ───────────────────────────────────────────────── */

class StubRegistry extends PluginRegistry {
  constructor(private readonly fakePluginInfos: Array<{
    name: string;
    tools: ToolDescriptor[];
  }>) {
    super();
  }
  // Override listPlugins to inject fakes — avoids spawning a real subprocess.
  override listPlugins(): Array<ReturnType<PluginRegistry['listPlugins']>[number]> {
    return this.fakePluginInfos.map((p) => ({
      name: p.name,
      version: '0.0.0',
      description: '',
      entry_path: '',
      pid: 0,
      tools: p.tools,
      started_at: '',
      last_heartbeat: '',
    }));
  }
}

describe('getToolInputSchema', () => {
  it('returns the declared schema for a known (plugin, tool)', () => {
    const registry = new StubRegistry([
      {
        name: 'google-calendar',
        tools: [
          {
            name: 'listEvents',
            description: 'desc',
            inputSchema: { type: 'object', properties: { from: { type: 'string' } } },
            scope: 'calendar:read',
            plugin: 'google-calendar',
          },
        ],
      },
    ]);
    expect(getToolInputSchema(registry, 'google-calendar', 'listEvents')).toEqual({
      type: 'object',
      properties: { from: { type: 'string' } },
    });
  });

  it('throws when the plugin is not found', () => {
    const registry = new StubRegistry([]);
    expect(() => getToolInputSchema(registry, 'unknown', 'x')).toThrow(
      /not found in registry/,
    );
  });

  it('throws when the tool is not found on a known plugin', () => {
    const registry = new StubRegistry([
      {
        name: 'google-calendar',
        tools: [
          {
            name: 'listEvents',
            description: 'd',
            inputSchema: {},
            scope: 's',
            plugin: 'google-calendar',
          },
        ],
      },
    ]);
    expect(() => getToolInputSchema(registry, 'google-calendar', 'unknown')).toThrow(
      /not found in plugin/,
    );
  });

  it('throws when the plugin did NOT declare an inputSchema (null)', () => {
    const registry = new StubRegistry([
      {
        name: 'no-schema',
        tools: [
          {
            name: 'open',
            description: 'd',
            inputSchema: null, // <-- explicit "not declared"
            scope: 's',
            plugin: 'no-schema',
          },
        ],
      },
    ]);
    expect(() => getToolInputSchema(registry, 'no-schema', 'open')).toThrow(
      /did not declare inputSchema/,
    );
  });

  it('accepts an empty schema object {} as a valid declaration', () => {
    const registry = new StubRegistry([
      {
        name: 'p',
        tools: [
          {
            name: 't',
            description: 'd',
            inputSchema: {},
            scope: 's',
            plugin: 'p',
          },
        ],
      },
    ]);
    expect(getToolInputSchema(registry, 'p', 't')).toEqual({});
  });
});
