import { z } from 'zod';

/**
 * Structural validation of inbound WebSocket messages (the TypeScript types live in @cf/shared protocol.ts).
 * Hard caps here bound memory; the engine applies the documented (smaller) semantic limits with
 * friendly `too_large` errors.
 */
const id = z.string().min(1).max(128);
const smallRecord = z.record(z.unknown());

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    sessionId: z.string().min(1).max(64),
    token: z.string().min(1).max(200),
    protocol: z.number().int(),
    clientInstanceId: z.string().max(128).default(''),
    lastSeq: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('participant.partial'), clientTurnId: id, text: z.string().max(20_000).transform((s) => s.slice(0, 2000)) }),
  z.object({
    type: z.literal('participant.final'),
    clientTurnId: id,
    text: z.string().max(20_000),
    startedAtMs: z.number().optional(),
    endedAtMs: z.number().optional(),
    confidence: z.number().min(0).max(1).optional(),
    source: z.enum(['browser_stt', 'server_stt', 'typed', 'realtime', 'simulated']).default('browser_stt'),
  }),
  z.object({ type: z.literal('participant.speaking'), speaking: z.boolean() }),
  z.object({
    type: z.literal('agent.playback'),
    turnId: id,
    event: z.enum(['started', 'completed', 'interrupted']),
    spokenChars: z.number().int().min(0).max(1_000_000).optional(),
  }),
  z.object({ type: z.literal('control'), action: z.enum(['pause', 'resume', 'end', 'mute', 'unmute']) }),
  z.object({ type: z.literal('tool.open'), toolId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('tool.response'), toolCallId: id, result: smallRecord }),
  z.object({ type: z.literal('tool.update'), toolCallId: id, data: smallRecord }),
  z.object({
    type: z.literal('realtime.transcript'),
    itemId: id,
    role: z.enum(['user', 'assistant']),
    text: z.string().max(20_000),
    interrupted: z.boolean().optional(),
  }),
  z.object({ type: z.literal('realtime.tool_call'), callId: id, name: z.string().min(1).max(80), arguments: z.string().max(60_000) }),
  z.object({ type: z.literal('client.event'), name: z.string().min(1).max(64), data: smallRecord.optional() }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
