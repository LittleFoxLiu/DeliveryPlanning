import { conflict } from '../util.js';

export type OrderStatus =
  | 'created' | 'ready' | 'validated' | 'dispatching' | 'assigned'
  | 'picked_up' | 'delivering' | 'delivered' | 'cancelled' | 'failed';

export type DeliveryStatus =
  | 'pending' | 'assigned' | 'en_route_pickup' | 'picked_up' | 'en_route_drop'
  | 'delivered' | 'cancelled' | 'failed';

const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  created: ['ready', 'cancelled'],
  ready: ['validated', 'cancelled', 'failed'],
  validated: ['dispatching', 'cancelled', 'failed'],
  dispatching: ['assigned', 'failed', 'cancelled', 'validated'],
  assigned: ['picked_up', 'delivering', 'dispatching', 'cancelled', 'failed'],
  picked_up: ['delivering', 'delivered', 'failed'],
  delivering: ['delivered', 'dispatching', 'failed'],
  delivered: [],
  cancelled: [],
  failed: ['dispatching'],
};

const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  pending: ['assigned', 'cancelled'],
  assigned: ['en_route_pickup', 'cancelled', 'failed'],
  en_route_pickup: ['picked_up', 'cancelled', 'failed'],
  picked_up: ['en_route_drop', 'delivered', 'failed'],
  en_route_drop: ['delivered', 'failed'],
  delivered: [],
  cancelled: [],
  failed: ['assigned'],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return from === to || (ORDER_TRANSITIONS[from]?.includes(to) ?? false);
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw conflict(`Illegal order transition ${from} → ${to}`);
  }
}

export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return from === to || (DELIVERY_TRANSITIONS[from]?.includes(to) ?? false);
}

export function assertDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!canTransitionDelivery(from, to)) {
    throw conflict(`Illegal delivery transition ${from} → ${to}`);
  }
}

export const TERMINAL_ORDER: OrderStatus[] = ['delivered', 'cancelled'];
export const TERMINAL_DELIVERY: DeliveryStatus[] = ['delivered', 'cancelled'];

export function isTerminalOrder(s: OrderStatus): boolean {
  return TERMINAL_ORDER.includes(s);
}
