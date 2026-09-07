import { orders, deliveries, routes, drivers, roads, assignments, type OrderRow } from '../repo.js';
import { emitAgentEvent } from '../events.js';
import { id, minutesFromNow } from '../util.js';
import { orderAgent } from './orderAgent.js';
import { driverAgent } from './driverAgent.js';
import { routingAgent } from './routingAgent.js';
import { dispatchAgent, dispatchTools, type DispatchDecision } from './dispatchAgent.js';
import { monitoringAgent, type Finding } from './monitoringAgent.js';
import { adviseRemediation } from './llm.js';
import { estimateDeliveryTime, type Point } from '../engine/routing.js';

const NAME = 'Coordinator';

export interface DispatchOutcome {
  cycleId: string;
  orderId: string;
  status: 'assigned' | 'no_driver' | 'invalid' | 'reused';
  decision?: DispatchDecision;
  issues?: string[];
}

/** Run the candidate → route → evaluate → assign pipeline. Shared by initial
 *  dispatch and by reassignment. */
async function runPipeline(order: OrderRow, cycleId: string, opts: { excludeDriverIds?: string[]; idempotencyKey?: string | null }): Promise<DispatchDecision> {
  const { candidates } = await driverAgent.findCandidates(order, cycleId, opts.excludeDriverIds ?? []);
  const routed = await routingAgent.computeCandidateRoutes(order, candidates, cycleId);
  return dispatchAgent.evaluateAndAssign(order, routed, cycleId, { idempotencyKey: opts.idempotencyKey ?? null });
}

export const coordinator = {
  name: NAME,

  /** Full multi-agent dispatch for a freshly-ready order. */
  async dispatchOrder(orderId: string, opts: { idempotencyKey?: string | null } = {}): Promise<DispatchOutcome> {
    const cycleId = id('cyc');
    const order = await orders.byId(orderId);
    if (!order) return { cycleId, orderId, status: 'invalid', issues: ['order_not_found'] };

    // Already dispatched — idempotent short-circuit (covers concurrent triggers).
    if (['assigned', 'picked_up', 'delivering'].includes(order.status)) {
      const active = await assignments.activeForOrder(orderId);
      if (active) {
        await emitAgentEvent({
          cycleId, agent: NAME, eventType: 'cycle_noop', orderId, driverId: active.driver_id,
          message: `Order ${orderId} is already ${order.status} (driver ${active.driver_id}) — no new dispatch needed`,
        });
        return {
          cycleId, orderId, status: 'reused',
          decision: { assigned: true, driverId: active.driver_id, deliveryId: (await deliveries.byOrderId(orderId))?.id, score: active.score, ranked: [], rationale: 'already assigned', reused: true },
        };
      }
    }
    if (['delivered', 'cancelled'].includes(order.status)) {
      return { cycleId, orderId, status: 'invalid', issues: [`order_${order.status}`] };
    }

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'cycle_started', orderId,
      message: `Dispatch cycle started for order ${orderId} — routing Order Agent to validate`,
    });

    const validation = await orderAgent.validate(orderId, cycleId);
    if (!validation.ok) {
      await emitAgentEvent({
        cycleId, agent: NAME, eventType: 'cycle_aborted', orderId,
        message: `Dispatch aborted — order ${orderId} is invalid: ${validation.issues.join(', ')}`,
      });
      return { cycleId, orderId, status: 'invalid', issues: validation.issues };
    }

    await orders.setStatus(orderId, 'dispatching', 'validated');
    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'delegating', orderId,
      message: `Order valid — Coordinator now engaging Driver Agent, then Routing Agent, then Dispatch Agent`,
    });

    const fresh = (await orders.byId(orderId))!;
    const decision = await runPipeline(fresh, cycleId, { idempotencyKey: opts.idempotencyKey ?? null });

    if (!decision.assigned) {
      // leave the order dispatchable so a later cycle (more drivers / less traffic) can retry
      try { await orders.setStatus(orderId, 'validated', 'dispatching'); } catch { /* already moved */ }
      await emitAgentEvent({
        cycleId, agent: NAME, eventType: 'cycle_completed', orderId,
        message: `Dispatch cycle completed — no driver assigned for order ${orderId}. ${decision.rationale}`,
      });
      return { cycleId, orderId, status: 'no_driver', decision };
    }

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'cycle_completed', orderId, deliveryId: decision.deliveryId, driverId: decision.driverId,
      message: decision.reused
        ? `Dispatch cycle completed — order ${orderId} was already assigned to ${decision.driverId}`
        : `Dispatch cycle completed — order ${orderId} assigned to ${decision.driverId}. Monitoring Agent now watching the delivery.`,
    });
    return { cycleId, orderId, status: decision.reused ? 'reused' : 'assigned', decision };
  },

  /** One monitoring pass over all active deliveries + remediation. */
  async runMonitoringCycle(): Promise<{ cycleId: string; findings: Finding[]; actions: unknown[] }> {
    const cycleId = id('cyc');
    const findings = await monitoringAgent.evaluateActiveDeliveries(cycleId);
    const actions: unknown[] = [];
    if (findings.length === 0) return { cycleId, findings, actions };

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'monitoring_alert',
      message: `Monitoring Agent surfaced ${findings.length} at-risk deliver${findings.length === 1 ? 'y' : 'ies'} — Coordinator deciding remediation`,
      data: { findings },
    });

    for (const finding of findings) {
      const action = await coordinator.remediate(finding, cycleId);
      actions.push(action);
    }
    return { cycleId, findings, actions };
  },

  async remediate(finding: Finding, cycleId: string): Promise<{ orderId: string; strategy: string; ok: boolean; detail: string }> {
    const order = await orders.byId(finding.orderId);
    const delivery = await deliveries.byId(finding.deliveryId);
    if (!order || !delivery || !delivery.driver_id) return { orderId: finding.orderId, strategy: 'none', ok: false, detail: 'stale' };

    const alreadyPickedUp = ['picked_up', 'en_route_drop'].includes(delivery.status);
    const rerouteFeasible = finding.projectedTotalMin !== Infinity && !finding.issues.includes('driver_unavailable');
    const reassignFeasible = !alreadyPickedUp; // do not reassign a package already in the driver's hands

    let deterministicChoice = finding.recommendedTrigger === 'reassign' ? 'reassign' : 'reroute';
    if (deterministicChoice === 'reassign' && !reassignFeasible) deterministicChoice = 'reroute';
    if (deterministicChoice === 'reroute' && !rerouteFeasible && reassignFeasible) deterministicChoice = 'reassign';

    const advisory = await adviseRemediation({
      orderId: order.id,
      issues: finding.issues,
      slipMin: finding.slipMin,
      missesDeadline: finding.missesDeadline,
      rerouteFeasible,
      reassignFeasible,
      deterministicChoice: deterministicChoice as 'reroute' | 'reassign',
    });

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'remediation_decided', orderId: order.id, deliveryId: delivery.id,
      message: `Coordinator chose to ${advisory.strategy} order ${order.id} (${advisory.source}): ${advisory.rationale}`,
      data: advisory,
    });

    if (advisory.strategy === 'reroute') {
      return coordinator.reroute(finding, cycleId);
    }
    return coordinator.reassign(finding, cycleId, [delivery.driver_id]);
  },

  async reroute(finding: Finding, cycleId: string): Promise<{ orderId: string; strategy: string; ok: boolean; detail: string }> {
    const order = (await orders.byId(finding.orderId))!;
    const delivery = (await deliveries.byId(finding.deliveryId))!;
    const driver = (await drivers.byId(delivery.driver_id!))!;
    const pos: Point = { x: driver.lat as number, y: driver.lng as number };
    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'reroute_requested', orderId: order.id, deliveryId: delivery.id,
      message: `Coordinator asked Routing Agent to recalculate the route for order ${order.id} from the driver's current position`,
    });

    const result = await routingAgent.recalculate(delivery, order, pos, finding.phase, cycleId);
    if (!result.ok) {
      // reroute impossible — escalate to reassignment if the package is not yet picked up
      if (!['picked_up', 'en_route_drop'].includes(delivery.status)) {
        return coordinator.reassign(finding, cycleId, [delivery.driver_id!]);
      }
      await deliveries.update(delivery.id, { eta_ts: null });
      return { orderId: order.id, strategy: 'reroute', ok: false, detail: 'no_viable_route_and_package_in_transit' };
    }

    const newEtaTs = minutesFromNow(result.etaMinutes);
    const est = finding.phase === 'to_pickup'
      ? estimateDeliveryTime(pos, { x: order.pickup_lat, y: order.pickup_lng }, { x: order.delivery_lat, y: order.delivery_lng }, await roads.segments())
      : null;
    await routes.create({
      deliveryId: delivery.id,
      driverId: delivery.driver_id!,
      originLat: pos.x,
      originLng: pos.y,
      legs: est
        ? { toPickup: { etaMinutes: est.toPickup.etaMinutes, distanceKm: est.toPickup.distanceKm }, handlingMinutes: est.handlingMinutes, toDropoff: { etaMinutes: est.toDropoff.etaMinutes, distanceKm: est.toDropoff.distanceKm } }
        : { toDropoff: { etaMinutes: result.route!.etaMinutes, distanceKm: result.route!.distanceKm } },
      path: est ? { toPickup: est.toPickup.path, toDropoff: est.toDropoff.path } : { toDropoff: result.route!.path },
      distanceKm: est ? est.totalDistanceKm : result.route!.distanceKm,
      etaMinutes: result.etaMinutes,
      trafficPenalty: result.route!.trafficPenaltyMinutes,
    });
    await deliveries.update(delivery.id, { eta_ts: newEtaTs, estimated_delivery_minutes: result.etaMinutes });

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'reroute_applied', orderId: order.id, deliveryId: delivery.id, driverId: delivery.driver_id,
      message: `Route updated for order ${order.id} — customer ETA now ${new Date(newEtaTs).toLocaleTimeString()}`,
      data: { etaMinutes: result.etaMinutes, etaTs: newEtaTs },
    });
    return { orderId: order.id, strategy: 'reroute', ok: true, detail: `eta ${result.etaMinutes} min` };
  },

  async reassign(finding: Finding, cycleId: string, excludeDriverIds: string[]): Promise<{ orderId: string; strategy: string; ok: boolean; detail: string }> {
    const order = (await orders.byId(finding.orderId))!;
    const delivery = (await deliveries.byId(finding.deliveryId))!;
    if (['delivered', 'cancelled'].includes(delivery.status)) {
      return { orderId: order.id, strategy: 'reassign', ok: false, detail: 'delivery_terminal' };
    }
    if (['picked_up', 'en_route_drop'].includes(delivery.status)) {
      return { orderId: order.id, strategy: 'reassign', ok: false, detail: 'package_in_transit' };
    }

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'reassign_requested', orderId: order.id, deliveryId: delivery.id,
      message: `Coordinator initiating reassignment for order ${order.id} — excluding ${excludeDriverIds.join(', ')}`,
    });

    await dispatchTools.reassign_order(order.id, `reassignment: ${finding.issues.join(', ')}`, cycleId);
    try { await deliveries.setStatus(delivery.id, 'failed'); } catch { /* may already be pending */ }
    try { await orders.setStatus(order.id, 'dispatching'); } catch { /* fallthrough */ }

    const fresh = (await orders.byId(order.id))!;
    const decision = await runPipeline(fresh, cycleId, { excludeDriverIds });

    if (!decision.assigned) {
      try { await orders.setStatus(order.id, 'validated', 'dispatching'); } catch { /* ignore */ }
      await emitAgentEvent({
        cycleId, agent: NAME, eventType: 'reassign_failed', orderId: order.id, deliveryId: delivery.id,
        message: `Reassignment failed for order ${order.id}: ${decision.rationale}`,
      });
      return { orderId: order.id, strategy: 'reassign', ok: false, detail: decision.rationale };
    }

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'reassign_applied', orderId: order.id, deliveryId: decision.deliveryId, driverId: decision.driverId,
      message: `Order ${order.id} reassigned from ${excludeDriverIds.join(', ')} to ${decision.driverId} — score ${decision.score}`,
      data: { rationale: decision.rationale },
    });
    return { orderId: order.id, strategy: 'reassign', ok: true, detail: `now ${decision.driverId}` };
  },
};
