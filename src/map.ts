import { CustomerOrder, RoadSegment, Route } from './types';

export const GRID_SIZE = 20;
const BASE_SIZE = 1000;
const CELL = BASE_SIZE / GRID_SIZE;
const DEPOT = { x: 10, y: 10 };
let sharedZoom = 1;
const anchors: Record<string, { x: number; y: number }> = {
  North: { x: 16, y: 3 }, Central: { x: 11, y: 10 }, Harbor: { x: 17, y: 14 },
  West: { x: 4, y: 11 }, South: { x: 12, y: 18 },
};

export function coordinateForOrder(order: CustomerOrder, index = 0): { x: number; y: number } {
  if (Number.isFinite(order.gridX) && Number.isFinite(order.gridY)) return { x: order.gridX!, y: order.gridY! };
  const anchor = anchors[order.zone] || { x: 10, y: 10 };
  return { x: Math.max(0, Math.min(GRID_SIZE, anchor.x + (index % 3) - 1)), y: Math.max(0, Math.min(GRID_SIZE, anchor.y + Math.floor(index / 3) - 1)) };
}

function routePoints(route: Route): Array<{ x: number; y: number }> {
  const points = [DEPOT];
  let current = DEPOT;
  for (const [index, order] of route.orders.entries()) {
    const next = coordinateForOrder(order, index);
    points.push({ x: next.x, y: current.y }, next);
    current = next;
  }
  points.push({ x: DEPOT.x, y: current.y }, DEPOT);
  return points;
}

const pointsToString = (points: Array<{ x: number; y: number }>): string => points.map(p => `${p.x * CELL},${p.y * CELL}`).join(' ');

export function renderCoordinateMap(routes: Route[], selected: number, roads: RoadSegment[] = []): string {
  const grid = Array.from({ length: GRID_SIZE + 1 }, (_, i) => `<path d="M ${i * CELL} 0 V ${BASE_SIZE}"/><path d="M 0 ${i * CELL} H ${BASE_SIZE}"/>`).join('');
  const roadSvg = roads.map(r => `<path class="road-edge road-${r.status.toLowerCase()}" d="M ${r.startX * CELL} ${r.startY * CELL} L ${r.endX * CELL} ${r.endY * CELL}"/>`).join('');
  const routeSvg = routes.map((r, i) => `<polyline class="route-line ${i === selected ? 'active' : 'faint'}" points="${pointsToString(routePoints(r))}"/>`).join('');
  const nodes = routes.flatMap((r, ri) => r.orders.map((o, oi) => { const p = coordinateForOrder(o, oi); return `<circle class="route-node customer" cx="${p.x * CELL}" cy="${p.y * CELL}" r="7"><title>${o.customer} · Rd. X${p.x} · Y${p.y}</title></circle>`; })).join('');
  return `<div class="map-preview coordinate-map"><div class="map-controls"><button type="button" data-map-zoom="out" aria-label="Zoom out">−</button><span class="map-zoom-label">100%</span><button type="button" data-map-zoom="in" aria-label="Zoom in">+</button><button type="button" data-map-zoom="reset" aria-label="Reset zoom">1:1</button></div><div class="map-viewport"><div class="map-canvas"><svg class="route-svg" viewBox="0 0 ${BASE_SIZE} ${BASE_SIZE}" role="img" aria-label="Delivery grid map"><g class="grid-lines">${grid}</g>${roadSvg}<polyline class="route-line depot-route" points="${DEPOT.x * CELL},${DEPOT.y * CELL} ${DEPOT.x * CELL},${DEPOT.y * CELL}"/>${routeSvg}${nodes}<circle class="route-node driver" cx="${DEPOT.x * CELL}" cy="${DEPOT.y * CELL}" r="9"><title>Shipping center · Rd. X10 · Y10</title></circle></svg></div></div><div class="map-legend"><span>Route</span><span>Road</span><span>Stop</span></div></div>`;
}

export function enableMapPan(container: HTMLElement | null): void {
  if (!container) return;
  requestAnimationFrame(() => { container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2; container.scrollTop = (container.scrollHeight - container.clientHeight) / 2; });
  let dragging = false, x = 0, y = 0, left = 0, top = 0;
  container.addEventListener('pointerdown', e => { if ((e.target as HTMLElement).closest('.map-controls')) return; dragging = true; x = e.clientX; y = e.clientY; left = container.scrollLeft; top = container.scrollTop; container.classList.add('is-panning'); container.setPointerCapture(e.pointerId); });
  container.addEventListener('pointermove', e => { if (dragging) { container.scrollLeft = left - (e.clientX - x); container.scrollTop = top - (e.clientY - y); } });
  container.addEventListener('pointerup', () => { dragging = false; container.classList.remove('is-panning'); });
}

export function enableMapZoom(container: HTMLElement | null): void {
  if (!container) return;
  const canvas = container.querySelector<HTMLElement>('.map-canvas');
  // The controls are siblings of the viewport, while the canvas is inside it.
  const controls = container.parentElement || container;
  const label = controls.querySelector<HTMLElement>('.map-zoom-label');
  if (!canvas || !label) return;
  const minimumZoom = () => Math.max(.5, Math.min(1, Math.max(container.clientWidth / BASE_SIZE, container.clientHeight / BASE_SIZE)));
  const update = () => {
    const minimum = minimumZoom();
    sharedZoom = Math.max(minimum, Math.min(2.5, sharedZoom));
    canvas.style.width = `${BASE_SIZE}px`;
    canvas.style.height = `${BASE_SIZE}px`;
    canvas.style.zoom = String(sharedZoom);
    label.textContent = `${Math.round(sharedZoom * 100)}%`;
    controls.querySelectorAll<HTMLButtonElement>('[data-map-zoom]').forEach(button => {
      button.disabled = button.dataset.mapZoom === 'out' && sharedZoom <= minimum;
    });
  };
  controls.querySelectorAll<HTMLButtonElement>('[data-map-zoom]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.mapZoom;
    sharedZoom = action === 'reset' ? 1 : sharedZoom + (action === 'in' ? .25 : -.25);
    update();
  }));
  update();
}
