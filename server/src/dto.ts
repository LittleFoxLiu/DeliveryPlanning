import {
  orders, deliveries, drivers, routes, assignments,
  type OrderRow, type DeliveryRow, type DriverFull,
} from './repo.js';
import { listEvents } from './events.js';

export function orderView(o: OrderRow) {
  return {
    id: o.id,
    merchantId: o.merchant_id,
    storeId: o.store_id,
    customerId: o.customer_id,
    status: o.status,
    priority: o.priority,
    packageSize: o.package_size,
    volume: o.volume,
    deadlineTs: o.deadline_ts,
    note: o.note,
    pickup: { x: o.pickup_lat, y: o.pickup_lng },
    dropoff: { x: o.delivery_lat, y: o.delivery_lng },
    createdAt: o.created_at,
    readyAt: o.ready_at,
    items: orders.items(o.id),
  };
}

export function deliveryView(d: DeliveryRow) {
  return {
    id: d.id,
    orderId: d.order_id,
    driverId: d.driver_id,
    status: d.status,
    assignedAt: d.assigned_at,
    pickupAt: d.pickup_at,
    deliveredAt: d.delivered_at,
    estimatedDeliveryMinutes: d.estimated_delivery_minutes,
    actualDeliveryMinutes: d.actual_delivery_minutes,
    etaTs: d.eta_ts,
    routeId: d.route_id,
  };
}

export function activeRouteView(deliveryId: string) {
  const route = routes.activeForDelivery(deliveryId);
  if (!route) return null;
  return {
    id: route.id,
    origin: { x: route.origin_lat, y: route.origin_lng },
    distanceKm: route.distance_km,
    etaMinutes: route.eta_minutes,
    trafficPenaltyMinutes: route.traffic_penalty_minutes,
    legs: JSON.parse(route.legs_json),
    path: JSON.parse(route.path_json),
    createdAt: route.created_at,
  };
}

/** Full driver record — admin / dispatch only. */
export function driverAdminView(d: DriverFull) {
  return {
    id: d.id,
    name: d.name,
    vehicleType: d.vehicle_type,
    capacity: d.capacity,
    maxPackageSize: d.max_package_size,
    status: d.status,
    currentOrderCount: d.current_order_count,
    location: d.lat != null ? { x: d.lat, y: d.lng } : null,
    locationAt: d.location_at,
  };
}

/** Minimal driver info safe to show a customer tracking their order. */
export function driverPublicView(d: DriverFull | undefined) {
  if (!d) return null;
  return {
    firstName: d.name.split(' ')[0],
    vehicleType: d.vehicle_type,
  };
}

export function assignmentReasoningView(orderId: string) {
  const list = assignments.forOrder(orderId);
  return list.map((a) => ({
    id: a.id,
    driverId: a.driver_id,
    status: a.status,
    score: a.score,
    createdAt: a.created_at,
    reasoning: JSON.parse(a.reasoning_json),
  }));
}

export function orderTrackingView(o: OrderRow) {
  const delivery = deliveries.byOrderId(o.id);
  const driver = delivery?.driver_id ? drivers.byId(delivery.driver_id) : undefined;
  return {
    order: {
      id: o.id, status: o.status, priority: o.priority, deadlineTs: o.deadline_ts,
      dropoff: { x: o.delivery_lat, y: o.delivery_lng }, items: orders.items(o.id),
    },
    delivery: delivery
      ? {
        status: delivery.status,
        etaTs: delivery.eta_ts,
        estimatedDeliveryMinutes: delivery.estimated_delivery_minutes,
        pickupAt: delivery.pickup_at,
        deliveredAt: delivery.delivered_at,
        driver: driverPublicView(driver),
        driverPosition: driver && driver.lat != null && ['en_route_pickup', 'picked_up', 'en_route_drop'].includes(delivery.status)
          ? { x: driver.lat, y: driver.lng } : null,
      }
      : null,
    events: listEvents({ orderId: o.id, limit: 40 })
      .filter((e) => e.eventType !== 'candidates_evaluated')
      .map((e) => ({ ts: e.ts, agent: e.agent, message: e.message })),
  };
}
