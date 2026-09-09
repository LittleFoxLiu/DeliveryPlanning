import { config } from '../config.js';

export interface Point { x: number; y: number }
export type RoadStatus = 'clear' | 'moderate' | 'heavy' | 'closed';
export interface Segment { id?: string; ax: number; ay: number; bx: number; by: number; status: RoadStatus; delay_minutes: number }

export interface RouteResult {
  path: Point[];
  distanceKm: number;
  etaMinutes: number;
  baselineMinutes: number;
  trafficPenaltyMinutes: number;
  reachable: boolean;
  blockedSegments: string[];
}

const SIZE = config.grid.size;
const BASE = config.grid.segmentBaseMinutes;
const KM = config.grid.kmPerSegment;
const HANDLING_MINUTES = 3;

const statusMultiplier: Record<RoadStatus, number> = { clear: 1, moderate: 2, heavy: 3, closed: Infinity };

const nodeKey = (x: number, y: number) => `${x},${y}`;
const segKey = (a: Point, b: Point) => {
  const [p, q] = [a, b].sort((m, n) => (m.x - n.x) || (m.y - n.y));
  return `${p.x},${p.y}-${q.x},${q.y}`;
};

export function snap(p: Point): Point {
  return {
    x: Math.max(0, Math.min(SIZE, Math.round(p.x))),
    y: Math.max(0, Math.min(SIZE, Math.round(p.y))),
  };
}

interface Edge { to: Point; minutes: number; baseline: number; key: string; blocked: boolean }

function buildAdjacency(segments: Segment[]): Map<string, Edge[]> {
  const byKey = new Map<string, Segment>();
  for (const s of segments) {
    byKey.set(segKey({ x: s.ax, y: s.ay }, { x: s.bx, y: s.by }), s);
  }
  const adj = new Map<string, Edge[]>();
  const add = (from: Point, to: Point) => {
    const key = segKey(from, to);
    const seg = byKey.get(key);
    const status: RoadStatus = seg ? seg.status : 'clear';
    const delay = seg ? seg.delay_minutes : 0;
    const mult = statusMultiplier[status];
    const minutes = status === 'closed' ? Infinity : BASE * mult + Math.max(0, delay);
    const edge: Edge = { to, minutes, baseline: BASE, key, blocked: status === 'closed' };
    if (!adj.has(nodeKey(from.x, from.y))) adj.set(nodeKey(from.x, from.y), []);
    adj.get(nodeKey(from.x, from.y))!.push(edge);
  };
  for (let x = 0; x <= SIZE; x++) {
    for (let y = 0; y <= SIZE; y++) {
      if (x < SIZE) { add({ x, y }, { x: x + 1, y }); add({ x: x + 1, y }, { x, y }); }
      if (y < SIZE) { add({ x, y }, { x, y: y + 1 }); add({ x, y: y + 1 }, { x, y }); }
    }
  }
  return adj;
}

/** Deterministic Dijkstra shortest-time path over the road grid. */
export function calculateRoute(fromRaw: Point, toRaw: Point, segments: Segment[]): RouteResult {
  const from = snap(fromRaw);
  const to = snap(toRaw);
  const adj = buildAdjacency(segments);

  const dist = new Map<string, number>();
  const prev = new Map<string, { node: string; key: string; blocked: boolean }>();
  const start = nodeKey(from.x, from.y);
  dist.set(start, 0);
  const visited = new Set<string>();
  const queue = new Set<string>([start]);

  while (queue.size) {
    let current = '';
    let best = Infinity;
    for (const n of queue) {
      const d = dist.get(n) ?? Infinity;
      if (d < best) { best = d; current = n; }
    }
    if (current === '') break;
    queue.delete(current);
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === nodeKey(to.x, to.y)) break;
    const [cx, cy] = current.split(',').map(Number);
    for (const edge of adj.get(current) ?? []) {
      if (!Number.isFinite(edge.minutes)) continue;
      const nk = nodeKey(edge.to.x, edge.to.y);
      if (visited.has(nk)) continue;
      const nd = (dist.get(current) ?? Infinity) + edge.minutes;
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, { node: current, key: edge.key, blocked: edge.blocked });
        queue.add(nk);
      }
      void cx; void cy;
    }
  }

  const target = nodeKey(to.x, to.y);
  // Ideal free-flow time: Manhattan distance at base cost. A route that beats
  // this is impossible; anything slower is congestion + detour penalty.
  const idealBaseline = (Math.abs(from.x - to.x) + Math.abs(from.y - to.y)) * BASE;
  if (!dist.has(target)) {
    return {
      path: [from], distanceKm: 0, etaMinutes: Infinity, baselineMinutes: idealBaseline,
      trafficPenaltyMinutes: 0, reachable: false, blockedSegments: detectBlocking(from, to, segments),
    };
  }

  const path: Point[] = [];
  let cur = target;
  const blocked: string[] = [];
  while (cur) {
    const [x, y] = cur.split(',').map(Number);
    path.unshift({ x, y });
    const p = prev.get(cur);
    if (!p) break;
    if (p.blocked) blocked.push(p.key);
    cur = p.node;
  }

  const eta = dist.get(target)!;
  const segCount = Math.max(0, path.length - 1);
  return {
    path,
    distanceKm: Number((segCount * KM).toFixed(2)),
    etaMinutes: Number(eta.toFixed(1)),
    baselineMinutes: Number(idealBaseline.toFixed(1)),
    trafficPenaltyMinutes: Number(Math.max(0, eta - idealBaseline).toFixed(1)),
    reachable: true,
    blockedSegments: blocked,
  };
}

function detectBlocking(from: Point, to: Point, segments: Segment[]): string[] {
  // Report closed segments in the bounding box of the trip as likely blockers.
  const minX = Math.min(from.x, to.x), maxX = Math.max(from.x, to.x);
  const minY = Math.min(from.y, to.y), maxY = Math.max(from.y, to.y);
  return segments
    .filter((s) => s.status === 'closed' && s.ax >= minX - 1 && s.bx <= maxX + 1 && s.ay >= minY - 1 && s.by <= maxY + 1)
    .map((s) => s.id ?? segKey({ x: s.ax, y: s.ay }, { x: s.bx, y: s.by }));
}

export function calculateDistance(from: Point, to: Point, segments: Segment[]): number {
  return calculateRoute(from, to, segments).distanceKm;
}

export function calculateEta(from: Point, to: Point, segments: Segment[]): number {
  return calculateRoute(from, to, segments).etaMinutes;
}

export interface DeliveryEstimate {
  toPickup: RouteResult;
  toDropoff: RouteResult;
  handlingMinutes: number;
  totalMinutes: number;
  totalDistanceKm: number;
  reachable: boolean;
}

/** Authoritative end-to-end delivery time: driver -> pickup -> customer. */
export function estimateDeliveryTime(
  driverLoc: Point, pickup: Point, dropoff: Point, segments: Segment[],
): DeliveryEstimate {
  const toPickup = calculateRoute(driverLoc, pickup, segments);
  const toDropoff = calculateRoute(pickup, dropoff, segments);
  const reachable = toPickup.reachable && toDropoff.reachable;
  const total = reachable ? toPickup.etaMinutes + HANDLING_MINUTES + toDropoff.etaMinutes : Infinity;
  return {
    toPickup,
    toDropoff,
    handlingMinutes: HANDLING_MINUTES,
    totalMinutes: reachable ? Number(total.toFixed(1)) : Infinity,
    totalDistanceKm: Number((toPickup.distanceKm + toDropoff.distanceKm).toFixed(2)),
    reachable,
  };
}

export interface RouteComparison {
  candidates: { label: string; etaMinutes: number; distanceKm: number; trafficPenaltyMinutes: number; reachable: boolean }[];
  best: string | null;
}

export function compareRoutes(named: { label: string; result: RouteResult }[]): RouteComparison {
  const candidates = named.map(({ label, result }) => ({
    label,
    etaMinutes: result.etaMinutes,
    distanceKm: result.distanceKm,
    trafficPenaltyMinutes: result.trafficPenaltyMinutes,
    reachable: result.reachable,
  }));
  const reachable = candidates.filter((c) => c.reachable);
  reachable.sort((a, b) => (a.distanceKm - b.distanceKm) || (a.etaMinutes - b.etaMinutes));
  return { candidates, best: reachable[0]?.label ?? null };
}

export function buildRoadGrid(): Segment[] {
  const out: Segment[] = [];
  for (let x = 0; x <= SIZE; x++) {
    for (let y = 0; y <= SIZE; y++) {
      if (x < SIZE) out.push({ ax: x, ay: y, bx: x + 1, by: y, status: 'clear', delay_minutes: 0 });
      if (y < SIZE) out.push({ ax: x, ay: y, bx: x, by: y + 1, status: 'clear', delay_minutes: 0 });
    }
  }
  return out;
}
