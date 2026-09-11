export interface Geo { lat: number; lon: number }

/**
 * The route polyline as it should be drawn *right now*: from the driver's live
 * position to the destination, with the already-travelled portion trimmed off.
 * `nodes` are the stored OSRM route points; `from` is the driver's current
 * position (omit it to draw the whole route).
 */
export function routeFromHere(
  nodes: Geo[],
  from: Geo | null | undefined,
): [number, number][] {
  const latlngs = nodes
    .filter((n) => Number.isFinite(n.lat) && Number.isFinite(n.lon))
    .map((n) => [n.lat, n.lon] as [number, number]);
  if (!from || !Number.isFinite(from.lat) || !Number.isFinite(from.lon) || latlngs.length < 2) return latlngs;
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < latlngs.length; i++) {
    const d = (latlngs[i][0] - from.lat) ** 2 + (latlngs[i][1] - from.lon) ** 2;
    if (d < best) { best = d; idx = i; }
  }
  return [[from.lat, from.lon], ...latlngs.slice(idx)];
}
