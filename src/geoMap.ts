import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Vite does not automatically resolve Leaflet's runtime icon URLs. Without
// these explicit URLs the marker position works, but the pin image is blank.
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

export interface GeoPoint { lat: number; lon: number; name?: string; district?: string; address?: string | null }
export interface GeoRoute { distanceKm: number; durationMinutes: number; geometry: [number, number][] }

const nominatimUrl = import.meta.env.VITE_NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const nominatimReverseUrl = import.meta.env.VITE_NOMINATIM_REVERSE_URL || nominatimUrl.replace(/\/search\/?$/, '/reverse');
const routingUrl = import.meta.env.VITE_ROUTING_URL || 'https://router.project-osrm.org/route/v1/driving';
export const SINGAPORE_BOUNDS: L.LatLngBoundsExpression = [[1.22, 103.60], [1.48, 104.05]];
const singaporeBounds = L.latLngBounds(SINGAPORE_BOUNDS);
const icons: Record<string, L.DivIcon> = {
  Driver: L.divIcon({ className: 'geo-pin-wrap', html: '<span class="geo-pin" aria-hidden="true">🚚</span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
  Pickup: L.divIcon({ className: 'geo-pin-wrap', html: '<span class="geo-pin" aria-hidden="true">🏪</span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
  'Drop-off': L.divIcon({ className: 'geo-pin-wrap', html: '<span class="geo-pin" aria-hidden="true">📍</span>', iconSize: [30, 30], iconAnchor: [15, 30] }),
};
const iconFor = (kind?: string) => icons[kind || ''] || icons['Drop-off'];
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c] as string));
const inSingapore = (point: { lat: number; lon: number }) => singaporeBounds.contains([point.lat, point.lon]);
const inScopePaths = (path: [number, number][]) => {
  const segments: [number, number][][] = [];
  let segment: [number, number][] = [];
  for (const point of path) {
    if (singaporeBounds.contains(point)) segment.push(point);
    else {
      if (segment.length > 1) segments.push(segment);
      segment = [];
    }
  }
  if (segment.length > 1) segments.push(segment);
  return segments;
};

const TIP_OPTS: L.TooltipOptions = { direction: 'top', offset: [0, -12], opacity: 1, className: 'geo-tip' };
const LINE_TIP_OPTS: L.TooltipOptions = { sticky: true, opacity: 1, className: 'geo-tip' };
/** Show marker/road info on hover, not on click. */
function hoverInfo<T extends L.Layer>(layer: T, content: string, sticky = false): T {
  layer.bindTooltip(content, sticky ? LINE_TIP_OPTS : TIP_OPTS);
  return layer;
}

// Stable color per road so the same delivery always draws the same color
// across re-renders, and different deliveries are easy to tell apart.
const ROAD_PALETTE = ['#159c99', '#df553d', '#7c5cbf', '#d69c1e', '#3577d1', '#c23b7a', '#1f9e4c', '#a1521a'];
export function colorForRoad(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return ROAD_PALETTE[h % ROAD_PALETTE.length];
}

const TILE_URL = import.meta.env.VITE_MAP_PROVIDER_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_OPTS: L.TileLayerOptions = { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 };

interface LiveMap {
  map: L.Map; overlay: L.LayerGroup; fitted: boolean;
  onSelect?: (p: GeoPoint) => void; clickBound?: boolean;
}
/** One persistent Leaflet instance per DOM node — survives view re-renders. */
const LIVE = new WeakMap<HTMLElement, LiveMap>();

/** Get-or-create the map for a container. `patchView` keeps the node ([data-keep])
 *  so on a re-render we reuse the instance and only swap the overlay layers —
 *  no tile reload, no flicker, and the user's pan/zoom is preserved. */
function liveMap(container: HTMLElement, opts?: L.MapOptions): LiveMap {
  const existing = LIVE.get(container);
  if (existing && container.isConnected) {
    existing.map.invalidateSize();
    return existing;
  }
  existing?.map.remove();
  const map = L.map(container, { maxBounds: SINGAPORE_BOUNDS, maxBoundsViscosity: 1, minZoom: 11, maxZoom: 19, ...opts });
  L.tileLayer(TILE_URL, TILE_OPTS).addTo(map);
  const overlay = L.layerGroup().addTo(map);
  const entry: LiveMap = { map, overlay, fitted: false };
  LIVE.set(container, entry);
  if (opts?.center && opts.zoom !== undefined) map.setView(opts.center, opts.zoom);
  return entry;
}

interface MarkerPoint { lat: number; lon: number; kind: string; name: string; detail?: string; address?: string | null }

/** A route segment drawn on the map — hoverable, optionally clickable, and
 *  colored distinctly so several deliveries are easy to tell apart. */
export interface RoadInfo {
  coords: [number, number][];
  color?: string;
  label: string;
  detail?: string;
  /** Rich HTML shown in a click-to-open popup (e.g. order info + an Accept button). */
  popupHtml?: string;
  onClick?: () => void;
}

function roadsInScope(roads: RoadInfo[]): RoadInfo[] {
  const out: RoadInfo[] = [];
  for (const r of roads) for (const seg of inScopePaths(r.coords)) out.push({ ...r, coords: seg });
  return out;
}

/** Replace the markers + roads on a live map without touching the base map. */
function drawOverlay(entry: LiveMap, points: MarkerPoint[], roads: RoadInfo[], fitZoom = 15): void {
  entry.overlay.clearLayers();
  const layers: L.Layer[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const address = p.address && p.address !== p.name ? `<br>${html(p.address)}` : '';
    const m = hoverInfo(
      L.marker([p.lat, p.lon], { icon: iconFor(p.kind) }),
      `<strong>${html(p.kind)}</strong><br>${html(p.name)}${address}${p.detail ? `<br><small>${html(p.detail)}</small>` : ''}`,
    );
    m.addTo(entry.overlay);
    layers.push(m);
  }
  for (const r of roadsInScope(roads)) {
    if (r.coords.length < 2) continue;
    const line = L.polyline(r.coords, { color: r.color || '#159c99', weight: 6, opacity: .85 });
    hoverInfo(line, `<strong>${html(r.label)}</strong>${r.detail ? `<br>${html(r.detail)}` : ''}`, true);
    if (r.popupHtml) line.bindPopup(r.popupHtml, { maxWidth: 260, className: 'geo-popup' });
    if (r.onClick) { const cb = r.onClick; line.on('click', () => cb()); }
    line.addTo(entry.overlay);
    layers.push(line);
  }
  // Fit to content only on the first paint — later updates keep the user's view.
  if (!entry.fitted && layers.length > 1) {
    entry.map.fitBounds(L.featureGroup(layers).getBounds(), { padding: [35, 35], maxZoom: fitZoom });
    entry.fitted = true;
  } else if (!entry.fitted && !layers.length) {
    entry.map.setView([1.3521, 103.8198], 12);
    entry.fitted = true;
  } else if (!entry.fitted) {
    entry.fitted = true;
  }
}

function destroy(container: HTMLElement): void {
  const e = LIVE.get(container);
  if (e) { e.map.remove(); LIVE.delete(container); }
}

// When patchView discards a kept map node (view navigated away), tear it down.
document.addEventListener('dp:keep-dropped', (ev) => {
  const node = (ev as CustomEvent).detail as HTMLElement | null;
  if (node && LIVE.has(node)) destroy(node);
});

export async function searchNominatim(query: string, signal?: AbortSignal): Promise<GeoPoint[]> {
  if (query.trim().length < 3) return [];
  const params = new URLSearchParams({
    q: `${query}, Singapore`, format: 'jsonv2', limit: '5', countrycodes: 'sg', addressdetails: '1',
    viewbox: '103.60,1.48,104.05,1.22', bounded: '1',
  });
  const response = await fetch(`${nominatimUrl}?${params}`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Nominatim search is temporarily unavailable.');
  const data = await response.json() as Array<{ place_id: number; display_name: string; lat: string; lon: string; address?: Record<string, string> }>;
  return data
    .map((item) => ({
      id: `nominatim-${item.place_id}`,
      name: item.display_name.split(',')[0]?.trim() || item.display_name,
      address: item.display_name,
      district: item.address?.suburb || item.address?.neighbourhood || item.address?.city_district,
      lat: Number(item.lat), lon: Number(item.lon),
    } as GeoPoint & { id: string }))
    .filter((point, index) => singaporeBounds.contains([point.lat, point.lon])
      && data[index]?.address?.country_code?.toLowerCase() === 'sg');
}

/** Resolve a map click through Nominatim before it can be stored. */
export async function reverseNominatim(lat: number, lon: number, signal?: AbortSignal): Promise<GeoPoint> {
  if (!singaporeBounds.contains([lat, lon])) throw new Error('The selected location must be within Singapore.');
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon), format: 'jsonv2', addressdetails: '1' });
  const response = await fetch(`${nominatimReverseUrl}?${params}`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Nominatim reverse geocoding is temporarily unavailable.');
  const item = await response.json() as { display_name?: string; lat?: string; lon?: string; address?: Record<string, string> };
  const resolvedLat = Number(item.lat ?? lat);
  const resolvedLon = Number(item.lon ?? lon);
  if (!item.display_name || item.address?.country_code?.toLowerCase() !== 'sg' || !singaporeBounds.contains([resolvedLat, resolvedLon])) {
    throw new Error('Nominatim returned no Singapore address.');
  }
  return {
    lat: resolvedLat,
    lon: resolvedLon,
    name: item.display_name.split(',')[0]?.trim() || item.display_name,
    address: item.display_name,
    district: item.address?.suburb || item.address?.neighbourhood || item.address?.city_district,
  };
}

export async function routeWithOsrm(start: GeoPoint, end: GeoPoint, signal?: AbortSignal): Promise<GeoRoute> {
  if (!singaporeBounds.contains([start.lat, start.lon]) || !singaporeBounds.contains([end.lat, end.lon])) {
    throw new Error('Both locations must be within Singapore.');
  }
  const response = await fetch(`${routingUrl}/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson`, { signal });
  if (!response.ok) throw new Error('The road routing service is unavailable.');
  const data = await response.json() as { code?: string; routes?: Array<{ distance: number; duration: number; geometry?: { coordinates?: [number, number][] } }> };
  const route = data.routes?.[0];
  const coordinates = route?.geometry?.coordinates;
  if (!route || !coordinates?.length || (data.code && data.code !== 'Ok')) throw new Error('No drivable route was found between these points.');
  const geometry = coordinates
    .map(([lon, lat]) => [lat, lon] as [number, number]);
  if (geometry.length < 2 || geometry.some(([lat, lon]) => !singaporeBounds.contains([lat, lon]))) {
    throw new Error('OSRM returned a route outside Singapore.');
  }
  return {
    distanceKm: route.distance / 1000,
    durationMinutes: route.duration / 60,
    geometry,
  };
}

/** Open the same Nominatim/Leaflet picker in a separate browser window. */
export function openLocationPicker(initial: GeoPoint | null, onSelect: (point: GeoPoint) => void): void {
  const popup = window.open('', 'delivery-location-picker', 'popup,width=900,height=700');
  if (!popup) { window.alert('Please allow pop-ups to choose a location on the map.'); return; }
  const safeInitial = initial && inSingapore(initial) ? initial : null;
  const start = safeInitial ? `[${safeInitial.lat},${safeInitial.lon}]` : '[1.295,103.855]';
  const boundsLiteral = '[[1.22,103.60],[1.48,104.05]]';
  const searchUrlLiteral = JSON.stringify(nominatimUrl);
  const reverseUrlLiteral = JSON.stringify(nominatimReverseUrl);
  popup.document.write(`<!doctype html><title>Choose delivery location</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><style>body{margin:0;font:14px sans-serif}#search{width:calc(100% - 24px);margin:12px;padding:10px;box-sizing:border-box}#map{height:calc(100vh - 60px)}.hint{position:fixed;z-index:1000;top:54px;left:12px;background:#fff;padding:8px;box-shadow:0 1px 5px #777}</style><input id="search" placeholder="Search with Nominatim"><div class="hint">Click the map to select a location</div><div id="map"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script><script>
  const singaporeBounds=L.latLngBounds(${boundsLiteral}); const searchUrl=${searchUrlLiteral}; const reverseUrl=${reverseUrlLiteral}; const map=L.map('map',{maxBounds:singaporeBounds,maxBoundsViscosity:1,minZoom:11,maxZoom:19}).setView(${start},13); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors',maxZoom:19}).addTo(map); let marker;
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  async function choose(lat,lon,name,address){if(!singaporeBounds.contains([lat,lon]))return;if(!address){const r=await fetch(reverseUrl+'?format=jsonv2&addressdetails=1&lat='+lat+'&lon='+lon);if(!r.ok)return;const p=await r.json();if(p.address?.country_code?.toLowerCase()!=='sg')return;lat=Number(p.lat??lat);lon=Number(p.lon??lon);address=p.display_name;if(!address||!singaporeBounds.contains([lat,lon]))return;name=p.display_name.split(',')[0];}if(marker)marker.remove();marker=L.marker([lat,lon]).addTo(map).bindPopup(escapeHtml(name)+'<br><small>'+escapeHtml(address)+'</small>').openPopup();window.opener.postMessage({type:'location-selected',point:{lat,lon,name,address}},window.location.origin);}
  map.on('click',e=>choose(e.latlng.lat,e.latlng.lng,'Dropped map pin','')); document.getElementById('search').addEventListener('change',async e=>{const q=e.target.value.trim();if(q.length<3)return;const r=await fetch(searchUrl+'?format=jsonv2&limit=5&addressdetails=1&countrycodes=sg&bounded=1&viewbox=103.60,1.48,104.05,1.22&q='+encodeURIComponent(q+', Singapore'));const places=await r.json();if(places[0]){const p=places[0];if(p.address?.country_code?.toLowerCase()!=='sg')return;const lat=+p.lat,lon=+p.lon;if(!singaporeBounds.contains([lat,lon]))return;map.setView([lat,lon],16);choose(lat,lon,p.display_name.split(',')[0],p.display_name);}});
<\/script>`);
  popup.document.close();
  const receive = (event: MessageEvent) => { const point = event.data?.point; if (event.origin === window.location.origin && event.source === popup && event.data?.type === 'location-selected' && point && typeof point.lat === 'number' && typeof point.lon === 'number' && inSingapore(point) && typeof point.address === 'string' && point.address.length > 0) { onSelect(point as GeoPoint); window.removeEventListener('message', receive); popup.close(); } };
  window.addEventListener('message', receive);
}

/** Click-to-pick location map. Idempotent — keeps the instance (and the user's
 *  pan) across re-renders while re-binding the current callback / marker. */
export function mountLocationMap(container: HTMLElement, initial: GeoPoint | null, onSelect: (point: GeoPoint) => void, route: GeoRoute | null = null): void {
  const safeInitial = initial && inSingapore(initial) ? initial : null;
  const entry = liveMap(container, { center: safeInitial ? [safeInitial.lat, safeInitial.lon] : [1.295, 103.855], zoom: 13 });
  const map = entry.map;
  if (entry.clickHandler) map.off('click', entry.clickHandler);
  const select = (point: GeoPoint) => {
    if (!singaporeBounds.contains([point.lat, point.lon])) return;
    entry.overlay.clearLayers();
    const marker = L.marker([point.lat, point.lon], { icon: iconFor('Drop-off') })
      .addTo(entry.overlay)
      .bindPopup(`<strong>${html(point.address || point.name || 'Selected Singapore location')}</strong><br><small>${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}</small>`);
    marker.openPopup();
    onSelect(point);
  };
  const clickHandler = async (event: L.LeafletMouseEvent) => {
    try { select(await reverseNominatim(event.latlng.lat, event.latlng.lng)); } catch { /* wait for a valid Nominatim address */ }
  };
  entry.clickHandler = clickHandler;
  map.on('click', clickHandler);
  entry.overlay.clearLayers();
  const layers: L.Layer[] = [];
  if (safeInitial) {
    layers.push(L.marker([safeInitial.lat, safeInitial.lon], { icon: iconFor('Drop-off') })
      .addTo(entry.overlay)
      .bindPopup(`<strong>${html(safeInitial.address || safeInitial.name || 'Selected Singapore location')}</strong><br><small>${safeInitial.lat.toFixed(6)}, ${safeInitial.lon.toFixed(6)}</small>`));
  }
  const routeGeometry = route && route.geometry.every((point) => singaporeBounds.contains(point)) ? route.geometry : [];
  if (routeGeometry.length > 1) layers.push(L.polyline(routeGeometry, { color: '#df553d', weight: 6, opacity: .9 }).addTo(entry.overlay));
  if (!entry.fitted && layers.length > 1) {
    map.fitBounds(L.featureGroup(layers).getBounds(), { padding: [35, 35], maxZoom: 15 });
    entry.fitted = true;
  } else if (!entry.fitted) {
    entry.fitted = true;
  }
  return () => destroy(container);
}

export function mountOverviewMap(container: HTMLElement, points: Array<GeoPoint & { kind: string; detail?: string }>, paths: Array<[number, number][]> = []): () => void {
  const scopedPoints = points.filter(inSingapore);
  const user = scopedPoints.find((point) => point.kind === 'Driver');
  const entry = liveMap(container, { center: user ? [user.lat, user.lon] : [1.295, 103.855], zoom: user ? 14 : 13 });
  drawOverlay(entry, scopedPoints as MarkerPoint[], paths, 15);
  return () => destroy(container);
}

/** Driver / customer route map. Idempotent — same instance across re-renders,
 *  so the driver pin just moves instead of the whole map reloading. */
export function mountRouteMap(
  container: HTMLElement,
  points: MarkerPoint[],
  paths: Array<[number, number][]>,
): () => void {
  const scopedPoints = points.filter(inSingapore);
  const driver = scopedPoints.find((point) => point.kind === 'Driver');
  const entry = liveMap(container, { center: driver ? [driver.lat, driver.lon] : [1.3521, 103.8198], zoom: driver ? 14 : 12 });
  drawOverlay(entry, scopedPoints, paths, 15);
  return () => destroy(container);
}
