import { drivers, deliveries, routes, type DriverFull, type OrderRow } from '../repo.js';
import { emitAgentEvent } from '../events.js';
import { sizeRank, vehicleCanCarry } from './compat.js';

const NAME = 'DriverAgent';

export const driverTools = {
  get_available_drivers: async (): Promise<DriverFull[]> => (await drivers.all()).filter((d) => d.status === 'available' || d.status === 'on_route'),
  get_all_drivers: (): Promise<DriverFull[]> => drivers.all(),
  get_driver_location: async (driverId: string) => {
    const d = await drivers.byId(driverId);
    return d && d.lat != null && d.lng != null ? { lat: d.lat, lng: d.lng, at: d.location_at } : undefined;
  },
  get_driver_status: async (driverId: string) => (await drivers.byId(driverId))?.status,
  get_driver_capacity: async (driverId: string) => {
    const d = await drivers.byId(driverId);
    return d ? { capacity: d.capacity, used: d.current_order_count, headroom: d.capacity - d.current_order_count } : undefined;
  },
  get_driver_vehicle: async (driverId: string) => {
    const d = await drivers.byId(driverId);
    return d ? { vehicleType: d.vehicle_type, maxPackageSize: d.max_package_size } : undefined;
  },
  get_driver_current_route: async (driverId: string) => {
    const active = (await deliveries.byDriver(driverId)).filter((x) => !['delivered', 'cancelled', 'failed'].includes(x.status));
    return Promise.all(active.map(async (dlv) => ({ deliveryId: dlv.id, orderId: dlv.order_id, status: dlv.status, route: dlv.route_id ? await routes.activeForDelivery(dlv.id) : null })));
  },
  update_driver_status: (driverId: string, status: 'available' | 'on_route' | 'break' | 'offline') => drivers.setStatus(driverId, status),
};

export interface Candidate {
  driver: DriverFull;
  location: { lat: number; lng: number };
  headroom: number;
  activeDeliveries: number;
}

export interface CandidateResult {
  candidates: Candidate[];
  rejected: { driverId: string; name: string; reasons: string[] }[];
}

export const driverAgent = {
  name: NAME,
  tools: driverTools,

  /** Decide which drivers are eligible for an order. Considers status, live
   *  location availability, capacity, vehicle compatibility, and current
   *  assignments. Does NOT consider "closest" — that is the Dispatch Agent's
   *  multi-factor decision. */
  async findCandidates(order: OrderRow, cycleId: string, excludeDriverIds: string[] = []): Promise<CandidateResult> {
    const all = await driverTools.get_all_drivers();
    const candidates: Candidate[] = [];
    const rejected: CandidateResult['rejected'] = [];

    for (const d of all) {
      const reasons: string[] = [];
      if (excludeDriverIds.includes(d.id)) reasons.push('excluded_by_coordinator');
      if (d.status === 'break') reasons.push('on_break');
      if (d.status === 'offline') reasons.push('offline');
      if (d.lat == null || d.lng == null) reasons.push('no_location_fix');
      const headroom = d.capacity - d.current_order_count;
      if (headroom < 1) reasons.push('at_capacity');
      if (!vehicleCanCarry(d.vehicle_type, d.max_package_size, order.package_size)) {
        reasons.push(`vehicle_${d.vehicle_type}_cannot_carry_${order.package_size}`);
      }
      const activeForDriver = (await driverTools.get_driver_current_route(d.id)).length;
      // Soft cap: a driver already juggling >= capacity active legs is skipped.
      if (activeForDriver >= d.capacity) reasons.push('too_many_active_legs');

      if (reasons.length === 0) {
        candidates.push({
          driver: d,
          location: { lat: d.lat as number, lng: d.lng as number },
          headroom,
          activeDeliveries: activeForDriver,
        });
      } else {
        rejected.push({ driverId: d.id, name: d.name, reasons });
      }
    }

    await emitAgentEvent({
      cycleId, agent: NAME, eventType: 'candidates_found', orderId: order.id,
      message: `Found ${candidates.length} eligible driver${candidates.length === 1 ? '' : 's'} `
        + `(${rejected.length} filtered out) for order ${order.id}`,
      data: {
        eligible: candidates.map((c) => ({ driverId: c.driver.id, name: c.driver.name, headroom: c.headroom })),
        rejected,
      },
    });
    return { candidates, rejected };
  },
};

export { sizeRank };
