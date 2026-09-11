export type Role = 'admin' | 'merchant' | 'driver' | 'customer';

export interface User { id: string; email: string; role: Role; name: string; refId: string | null }

export interface GeoPoint { lat: number; lon: number }

export interface AgentEvent {
  id: number; ts: string; agent: string; eventType?: string; event_type?: string;
  message: string; orderId?: string | null; order_id?: string | null; data?: unknown;
}

export interface OrderItem { name: string; qty: number; productId?: string | null; unitPriceCents?: number }

export interface ProductDto {
  id: string; name: string; description: string | null;
  priceCents: number; packageSize: string; active: boolean;
}

export interface OrderDto {
  id: string; code: string; status: string; priority: string; packageSize: string; volume: number;
  deadlineTs: string; note: string | null; pickup: GeoPoint & { name?: string | null; address?: string | null }; dropoff: GeoPoint & { address?: string | null };
  merchantId?: string; storeId?: string; storeName?: string | null;
  customerId?: string; customerName: string;
  items: OrderItem[]; itemsTotalCents?: number; createdAt?: string; readyAt?: string | null;
  delivery?: DeliveryDto | null;
}

export interface DeliveryDto {
  id: string; orderId: string; driverId: string | null; status: string;
  assignedAt: string | null; pickupAt: string | null; deliveredAt: string | null;
  estimatedDeliveryMinutes: number | null; actualDeliveryMinutes: number | null;
  etaTs: string | null; routeId: string | null; route?: RouteDto | null;
}

export interface RouteDto {
  id: string; origin: GeoPoint; distanceKm: number; etaMinutes: number;
  legs: unknown; path: { toPickup?: GeoPoint[]; toDropoff?: GeoPoint[] };
}

export interface DriverDto {
  id: string; name: string; vehicleType: string; capacity: number; maxPackageSize: string;
  status: string; currentOrderCount: number; location: (GeoPoint & { address?: string | null }) | null; locationAt: string | null;
}
