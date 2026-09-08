import { tx } from '../db.js';
import {
  orders, deliveries, routes, assignments, drivers,
  type OrderRow, type AssignmentRow,
} from '../repo.js';
import { emitAgentEvent } from '../events.js';
import { nowIso, minutesFromNow, conflict } from '../util.js';
import { scoreDriver, compareAssignments, type ScoreBreakdown } from '../engine/scoring.js';
import { explainAssignment } from './llm.js';
import type { RoutedCandidate } from './routingAgent.js';

const NAME = 'DispatchAgent';

export const dispatchTools = {
  score_driver: scoreDriver,
  compare_assignments: compareAssignments,
  get_candidate_drivers: (routed: RoutedCandidate[]) => routed.map((r) => r.candidate.driver.id),

  /** Atomic, idempotent assignment. Race-safe: the order-status compare-and-set
   *  (a conditional UPDATE that also row-locks) is the authoritative gate — a
   *  second concurrent cycle for the same order finds 0 rows affected and aborts,
   *  rolling back everything it did in the transaction. */
  async assign_order(input: {
    order: OrderRow;
    driverId: string;
    score: number;
    reasoning: unknown;
    estimate: RoutedCandidate['estimate'];
    idempotencyKey?: string | null;
    cycleId: string;
  }): Promise<{ assignment: AssignmentRow; deliveryId: string; reused: boolean }> {
    return tx(async () => {
      if (input.idempotencyKey) {
        const existing = await assignments.byIdempotencyKey(input.idempotencyKey);
        if (existing) {
          const dlv = await deliveries.byOrderId(input.order.id);
          return { assignment: existing, deliveryId: dlv?.id ?? '', reused: true };
        }
      }

      const fresh = await orders.byId(input.order.id);
      if (!fresh) throw conflict('order vanished');
      if (['assigned', 'picked_up', 'delivering'].includes(fresh.status)) {
        const active = await assignments.activeForOrder(fresh.id);
        if (active) return { assignment: active, deliveryId: (await deliveries.byOrderId(fresh.id))?.id ?? '', reused: true };
      }
      if (!['validated', 'dispatching'].includes(fresh.status)) {
        throw conflict(`order ${fresh.id} is ${fresh.status}, cannot assign`);
      }

      const driver = await drivers.byId(input.driverId);
      if (!driver) throw conflict('driver vanished');
      if (driver.status === 'offline' || driver.status === 'break') throw conflict('driver became unavailable');
      if (driver.capacity - driver.current_order_count < 1) throw conflict('driver became full');

      // ---- claim the order (compare-and-set + row lock). Losing races throw here. ----
      await orders.setStatus(input.order.id, 'assigned', ['validated', 'dispatching']);

      const delivery = await deliveries.ensure(input.order.id);
      if (!['pending', 'failed', 'cancelled'].includes(delivery.status)) {
        throw conflict(`delivery already ${delivery.status}`);
      }

      const assignment = await assignments.create({
        orderId: input.order.id,
        driverId: input.driverId,
        score: input.score,
        reasoning: input.reasoning,
        idempotencyKey: input.idempotencyKey ?? null,
        status: 'active',
      });

      const est = input.estimate;
      const route = await routes.create({
        deliveryId: delivery.id,
        driverId: input.driverId,
        originLat: driver.lat as number,
        originLng: driver.lng as number,
        legs: {
          toPickup: { etaMinutes: est.toPickup.etaMinutes, distanceKm: est.toPickup.distanceKm },
          handlingMinutes: est.handlingMinutes,
          toDropoff: { etaMinutes: est.toDropoff.etaMinutes, distanceKm: est.toDropoff.distanceKm },
        },
        path: { toPickup: est.toPickup.path, toDropoff: est.toDropoff.path },
        distanceKm: est.totalDistanceKm,
        etaMinutes: est.totalMinutes,
        trafficPenalty: Number((est.toPickup.trafficPenaltyMinutes + est.toDropoff.trafficPenaltyMinutes).toFixed(1)),
      });

      await deliveries.setStatus(
        delivery.id, 'assigned',
        delivery.status === 'pending' ? 'pending' : ['failed', 'cancelled'],
      );
      await deliveries.update(delivery.id, {
        driver_id: input.driverId,
        assigned_at: nowIso(),
        estimated_delivery_minutes: est.totalMinutes,
        eta_ts: minutesFromNow(est.totalMinutes),
        route_id: route.id,
      });

      await drivers.adjustOrderCount(input.driverId, 1);
      await drivers.setStatus(input.driverId, 'on_route');

      return { assignment, deliveryId: delivery.id, reused: false };
    });
  },

  async notify_driver(driverId: string, orderId: string, deliveryId: string, cycleId: string, eta: number) {
    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'driver_notified', orderId, deliveryId, driverId,
      message: `Notified driver ${driverId} of assignment for order ${orderId} — ETA ${eta} min. Awaiting acceptance.`,
    });
  },

  /** Detach the current driver so the order can be re-dispatched. */
  async reassign_order(orderId: string, reason: string, cycleId: string): Promise<{ previousDriverId: string | null }> {
    const previous = await dispatchTools.cancel_assignment(orderId, reason, cycleId);
    return { previousDriverId: previous?.driver_id ?? null };
  },

  /** Cancel the active assignment for an order and roll back driver load.
   *  Refuses to touch a delivery that is already terminal. */
  async cancel_assignment(orderId: string, reason: string, cycleId: string): Promise<AssignmentRow | undefined> {
    return tx(async () => {
      const delivery = await deliveries.byOrderId(orderId);
      if (delivery && ['delivered', 'cancelled'].includes(delivery.status)) {
        throw conflict(`cannot cancel a ${delivery.status} delivery`);
      }
      const active = await assignments.activeForOrder(orderId);
      await assignments.cancel(orderId);
      if (active) await drivers.adjustOrderCount(active.driver_id, -1);
      if (delivery && active) {
        const remaining = (await deliveries.byDriver(active.driver_id))
          .filter((d) => d.id !== delivery.id && !['delivered', 'cancelled', 'failed'].includes(d.status));
        if (remaining.length === 0) await drivers.setStatus(active.driver_id, 'available');
      }
      await emitAgentEvent({
        cycleId, agent: NAME, eventType: 'assignment_cancelled', orderId, deliveryId: delivery?.id ?? null,
        driverId: active?.driver_id ?? null, message: `Cancelled assignment for order ${orderId}: ${reason}`,
      });
      return active;
    });
  },
};

export interface DispatchDecision {
  assigned: boolean;
  driverId?: string;
  deliveryId?: string;
  score?: number;
  ranked: ScoreBreakdown[];
  rationale: string;
  reused?: boolean;
}

export const dispatchAgent = {
  name: NAME,
  tools: dispatchTools,

  /** Evaluate every routed candidate with the deterministic scorer, compare,
   *  and assign the best driver. Produces an explainable decision. */
  async evaluateAndAssign(
    order: OrderRow, routed: RoutedCandidate[], cycleId: string, opts: { idempotencyKey?: string | null } = {},
  ): Promise<DispatchDecision> {
    if (routed.length === 0) {
      await emitAgentEvent({
        cycleId, agent: NAME, eventType: 'assignment_failed', orderId: order.id,
        message: `No candidate drivers to evaluate for order ${order.id}`,
      });
      return { assigned: false, ranked: [], rationale: 'no candidates' };
    }

    const breakdowns = routed.map(({ candidate, estimate }) => dispatchTools.score_driver(
      {
        orderId: order.id,
        packageSize: order.package_size,
        volume: order.volume,
        priority: order.priority,
        deadlineTs: order.deadline_ts,
      },
      {
        driverId: candidate.driver.id,
        name: candidate.driver.name,
        status: candidate.driver.status,
        vehicleType: candidate.driver.vehicle_type,
        maxPackageSize: candidate.driver.max_package_size,
        capacity: candidate.driver.capacity,
        currentOrderCount: candidate.driver.current_order_count,
      },
      estimate,
    ));

    const comparison = dispatchTools.compare_assignments(breakdowns);

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'candidates_evaluated', orderId: order.id,
      message: `Evaluated ${breakdowns.length} candidates for order ${order.id}: `
        + comparison.ranked.map((b) => `${b.driverId}=${b.eligible ? b.score : 'X'}`).join(', '),
      data: { ranked: comparison.ranked },
    });

    if (!comparison.winner) {
      await emitAgentEvent({
        cycleId, agent: NAME, eventType: 'assignment_failed', orderId: order.id,
        message: `No eligible driver for order ${order.id}: ${comparison.rationale}`,
        data: { ranked: comparison.ranked },
      });
      return { assigned: false, ranked: comparison.ranked, rationale: comparison.rationale };
    }

    const winnerRouted = routed.find((r) => r.candidate.driver.id === comparison.winner!.driverId)!;
    const reasoning = {
      selected: comparison.winner.driverId,
      score: comparison.winner.score,
      margin: comparison.margin,
      factors: comparison.winner.factors,
      contributions: comparison.winner.contributions,
      explanation: comparison.winner.explanation,
      rationale: comparison.rationale,
      rejected: comparison.ranked.filter((b) => !b.eligible).map((b) => ({ driverId: b.driverId, disqualifiers: b.disqualifiers })),
    };

    let result: Awaited<ReturnType<typeof dispatchTools.assign_order>>;
    try {
      result = await dispatchTools.assign_order({
        order,
        driverId: comparison.winner.driverId,
        score: comparison.winner.score,
        reasoning,
        estimate: winnerRouted.estimate,
        idempotencyKey: opts.idempotencyKey ?? null,
        cycleId,
      });
    } catch (err) {
      await emitAgentEvent({
        cycleId, agent: NAME, eventType: 'assignment_conflict', orderId: order.id,
        message: `Assignment blocked: ${(err as Error).message}`,
      });
      return { assigned: false, ranked: comparison.ranked, rationale: (err as Error).message };
    }

    const winner = comparison.winner;
    const nameById = new Map(routed.map((r) => [r.candidate.driver.id, r.candidate.driver.name]));
    const nameOf = (idv: string) => nameById.get(idv) ?? idv;
    const orderCode = `#${order.id.replace(/^ord_/, '').slice(-6).toUpperCase()}`;

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: result.reused ? 'assignment_reused' : 'driver_assigned',
      orderId: order.id, deliveryId: result.deliveryId, driverId: winner.driverId,
      message: result.reused
        ? `Assignment for ${orderCode} already in place (idempotent) → ${nameOf(winner.driverId)}`
        : `Selected ${nameOf(winner.driverId)} for ${orderCode} — score ${winner.score}. ` + winner.explanation.join(' · '),
      data: reasoning,
    });

    // LLM writes the human explanation as a follow-up so it never delays the
    // assignment itself. Deterministic content is already on the event above.
    if (!result.reused) {
      const runnerUp = comparison.ranked.filter((b) => b.eligible && b.driverId !== winner.driverId)[0];
      void explainAssignment({
        orderCode,
        winner: { name: nameOf(winner.driverId), score: winner.score, factors: winner.factors as unknown as Record<string, unknown>, contributions: winner.contributions },
        runnerUp: runnerUp ? { name: nameOf(runnerUp.driverId), score: runnerUp.score } : null,
        rejected: comparison.ranked.filter((b) => !b.eligible).map((b) => ({ name: nameOf(b.driverId), reasons: b.disqualifiers })),
      }).then(async (ex) => {
        if (ex.source === 'llm') {
          await emitAgentEvent({
            cycleId, agent: NAME, eventType: 'assignment_explained', orderId: order.id, deliveryId: result.deliveryId, driverId: winner.driverId,
            message: ex.text, data: { source: 'llm' },
          });
        }
      }).catch(() => undefined);

      await dispatchTools.notify_driver(winner.driverId, order.id, result.deliveryId, cycleId, winner.factors.totalDeliveryMin);
    }

    return {
      assigned: true,
      driverId: winner.driverId,
      deliveryId: result.deliveryId,
      score: winner.score,
      ranked: comparison.ranked,
      rationale: comparison.rationale,
      reused: result.reused,
    };
  },
};
