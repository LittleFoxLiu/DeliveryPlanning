import { EventEmitter } from 'node:events';
import { q } from './db.js';

export interface AgentEvent {
  id: number;
  ts: string;
  cycleId: string | null;
  agent: string;
  eventType: string;
  orderId: string | null;
  deliveryId: string | null;
  driverId: string | null;
  message: string;
  data: unknown;
}

export interface EmitInput {
  cycleId?: string | null;
  agent: string;
  eventType: string;
  orderId?: string | null;
  deliveryId?: string | null;
  driverId?: string | null;
  message: string;
  data?: unknown;
}

export const bus = new EventEmitter();
bus.setMaxListeners(50);

export async function emitAgentEvent(input: EmitInput): Promise<AgentEvent> {
  const rows = await q<{ id: number; ts: string }>(`
    INSERT INTO agent_events (cycle_id, agent, event_type, order_id, delivery_id, driver_id, message, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)
    RETURNING id, ts`,
    [
      input.cycleId ?? null, input.agent, input.eventType,
      input.orderId ?? null, input.deliveryId ?? null, input.driverId ?? null,
      input.message, input.data === undefined ? null : JSON.stringify(input.data),
    ]);

  const event: AgentEvent = {
    id: rows[0].id,
    ts: rows[0].ts,
    cycleId: input.cycleId ?? null,
    agent: input.agent,
    eventType: input.eventType,
    orderId: input.orderId ?? null,
    deliveryId: input.deliveryId ?? null,
    driverId: input.driverId ?? null,
    message: input.message,
    data: input.data ?? null,
  };
  // Never let a listener (e.g. a dead SSE socket) break the caller's flow.
  try { bus.emit('event', event); } catch (err) { console.error('[events] listener error', err); }
  return event;
}

function mapRow(r: Record<string, unknown>): AgentEvent {
  return {
    id: Number(r.id),
    ts: r.ts as string,
    cycleId: (r.cycle_id as string) ?? null,
    agent: r.agent as string,
    eventType: r.event_type as string,
    orderId: (r.order_id as string) ?? null,
    deliveryId: (r.delivery_id as string) ?? null,
    driverId: (r.driver_id as string) ?? null,
    message: r.message as string,
    data: r.data_json ?? null,
  };
}

export async function listEvents(opts: { sinceId?: number; orderId?: string; limit?: number } = {}): Promise<AgentEvent[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceId !== undefined) { clauses.push('id > ?'); params.push(opts.sinceId); }
  if (opts.orderId) { clauses.push('order_id = ?'); params.push(opts.orderId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(opts.limit ?? 200, 500);
  params.push(limit);
  const rows = await q<Record<string, unknown>>(`SELECT * FROM agent_events ${where} ORDER BY id DESC LIMIT ?`, params);
  return rows.map(mapRow).reverse();
}
