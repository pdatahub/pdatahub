/**
 * Wire protocol for pdatahub relay.
 *
 * All messages are JSON. The relay forwards opaque payloads between Hub and
 * laptop. The relay does NOT inspect message contents — that is the Hub's job.
 *
 * Lifecycle:
 *   1. Hub creates a session (POST /sessions) — receives session_id + tokens.
 *   2. Hub opens WS to /sessions/:id/ws?role=hub&token=<hub_token>.
 *   3. Laptop opens WS to /sessions/:id/ws?role=laptop&token=<laptop_token>.
 *   4. Both sides send { type: "forward", payload: <opaque> } messages.
 *   5. The relay forwards each message to the other party.
 */

import { z } from 'zod';

export const RoleSchema = z.enum(['hub', 'laptop']);
export type Role = z.infer<typeof RoleSchema>;

export const ForwardMessageSchema = z.object({
  type: z.literal('forward'),
  payload: z.unknown(),
});
export type ForwardMessage = z.infer<typeof ForwardMessageSchema>;

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
});
export const PongMessageSchema = z.object({
  type: z.literal('pong'),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  ForwardMessageSchema,
  PingMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  PingMessageSchema,
  PongMessageSchema,
  z.object({ type: z.literal('registered'), sessionId: z.string(), role: RoleSchema }),
  z.object({ type: z.literal('error'), reason: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const CreateSessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  hubToken: z.string().min(16),
  laptopToken: z.string().min(16),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const InitSessionRequestSchema = z.object({
  hubToken: z.string().min(16),
  laptopToken: z.string().min(16),
});
export type InitSessionRequest = z.infer<typeof InitSessionRequestSchema>;
