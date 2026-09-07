/**
 * Approval stream — WebSocket bridge between Hub core and Android UI.
 *
 * Flow:
 *   1. Android UI connects via WebSocket: ws://hub-host:8090/approval-stream
 *   2. Hub sends `approval_request` when AI agent requests tool access
 *   3. Android UI shows notification, user taps [Approve] or [Deny] + biometric
 *   4. Android UI sends `approval_decided` back
 *   5. Hub resolves the pending request, creates grant, plugin proceeds
 *
 * Also broadcasts `audit_update` and `grant_revoked` for live UI updates.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ApprovalStreamMessage } from './types.js';
import { logger } from './logger.js';

export interface PendingApproval {
  request_id: string;
  agent_id: string;
  tool_name: string;
  scope: string;
  justification: string | null;
  created_at: string;
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ApprovalDecision {
  decision: 'approved' | 'denied';
  grant_id?: string; // If approved, the grant_id that will be/was created
}

export class ApprovalStream {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 60_000; // 60 sec default
  }

  /**
   * Attach to existing HTTP server. Path: /approval-stream
   */
  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: '/approval-stream' });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    logger.info('approval stream attached', { path: '/approval-stream' });
  }

  /**
   * Request approval from user. Resolves when Android UI responds (or timeout).
   * Throws on timeout — caller should handle as denial.
   *
   * Phase 3 (Federation v2) — accepts optional `delegated_by`,
   * `peer_hub_name`, and `peer_agent_id`. When present, these are
   * included in the broadcast so the Android UI can show "userB's
   * agent X requests Y" instead of the generic local-agent dialog.
   * Per-call timeout override (`timeoutMsOverride`) lets the caller
   * give federated requests a 120s budget while keeping the local
   * 60s default (Momus I1).
   */
  requestApproval(opts: {
    agent_id: string;
    tool_name: string;
    scope: string;
    justification: string | null;
    /** Phase 3 — peer hub's verify_key for federated calls. */
    delegated_by?: string | null;
    /** Phase 3 — peer hub's display name (e.g. "userB"). */
    peer_hub_name?: string | null;
    /** Phase 3 — agent_id from B's side (B's original request). */
    peer_agent_id?: string | null;
    /** Phase 3 — override this instance's timeoutMs for this call only. */
    timeoutMsOverride?: number | null;
  }): Promise<ApprovalDecision> {
    const request_id = randomUUID();
    const created_at = new Date().toISOString();
    const effectiveTimeout = opts.timeoutMsOverride ?? this.timeoutMs;

    return new Promise<ApprovalDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(request_id)) {
          this.pending.delete(request_id);
          logger.warn('approval request timed out', { request_id });
          reject(new Error(`approval timeout after ${effectiveTimeout}ms`));
        }
      }, effectiveTimeout);

      const approval: PendingApproval = {
        request_id,
        agent_id: opts.agent_id,
        tool_name: opts.tool_name,
        scope: opts.scope,
        justification: opts.justification,
        created_at,
        resolve,
        reject,
        timer,
      };
      this.pending.set(request_id, approval);

      const message: ApprovalStreamMessage = {
        type: 'approval_request',
        request_id,
        agent_id: opts.agent_id,
        tool_name: opts.tool_name,
        scope: opts.scope,
        justification: opts.justification,
        created_at,
        ...(opts.delegated_by ? { delegated_by: opts.delegated_by } : {}),
        ...(opts.peer_hub_name ? { peer_hub_name: opts.peer_hub_name } : {}),
        ...(opts.peer_agent_id ? { peer_agent_id: opts.peer_agent_id } : {}),
      };
      this.broadcast(message);
      logger.info('approval request sent', {
        request_id,
        tool: opts.tool_name,
        agent: opts.agent_id,
        connected_clients: this.clients.size,
        delegated_by: opts.delegated_by ?? null,
      });
    });
  }

  /**
   * Broadcast audit log update to connected clients (live UI).
   */
  broadcastAudit(entry: import('./types.js').AuditEntry): void {
    const message: ApprovalStreamMessage = {
      type: 'audit_update',
      entry,
    };
    this.broadcast(message);
  }

  /**
   * Broadcast grant revocation to connected clients.
   */
  broadcastRevocation(grant_id: string): void {
    const message: ApprovalStreamMessage = {
      type: 'grant_revoked',
      grant_id,
    };
    this.broadcast(message);
  }

  /**
   * Number of currently-connected WebSocket clients (phones). Phase 3
   * fast-path: `/v1/federation/call` checks this BEFORE waiting on the
   * approval flow so an offline phone returns 503 immediately instead
   * of burning the 120s budget (Momus I2).
   */
  connectedClients(): number {
    return this.clients.size;
  }

  /**
   * Close all WebSocket connections and shut down server.
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        client.close();
      }
      this.clients.clear();
      // Cancel all pending approvals
      for (const [id, approval] of this.pending.entries()) {
        clearTimeout(approval.timer);
        approval.reject(new Error('approval stream closed'));
        this.pending.delete(id);
      }
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /* ─── Private ─────────────────────────────────────────────────────────── */

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    logger.info('client connected to approval stream', {
      total_clients: this.clients.size,
    });

    ws.on('message', (raw) => {
      void this.handleMessage(ws, raw.toString('utf8'));
    });
    ws.on('close', () => {
      this.clients.delete(ws);
      logger.info('client disconnected', { total_clients: this.clients.size });
    });
    ws.on('error', (err) => {
      logger.error('websocket error', { error: err.message });
    });

    // Send ping every 30s to keep connection alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);
    ws.on('close', () => clearInterval(pingInterval));
  }

  private async handleMessage(_ws: WebSocket, raw: string): Promise<void> {
    let msg: ApprovalStreamMessage;
    try {
      msg = JSON.parse(raw) as ApprovalStreamMessage;
    } catch (err) {
      logger.warn('invalid JSON from approval client', { raw: raw.slice(0, 200) });
      return;
    }
    if (msg.type === 'pong') return;

    if (msg.type === 'approval_decided') {
      const approval = this.pending.get(msg.request_id);
      if (!approval) {
        logger.warn('approval decision for unknown request', {
          request_id: msg.request_id,
        });
        return;
      }
      this.pending.delete(msg.request_id);
      clearTimeout(approval.timer);
      logger.info('approval decided', {
        request_id: msg.request_id,
        decision: msg.decision,
      });
      if (msg.decision === 'approved') {
        approval.resolve({
          decision: 'approved',
          ...(msg.grant_id ? { grant_id: msg.grant_id } : {}),
        });
      } else {
        approval.resolve({ decision: 'denied' });
      }
      return;
    }

    logger.warn('unknown approval stream message type', { type: (msg as { type: string }).type });
  }

  private broadcast(message: ApprovalStreamMessage): void {
    const json = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }
}
