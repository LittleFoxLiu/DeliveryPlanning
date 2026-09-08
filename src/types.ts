export type Role = 'admin' | 'merchant' | 'driver' | 'customer';

export interface User { id: string; email: string; role: Role; name: string; refId: string | null }

export interface Point { x: number; y: number }

export interface RoadSeg { id: string; ax: number; ay: number; bx: number; by: number; status: 'clear' | 'moderate' | 'heavy' | 'closed'; delay: number }

export interface AgentEvent {
  id: number; ts: string; agent: string; eventType?: string; event_type?: string;
  message: string; orderId?: string | null; order_id?: string | null; data?: unknown;
}

export interface OrderDto {
  id: string; code: string; status: string; priority: string; packageSize: string; volume: number;
  deadlineTs: string; note: string | null; pickup: Point; dropoff: Point;
  merchantId?: string; storeId?: string; storeName?: string | null;
  customerId?: string; customerName: string;
  items: { name: string; qty: number }[]; createdAt?: string; readyAt?: string | null;
  delivery?: DeliveryDto | null;
}

export interface DeliveryDto {
  id: string; orderId: string; driverId: string | null; status: string;
  assignedAt: string | null; pickupAt: string | null; deliveredAt: string | null;
  estimatedDeliveryMinutes: number | null; actualDeliveryMinutes: number | null;
  etaTs: string | null; routeId: string | null; route?: RouteDto | null;
}

export interface RouteDto {
  id: string; origin: Point; distanceKm: number; etaMinutes: number; trafficPenaltyMinutes: number;
  legs: unknown; path: { toPickup?: Point[]; toDropoff?: Point[] };
}

export interface DriverDto {
  id: string; name: string; vehicleType: string; capacity: number; maxPackageSize: string;
  status: string; currentOrderCount: number; location: Point | null; locationAt: string | null;
}
