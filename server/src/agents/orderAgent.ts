import { orders, merchants, stores, customers } from '../repo.js';
import { emitAgentEvent } from '../events.js';
import { config } from '../config.js';
import type { OrderStatus } from '../engine/stateMachine.js';

const NAME = 'OrderAgent';
const SIZE = config.grid.size;

/** Deterministic capabilities. The agent decides; the tools compute/fetch. */
export const orderTools = {
  get_order: (orderId: string) => orders.byId(orderId),
  get_merchant: (merchantId: string) => merchants.byId(merchantId),
  get_store: (storeId: string) => stores.byId(storeId),
  get_customer: async (orderId: string) => {
    const o = await orders.byId(orderId);
    return o ? customers.byId(o.customer_id) : undefined;
  },
  get_delivery_address: async (orderId: string) => {
    const o = await orders.byId(orderId);
    return o ? { lat: o.delivery_lat, lng: o.delivery_lng } : undefined;
  },
  get_order_constraints: async (orderId: string) => {
    const o = await orders.byId(orderId);
    if (!o) return undefined;
    return {
      packageSize: o.package_size,
      volume: o.volume,
      priority: o.priority,
      deadlineTs: o.deadline_ts,
      pickup: { lat: o.pickup_lat, lng: o.pickup_lng },
      dropoff: { lat: o.delivery_lat, lng: o.delivery_lng },
    };
  },
  validate_order: async (orderId: string) => {
    const o = await orders.byId(orderId);
    const issues: string[] = [];
    if (!o) return { ok: false, issues: ['order_not_found'] };
    const [merchant, store, customer] = await Promise.all([
      merchants.byId(o.merchant_id), stores.byId(o.store_id), customers.byId(o.customer_id),
    ]);
    if (!merchant) issues.push('merchant_missing');
    if (!store) issues.push('store_missing');
    else if (store.merchant_id !== o.merchant_id) issues.push('store_merchant_mismatch');
    if (!customer) issues.push('customer_missing');
    for (const [k, v] of Object.entries({
      pickup_lat: o.pickup_lat, pickup_lng: o.pickup_lng, delivery_lat: o.delivery_lat, delivery_lng: o.delivery_lng,
    })) {
      if (!Number.isFinite(v) || v < 0 || v > SIZE) issues.push(`coord_out_of_bounds:${k}`);
    }
    if (o.pickup_lat === o.delivery_lat && o.pickup_lng === o.delivery_lng) issues.push('pickup_equals_dropoff');
    if (o.volume < 1) issues.push('volume_invalid');
    const deadlineMs = Date.parse(o.deadline_ts);
    if (!Number.isFinite(deadlineMs)) issues.push('deadline_invalid');
    else if (deadlineMs < Date.now()) issues.push('deadline_in_past');
    else if (deadlineMs - Date.now() < 15 * 60_000) issues.push('deadline_too_soon');
    return { ok: issues.length === 0, issues };
  },
  update_order_status: (orderId: string, to: OrderStatus, expectedFrom?: OrderStatus | OrderStatus[]) =>
    orders.setStatus(orderId, to, expectedFrom),
};

export interface OrderValidation {
  ok: boolean;
  issues: string[];
  constraints?: Awaited<ReturnType<typeof orderTools.get_order_constraints>>;
}

export const orderAgent = {
  name: NAME,
  tools: orderTools,

  /** Validate order + merchant + pickup/delivery info, derive constraints,
   *  and advance order state to `validated`. */
  async validate(orderId: string, cycleId: string): Promise<OrderValidation> {
    const order = await orderTools.get_order(orderId);
    if (!order) {
      await emitAgentEvent({ cycleId, agent: NAME, eventType: 'validation_failed', orderId, message: `Order ${orderId} not found` });
      return { ok: false, issues: ['order_not_found'] };
    }
    const result = await orderTools.validate_order(orderId);
    const constraints = await orderTools.get_order_constraints(orderId);

    if (!result.ok) {
      await emitAgentEvent({
        cycleId, agent: NAME, eventType: 'validation_failed', orderId,
        message: `Order ${orderId} failed validation: ${result.issues.join(', ')}`,
        data: { issues: result.issues },
      });
      return { ok: false, issues: result.issues, constraints };
    }

    await orderTools.update_order_status(orderId, 'validated', ['ready', 'validated', 'dispatching', 'failed']);
    const deadlineMin = Math.round((Date.parse(order.deadline_ts) - Date.now()) / 60_000);
    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'order_validated', orderId,
      message: `Validated order ${orderId} — ${order.priority} priority, ${order.package_size} package, deadline in ${deadlineMin} min`,
      data: { constraints },
    });
    return { ok: true, issues: [], constraints };
  },
};
