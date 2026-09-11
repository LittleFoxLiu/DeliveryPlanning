/**
 * Deterministic non-agentic baseline: "nearest feasible driver".
 *
 * Filters the fleet by the same hard feasibility rules the Driver Agent uses,
 * then picks whoever has the shortest driver→pickup ETA — no deadline
 * reasoning, no route-efficiency trade-off, no workload balancing, no
 * monitoring, no recovery. This is the strawman the autonomous system is
 * measured against.
 */
import { orders, drivers, deliveries, type OrderRow } from '../repo.js';
import { estimateGeoDelivery } from '../engine/geoRouting.js';
import { vehicleCanCarry } from '../agents/compat.js';
import { dispatchTools } from '../agents/dispatchAgent.js';

export async function baselineDispatch(orderId: string): Promise<{ assigned: boolean; driverId?: string; reason: string }> {
  const order = await orders.byId(orderId);
  if (!order) return { assigned: false, reason: 'order_not_found' };
  try { await orders.setStatus(orderId, 'validated', ['ready', 'created']); } catch { /* already */ }
  try { await orders.setStatus(orderId, 'dispatching', 'validated'); } catch { /* already */ }

  const pickup = { lat: order.pickup_latitude, lon: order.pickup_longitude };
  const fleet = await drivers.all();

  const feasible = fleet.filter((d) =>
    (d.status === 'available' || d.status === 'on_route')
    && d.latitude != null && d.longitude != null
    && d.capacity - d.current_order_count >= 1
    && vehicleCanCarry(d.vehicle_type, d.max_package_size, order.package_size));

  if (!feasible.length) return { assigned: false, reason: 'no_feasible_driver' };

  let best = feasible[0];
  let bestEta = Infinity;
  for (const d of feasible) {
    const eta = (await estimateGeoDelivery(
      { lat: d.latitude as number, lon: d.longitude as number }, pickup,
      { lat: order.delivery_latitude, lon: order.delivery_longitude },
    )).toPickup.etaMinutes;
    if (eta < bestEta) { bestEta = eta; best = d; }
  }

  const est = await estimateGeoDelivery(
    { lat: best.latitude as number, lon: best.longitude as number }, pickup,
    { lat: order.delivery_latitude, lon: order.delivery_longitude },
  );
  try {
    const res = await dispatchTools.assign_order({
      order: order as OrderRow, driverId: best.id, score: 0,
      reasoning: { selected: best.id, strategy: 'nearest_feasible_driver', etaToPickupMin: Number(bestEta.toFixed(1)), explanation: ['baseline: nearest feasible driver by pickup ETA'] },
      estimate: est, idempotencyKey: null, cycleId: `baseline_${orderId}`,
    });
    return { assigned: true, driverId: res.reused ? undefined : best.id, reason: res.reused ? 'reused' : 'assigned' };
  } catch (err) {
    return { assigned: false, reason: err instanceof Error ? err.message : 'assign_failed' };
  }
}

export async function baselineDelivered(orderId: string): Promise<{ delivered: boolean; onTime: boolean | null }> {
  const dv = await deliveries.byOrderId(orderId);
  const order = await orders.byId(orderId);
  const delivered = dv?.status === 'delivered';
  const onTime = delivered && dv?.delivered_at && order
    ? Date.parse(dv.delivered_at) <= Date.parse(order.deadline_ts) : null;
  return { delivered, onTime };
}
