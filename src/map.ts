import type { Point, RoadSeg } from './types';

const BASE = 1000;

export interface MapMarker {
  x: number; y: number;
  kind: 'pickup' | 'dropoff' | 'driver' | 'depot';
  label?: string;
  /** Heading + detail lines shown in the hover card. */
  title?: string;
  tip?: string[];
  pulse?: boolean;
}
export interface MapPath { points: Point[]; color: string; active?: boolean; dashed?: boolean }

export interface MapInput {
  size: number;
  roads: RoadSeg[];
  markers: MapMarker[];
  paths: MapPath[];
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c] as string
));

const KIND_COLOR: Record<MapMarker['kind'], string> = {
  pickup: '#f1c75b', dropoff: '#5277d7', driver: '#159c99', depot: '#98a2b3',
};

export function renderMap({ size, roads, markers, paths }: MapInput): string {
  const cell = BASE / (size || 20);
  const p = (n: number) => (n * cell).toFixed(1);
  const ok = (q: { x: number; y: number }) => Number.isFinite(q.x) && Number.isFinite(q.y);
  markers = markers.filter(ok);
  paths = paths.map((pt) => ({ ...pt, points: pt.points.filter(ok) }));

  const grid = Array.from({ length: size + 1 }, (_, i) =>
    `<path d="M ${p(i)} 0 V ${BASE}"/><path d="M 0 ${p(i)} H ${BASE}"/>`).join('');

  const roadSvg = roads
    .filter((r) => r.status !== 'clear')
    .map((r) => `<path class="road-edge road-${r.status}" d="M ${p(r.ax)} ${p(r.ay)} L ${p(r.bx)} ${p(r.by)}"/>`)
    .join('');

  const pathSvg = paths.map((path) => {
    if (path.points.length < 2) return '';
    const pts = path.points.map((q) => `${p(q.x)},${p(q.y)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${path.color}"
      stroke-width="${path.active ? 7 : 4}" stroke-linecap="round" stroke-linejoin="round"
      opacity="${path.active ? 0.95 : 0.4}" ${path.dashed ? 'stroke-dasharray="4 10"' : ''}/>`;
  }).join('');

  const markerSvg = markers.map((m) => {
    const cx = p(m.x); const cy = p(m.y);
    const color = KIND_COLOR[m.kind];
    const r = m.kind === 'driver' ? 11 : 8;
    const heading = m.title || m.label || m.kind;
    const lines = (m.tip && m.tip.length ? m.tip : [`(${m.x}, ${m.y})`]);
    const tipAttr = esc([heading, ...lines].join('\n'));
    return `<g class="map-marker" data-tip="${tipAttr}">`
      + `<circle cx="${cx}" cy="${cy}" r="${r + 9}" fill="${color}" opacity="0.001"/>` // hover target
      + `<circle cx="${cx}" cy="${cy}" r="${r + 4}" fill="${color}" opacity="0.18"${m.pulse ? ' class="marker-pulse"' : ''}/>`
      + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="#fff" stroke-width="2">`
      + `<title>${esc(heading)} — ${esc(lines.join(' · '))}</title></circle></g>`;
  }).join('');

  return `<div class="map-wrap">
    <svg viewBox="-20 -20 ${BASE + 40} ${BASE + 40}" class="grid-map" role="img" aria-label="Delivery grid">
      <g class="grid-lines" stroke="#e7e9ed" stroke-width="1">${grid}</g>
      ${roadSvg}${pathSvg}${markerSvg}
    </svg>
    <div class="map-tip" hidden></div>
    <div class="map-key">
      <span><i style="background:#f1c75b"></i>Pickup</span>
      <span><i style="background:#5277d7"></i>Drop-off</span>
      <span><i style="background:#159c99"></i>Driver</span>
      <span><i style="background:#db4e36"></i>Closed road</span>
      <span class="muted">hover for details</span>
    </div>
  </div>`;
}

/** Wire the floating hover card. Call after each render on the map's container. */
export function enableMapTooltips(root: HTMLElement | Document = document): void {
  root.querySelectorAll<HTMLElement>('.map-wrap').forEach((wrap) => {
    if (wrap.dataset.tipsWired) return;
    wrap.dataset.tipsWired = '1';
    const tip = wrap.querySelector<HTMLElement>('.map-tip');
    if (!tip) return;
    const show = (el: Element, ev: MouseEvent) => {
      const raw = (el as HTMLElement).dataset.tip || '';
      const [head, ...rest] = raw.split('\n');
      tip.innerHTML = `<strong>${head}</strong>${rest.map((l) => `<span>${l}</span>`).join('')}`;
      tip.hidden = false;
      const b = wrap.getBoundingClientRect();
      const px = ev.clientX - b.left;
      const py = ev.clientY - b.top;
      const gap = 8;
      const w = tip.offsetWidth || 200;
      const hgt = tip.offsetHeight || 40;
      // sit just to the right of and vertically centred on the pointer; flip
      // side / clamp only when it would leave the map
      let left = px + gap;
      if (left + w > b.width - 2) left = px - gap - w;
      let top = py - hgt / 2;
      top = Math.max(2, Math.min(top, b.height - hgt - 2));
      tip.style.left = `${Math.max(2, left)}px`;
      tip.style.top = `${top}px`;
    };
    wrap.addEventListener('mousemove', (ev) => {
      const el = (ev.target as Element).closest('.map-marker');
      if (el) show(el, ev); else tip.hidden = true;
    });
    wrap.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
}

export function routeToPath(route: { path?: { toPickup?: Point[]; toDropoff?: Point[] } } | null | undefined): Point[] {
  if (!route?.path) return [];
  return [...(route.path.toPickup ?? []), ...(route.path.toDropoff ?? [])];
}
