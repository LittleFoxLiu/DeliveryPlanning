import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface GeoPoint { lat: number; lon: number; name: string; district?: string }
export interface GeoRoute { distanceKm: number; durationMinutes: number; geometry: [number, number][] }

const nominatimUrl = import.meta.env.VITE_NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const routingUrl = import.meta.env.VITE_ROUTING_URL || 'https://router.project-osrm.org/route/v1/driving';
const bounds: L.LatLngBoundsExpression = [[1.22, 103.74], [1.39, 104.02]];

export async function searchNominatim(query: string, signal?: AbortSignal): Promise<GeoPoint[]> {
  if (query.trim().length < 3) return [];
  const params = new URLSearchParams({ q: `${query}, Singapore`, format: 'jsonv2', limit: '5', countrycodes: 'sg', addressdetails: '1' });
  const response = await fetch(`${nominatimUrl}?${params}`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Nominatim search is temporarily unavailable.');
  const data = await response.json() as Array<{ place_id: number; display_name: string; lat: string; lon: string }>;
  return data.map((item) => ({ id: `nominatim-${item.place_id}`, name: item.display_name.split(',')[0], district: item.display_name.split(',')[1]?.trim(), lat: Number(item.lat), lon: Number(item.lon) } as GeoPoint & { id: string }));
}

export async function routeWithOsrm(start: GeoPoint, end: GeoPoint, signal?: AbortSignal): Promise<GeoRoute> {
  const response = await fetch(`${routingUrl}/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson`, { signal });
  if (!response.ok) throw new Error('The road routing service is unavailable.');
  const data = await response.json() as { routes?: Array<{ distance: number; duration: number; geometry: { coordinates: [number, number][] } }> };
  const route = data.routes?.[0];
  if (!route) throw new Error('No drivable route was found between these points.');
  return { distanceKm: route.distance / 1000, durationMinutes: route.duration / 60, geometry: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]) };
}

/** Open the same Nominatim/Leaflet picker in a separate browser window. */
export function openLocationPicker(initial: GeoPoint | null, onSelect: (point: GeoPoint) => void): void {
  const popup = window.open('', 'delivery-location-picker', 'popup,width=900,height=700');
  if (!popup) { window.alert('Please allow pop-ups to choose a location on the map.'); return; }
  const start = initial ? `[${initial.lat},${initial.lon}]` : '[1.295,103.855]';
  popup.document.write(`<!doctype html><title>Choose delivery location</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><style>body{margin:0;font:14px sans-serif}#search{width:calc(100% - 24px);margin:12px;padding:10px;box-sizing:border-box}#map{height:calc(100vh - 60px)}.hint{position:fixed;z-index:1000;top:54px;left:12px;background:#fff;padding:8px;box-shadow:0 1px 5px #777}</style><input id="search" placeholder="Search with Nominatim"><div class="hint">Click the map to select a location</div><div id="map"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script><script>
  const map=L.map('map').setView(${start},13); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map); let marker;
  function choose(lat,lon,name){if(marker)marker.remove();marker=L.marker([lat,lon]).addTo(map).bindPopup(name).openPopup();window.opener.postMessage({type:'location-selected',point:{lat,lon,name}},window.location.origin);}
  map.on('click',e=>choose(e.latlng.lat,e.latlng.lng,'Dropped map pin')); document.getElementById('search').addEventListener('change',async e=>{const q=e.target.value.trim();if(q.length<3)return;const r=await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=sg&q='+encodeURIComponent(q+', Singapore'));const places=await r.json();if(places[0]){const p=places[0];map.setView([+p.lat,+p.lon],16);choose(+p.lat,+p.lon,p.display_name.split(',')[0]);}});
<\/script>`);
  popup.document.close();
  const receive = (event: MessageEvent) => { if (event.source === popup && event.data?.type === 'location-selected') { onSelect(event.data.point as GeoPoint); window.removeEventListener('message', receive); popup.close(); } };
  window.addEventListener('message', receive);
}

export function mountLocationMap(container: HTMLElement, initial: GeoPoint | null, onSelect: (point: GeoPoint) => void, route: GeoRoute | null = null): () => void {
  const map = L.map(container, { maxBounds: bounds, minZoom: 11, maxZoom: 19 }).setView(initial ? [initial.lat, initial.lon] : [1.295, 103.855], 13);
  L.tileLayer(import.meta.env.VITE_MAP_PROVIDER_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
  let marker: L.Marker | undefined;
  let line: L.Polyline | undefined;
  const placeMarker = (point: GeoPoint) => { marker?.remove(); marker = L.marker([point.lat, point.lon]).addTo(map).bindPopup(`<strong>Selected location</strong><br>${point.name}`); };
  const select = (point: GeoPoint) => { placeMarker(point); marker?.openPopup(); onSelect(point); };
  if (initial) placeMarker(initial);
  map.on('click', (event: L.LeafletMouseEvent) => select({ lat: event.latlng.lat, lon: event.latlng.lng, name: 'Dropped map pin', district: 'Selected on map' }));
  if (route?.geometry.length) { line = L.polyline(route.geometry, { color: '#df553d', weight: 6, opacity: .9 }).addTo(map); map.fitBounds(line.getBounds(), { padding: [35, 35], maxZoom: 15 }); }
  return () => { line?.remove(); marker?.remove(); map.remove(); };
}

export function mountOverviewMap(container: HTMLElement, points: Array<GeoPoint & { kind: string; detail?: string }>): () => void {
  const map = L.map(container, { maxBounds: bounds, minZoom: 11, maxZoom: 19 }).setView([1.295, 103.855], 13);
  L.tileLayer(import.meta.env.VITE_MAP_PROVIDER_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
  const layers = points.map((point) => L.marker([point.lat, point.lon]).addTo(map).bindPopup(`<strong>${point.kind}</strong><br>${point.name}${point.detail ? `<br>${point.detail}` : ''}`));
  if (layers.length > 1) map.fitBounds(L.featureGroup(layers).getBounds(), { padding: [35, 35], maxZoom: 15 });
  return () => map.remove();
}
