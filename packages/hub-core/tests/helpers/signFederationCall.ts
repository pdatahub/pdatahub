/**
 * Shared test helpers for federation tests.
 *
 * Currently used by `federation-adversarial.test.ts` to sign federation
 * call bodies with a chosen identity + chosen `request_id` + chosen
 * `timestamp`. `/v1/federation/invoke` generates `request_id` server-side,
 * so adversarial scenarios that need a fixed `request_id` (replay) or a
 * skewed `timestamp` (clock skew) sign and POST to `/v1/federation/call`
 * directly.
 *
 * Mirror of the inline `signFederationCall` in `federation-call.test.ts`;
 * kept here so adversarial tests don't pull in that file's harness.
 */

import { HubIdentity } from '../src/federation/identity.js';

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export interface FederationCallBody {
  delegation_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  agent_id: string;
  request_id: string;
  timestamp: string;
  justification?: string | null;
}

export interface SignedFederationCall {
  raw: string;
  headers: Record<string, string>;
}

/**
 * Sign a federation call body the way B's hub-core will.
 *
 * The signature covers the canonical JSON of the body. The receiver
 * (A's hub-core) re-canonicalizes the raw body and verifies with the
 * `X-Federation-Pubkey` header — so `raw` must be the exact bytes that
 * were signed.
 */
export function signFederationCallLikeB(opts: {
  signerIdentity: HubIdentity;
  body: FederationCallBody;
}): SignedFederationCall {
  const canonical = JSON.stringify(opts.body);
  const sigBytes = opts.signerIdentity.sign(new TextEncoder().encode(canonical));
  return {
    raw: canonical,
    headers: {
      'x-federation-pubkey': opts.signerIdentity.publicKeyB64(),
      'x-federation-signature': bytesToBase64Url(sigBytes),
    },
  };
}
