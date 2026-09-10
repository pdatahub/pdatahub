/**
 * Session store — holds the API token + connection status.
 *
 * On localhost (HUB_API_TOKEN not required), token stays empty.
 * On exposed deployments, user enters PIN, server validates, sets
 * HttpOnly cookie, and we read the token from the cookie via
 * a future /v1/auth/session endpoint.
 *
 * For v1 we keep it simple: token is held in memory + sessionStorage.
 */

import { writable } from 'svelte/store';

export interface Session {
  apiToken: string;
  hubOnline: boolean;
  hubUrl: string;
}

const STORAGE_KEY = 'pdatahub:session';

function loadInitial(): Session {
  if (typeof window === 'undefined') {
    return { apiToken: '', hubOnline: false, hubUrl: '' };
  }
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Session;
  } catch {
    // ignore
  }
  return { apiToken: '', hubOnline: false, hubUrl: window.location.origin };
}

export const session = writable<Session>(loadInitial());

session.subscribe((s) => {
  if (typeof window === 'undefined') return;
  try {
    if (s.apiToken) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // sessionStorage might be full or disabled — non-fatal
  }
});

export function getApiToken(): string {
  let token = '';
  session.subscribe((s) => { token = s.apiToken; })();
  return token;
}

export function setApiToken(token: string) {
  session.update((s) => ({ ...s, apiToken: token }));
}
