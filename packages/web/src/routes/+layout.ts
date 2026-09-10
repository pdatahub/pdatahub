/**
 * Layout load — runs on every page navigation (server + client).
 *
 * For SPA, this only runs on the client. We use it to:
 *   - Probe hub health on every nav (refresh connection status)
 *   - Set hub URL from window.location.origin
 */

import { session } from '$lib/stores/session';
import { api } from '$lib/api';
import { browser } from '$app/environment';

export const ssr = false;
export const prerender = false;

export async function load() {
  if (browser) {
    session.update((s) => ({ ...s, hubUrl: window.location.origin }));
    try {
      await api.health();
      session.update((s) => ({ ...s, hubOnline: true }));
    } catch {
      session.update((s) => ({ ...s, hubOnline: false }));
    }
  }
  return {};
}
