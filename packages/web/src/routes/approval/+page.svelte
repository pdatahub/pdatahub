<script lang="ts">
  /**
   * Approval page — the killer feature.
   *
   * Receives `approval_request` messages over WebSocket from hub-core's
   * `/approval-stream` endpoint. User clicks Allow/Deny, message goes
   * back, tool call proceeds or is denied.
   *
   * Reliability features added in v0.4.0:
   *   - WebSocket reconnect with exponential backoff (1s → 2s → 4s → … → 30s)
   *   - Per-request countdown showing seconds remaining before hub timeout
   *   - Auto-deny at 0 to clean up state (hub already gave up internally)
   *   - Browser Notification when tab is hidden (visible state ⇒ in-app only)
   *
   * Pre-existing security note: `/approval-stream` doesn't currently
   * verify the bearer token (server.ts:90 — "by design"). For HN
   * launch we accept this as Tailscale/localhost trust assumption.
   * Web UI sends the token via subprotocol `bearer.<token>` for the
   * day the hub starts enforcing WS auth.
   */
  import { onMount, onDestroy } from 'svelte';
  import { api } from '$lib/api';
  import { getApiToken } from '$lib/stores/session';
  import Emptystate from '$lib/components/EmptyState.svelte';
  import type { ApprovalRequest } from '$lib/types';

  // Match hub-core's default ApprovalStream timeoutMs. Federated calls
  // get a 120s override but we only ever see local requests in the web UI.
  const APPROVAL_TIMEOUT_MS = 60_000;
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30_000;

  interface PendingRow extends ApprovalRequest {
    /** Set when we receive the message — used for countdown + audit. */
    receivedAt: number;
  }

  let pending = $state<PendingRow[]>([]);
  let history = $state<Array<PendingRow & { decision: string; decidedAt: number }>>([]);
  let wsState = $state<'connecting' | 'open' | 'closed' | 'error'>('closed');
  let reconnectIn = $state<number | null>(null);
  let now = $state<number>(Date.now());
  let notificationsEnabled = $state(false);

  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  /** User-initiated close — don't reconnect. */
  let userClosed = false;

  function connect() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getApiToken();
    const params = token ? `?token=${encodeURIComponent(token)}` : '';
    const url = `${proto}//${window.location.host}/approval-stream${params}`;
    wsState = 'connecting';
    try {
      ws = new WebSocket(url);
    } catch {
      wsState = 'error';
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      wsState = 'open';
      reconnectAttempts = 0;
      reconnectIn = null;
    });

    ws.addEventListener('message', (ev) => {
      let msg: ApprovalRequest;
      try {
        msg = JSON.parse(ev.data as string) as ApprovalRequest;
      } catch {
        return;
      }
      if (msg.type === 'approval_request' && typeof msg.request_id === 'string') {
        const row: PendingRow = { ...msg, receivedAt: Date.now() };
        pending = [...pending, row];
        notifyIfHidden(row);
      }
    });

    ws.addEventListener('close', (ev) => {
      wsState = 'closed';
      if (!userClosed && ev.code !== 1000) scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      wsState = 'error';
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer || userClosed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts++;
    reconnectIn = Math.ceil(delay / 1000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectIn = null;
      connect();
    }, delay);
    // Tick the countdown display once per second while waiting.
    const tick = setInterval(() => {
      if (reconnectTimer === null) {
        clearInterval(tick);
        return;
      }
      reconnectIn = Math.max(0, (reconnectIn ?? 0) - 1);
    }, 1000);
  }

  function sendDecision(req: PendingRow, decision: 'approved' | 'denied') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'approval_decided',
          request_id: req.request_id,
          decision,
        }),
      );
    }
    history = [...history, { ...req, decision, decidedAt: Date.now() }];
    pending = pending.filter((r) => r.request_id !== req.request_id);
  }

  function approve(req: PendingRow) {
    sendDecision(req, 'approved');
  }
  function deny(req: PendingRow) {
    sendDecision(req, 'denied');
  }

  function remainingMs(req: PendingRow): number {
    return Math.max(0, APPROVAL_TIMEOUT_MS - (now - req.receivedAt));
  }

  function tickClock() {
    now = Date.now();
    // Auto-deny any pending that have crossed the timeout. Hub has
    // already given up internally — sending deny is just cleanup.
    for (const req of pending) {
      if (now - req.receivedAt >= APPROVAL_TIMEOUT_MS) {
        sendDecision(req, 'denied');
      }
    }
  }

  async function ensureNotificationPermission() {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      notificationsEnabled = true;
      return;
    }
    if (Notification.permission === 'denied') return;
    const result = await Notification.requestPermission();
    notificationsEnabled = result === 'granted';
  }

  function notifyIfHidden(req: PendingRow) {
    if (!notificationsEnabled) return;
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible') return;
    try {
      new Notification('Tool approval needed', {
        body: `${req.plugin} → ${req.tool_name} (${req.scope})`,
        tag: req.request_id,
        requireInteraction: true,
      });
    } catch {
      // Some browsers throw if called from non-secure context.
    }
  }

  onMount(() => {
    connect();
    clockTimer = setInterval(tickClock, 1000);
  });

  onDestroy(() => {
    userClosed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (clockTimer) clearInterval(clockTimer);
    ws?.close();
  });

  function fmtSeconds(ms: number): string {
    return `${Math.ceil(ms / 1000)}s`;
  }
</script>

<svelte:head>
  <title>Approval · pdatahub</title>
</svelte:head>

<div class="approval">
  <header>
    <h1>Approval</h1>
    <div class="status">
      <span class="dot" data-state={wsState}></span>
      <span class="state-label">{wsState}</span>
      {#if wsState !== 'open' && reconnectIn !== null}
        <span class="reconnect">— reconnecting in {reconnectIn}s…</span>
      {/if}
      {#if typeof Notification !== 'undefined' && Notification.permission === 'default'}
        <button type="button" class="link" onclick={ensureNotificationPermission}>
          Enable notifications
        </button>
      {/if}
    </div>
  </header>

  <section>
    <h2>Pending requests ({pending.length})</h2>
    {#if pending.length === 0}
      <Emptystate
        title="No pending approvals"
        description="When an AI agent requests a tool call, it will appear here for you to allow or deny."
      />
    {:else}
      <ul class="pending-list">
        {#each pending as req (req.request_id)}
          {@const secs = remainingMs(req)}
          <li class="approval-card" data-urgent={secs < 10_000}>
            <div class="card-head">
              <span class="plugin">{req.plugin}</span>
              <code>{req.tool_name}</code>
              <span class="countdown" title="Time remaining before hub timeout">{fmtSeconds(secs)}</span>
            </div>
            {#if req.justification}
              <p class="justification">"{req.justification}"</p>
            {/if}
            <div class="meta-secondary">
              <span>Agent: <code>{req.agent_id}</code></span>
              <span>Scope: <code>{req.scope}</code></span>
            </div>
            <div class="actions">
              <button class="btn btn-danger" onclick={() => deny(req)} disabled={secs === 0}>Deny</button>
              <button class="btn btn-primary" onclick={() => approve(req)} disabled={secs === 0}>Allow</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if history.length > 0}
    <section>
      <h2>Recent decisions ({history.length})</h2>
      <ul class="history-list">
        {#each history.slice(-20).reverse() as h}
          <li>
            <span class="decision" data-decision={h.decision}>{h.decision}</span>
            <code>{h.tool_name}</code>
            <span class="dim">·</span>
            <span class="dim">{new Date(h.decidedAt).toLocaleTimeString()}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .approval {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 700;
  }
  h2 {
    margin: 0 0 var(--space-3);
    font-size: 18px;
    font-weight: 600;
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 13px;
    color: var(--fg-dim);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fg-mute);
  }
  .dot[data-state='open'] {
    background: var(--success, #4ade80);
    box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.2);
  }
  .dot[data-state='connecting'] {
    background: #fbbf24;
    animation: pulse 1.5s ease-in-out infinite;
  }
  .dot[data-state='error'],
  .dot[data-state='closed'] {
    background: #ef4444;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .state-label {
    text-transform: capitalize;
  }
  .reconnect {
    color: var(--fg-mute);
    font-size: 12px;
  }
  .link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 13px;
    padding: 0;
    text-decoration: underline;
  }
  .pending-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .approval-card {
    background: var(--bg-elev);
    border: 1px solid var(--accent);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    transition: border-color 0.2s;
  }
  .approval-card[data-urgent='true'] {
    border-color: #ef4444;
    animation: urgency-pulse 2s ease-in-out infinite;
  }
  @keyframes urgency-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
    50% { box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.15); }
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .plugin {
    padding: 2px 8px;
    background: var(--accent);
    color: var(--bg);
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 600;
  }
  .countdown {
    margin-left: auto;
    padding: 2px 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    font-size: 12px;
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
  }
  .approval-card[data-urgent='true'] .countdown {
    color: #ef4444;
    border-color: rgba(239, 68, 68, 0.3);
  }
  .justification {
    margin: 0;
    padding: var(--space-3);
    background: var(--bg);
    border-radius: var(--radius);
    font-style: italic;
    color: var(--fg-dim);
  }
  .meta-secondary {
    display: flex;
    gap: var(--space-4);
    font-size: 13px;
    color: var(--fg-dim);
    flex-wrap: wrap;
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
  .history-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .history-list li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev);
    border-radius: var(--radius);
    font-size: 13px;
  }
  .decision {
    display: inline-block;
    padding: 2px 8px;
    border-radius: var(--radius-pill);
    font-size: 11px;
    font-weight: 500;
  }
  .decision[data-decision='approved'] {
    background: rgba(74, 222, 128, 0.15);
    color: var(--success, #4ade80);
  }
  .decision[data-decision='denied'] {
    background: rgba(248, 113, 113, 0.15);
    color: var(--danger, #ef4444);
  }
  .dim {
    color: var(--fg-dim);
  }
  .btn {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius);
    cursor: pointer;
    font-weight: 600;
    font-size: 14px;
    border: none;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-danger {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }
  .btn-primary {
    background: var(--accent);
    color: var(--bg);
  }
</style>
