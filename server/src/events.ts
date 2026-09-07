import { EventEmitter } from 'node:events';
import { insert, select } from './db.js';

export interface AgentEvent { id: number; ts: string; cycleId: string | null; agent: string; eventType: string; orderId: string | null; deliveryId: string | null; driverId: string | null; message: string; data: unknown }
export interface EmitInput { cycleId?: string | null; agent: string; eventType: string; orderId?: string | null; deliveryId?: string | null; driverId?: string | null; message: string; data?: unknown }

export const bus = new EventEmitter();
bus.setMaxListeners(50);

export async function emitAgentEvent(input: EmitInput): Promise<AgentEvent> {
  const row = await insert<{ id: number; ts: string }>('agent_events', {
    ts: new Date().toISOString(), cycle_id: input.cycleId ?? null, agent: input.agent,
    event_type: input.eventType, order_id: input.orderId ?? null, delivery_id: input.deliveryId ?? null,
    driver_id: input.driverId ?? null, message: input.message, data_json: input.data ?? null,
  });
  const event: AgentEvent = { id: row.id, ts: row.ts, cycleId: input.cycleId ?? null, agent: input.agent, eventType: input.eventType, orderId: input.orderId ?? null, deliveryId: input.deliveryId ?? null, driverId: input.driverId ?? null, message: input.message, data: input.data ?? null };
  try { bus.emit('event', event); } catch (err) { console.error('[events] listener error', err); }
  return event;
}

function mapRow(r: Record<string, unknown>): AgentEvent {
  const data = r.data_json;
  return { id: r.id as number, ts: r.ts as string, cycleId: (r.cycle_id as string) ?? null, agent: r.agent as string, eventType: r.event_type as string, orderId: (r.order_id as string) ?? null, deliveryId: (r.delivery_id as string) ?? null, driverId: (r.driver_id as string) ?? null, message: r.message as string, data: typeof data === 'string' ? JSON.parse(data) : data ?? null };
}

export async function listEvents(opts: { sinceId?: number; orderId?: string; limit?: number } = {}): Promise<AgentEvent[]> {
  const filters: Record<string, string> = {};
  if (opts.sinceId !== undefined) filters.id = `gt.${opts.sinceId}`;
  if (opts.orderId) filters.order_id = `eq.${opts.orderId}`;
  const rows = await select<Record<string, unknown>>('agent_events', filters, { order: 'id.desc', limit: String(Math.min(opts.limit ?? 200, 500)) });
  return rows.map(mapRow).reverse();
}
