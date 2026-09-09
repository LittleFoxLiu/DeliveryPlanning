# Delivery Planner — App Overview

What the app is, how it's laid out, and what each page does — as of the current codebase.
For the agent internals see [AGENTS.md](AGENTS.md).

---

## What it is

A B2B2C autonomous delivery-dispatch demo. Merchants list products and take orders,
customers shop and place orders, a 6-agent system routes and assigns a driver, drivers
deliver, and a dispatcher (admin) watches the whole network on a live map. Everything
runs on a 20×20 road grid with a traffic simulator.

**Stack:** Vite + vanilla-TypeScript SPA (`src/`) · Express 5 + TypeScript API (`server/src/`)
· Postgres data layer (in-process PGlite locally, Supabase `pg` in production) · optional
LLM layer for reasoning/explanations (deterministic fallback everywhere).

---

## Shell & navigation

- **Login screen** — email/password, "Create account" (signup), "Continue with Google/Gmail"
  (OAuth, when configured), and one-click demo sign-in buttons (password `demo1234`).
- **Onboarding** — after signup, pick a role (customer / merchant / driver / admin) and fill
  in the role's details (business + store, or vehicle + start position).
- **App shell** — top bar (brand, role tag, user name, sign out) + a **sub-nav** of pages
  for the current role.
- **Routing** — hash routes, one page per screen: `#/<role>/<page>`. The sub-nav links
  switch pages; deep links and back/forward work.
- **Live updates** — each page polls its data every 3.5–4s and re-renders in place without
  disturbing a form you're typing in. Admin also has an SSE event stream.

---

## Customer

Sub-nav: **Order · My orders**

### Order (`#/customer/order`)
A 4-step ordering wizard, Amazon/Shopee-style:

1. **Merchant** — pick a store from a card grid (name, store, pickup location).
2. **Products** — the store's catalogue as product cards (name, price, description,
   package size) with +/- steppers; a running cart summary with line totals and a grand total.
3. **Delivery** — drop-off X/Y on the grid, priority (standard/express), deadline
   (datetime picker), optional note.
4. **Review** — store, address, priority, deadline, itemised total; **Place order**.

On success it jumps to *My orders*. Package size and volume are derived from the chosen
products server-side (max size, summed quantity).

### My orders (`#/customer/orders`)
- Chips for every past order with a friendly status (Placed → Preparing → Driver assigned
  → Picked up → In transit → Delivered).
- **Tracking card** for the selected order: big ETA, "about N minutes away", items,
  assigned driver (first name + vehicle), deadline, and a live **Progress** feed of agent
  activity (names, not IDs).
- **Live map**: the drop-off marker plus the driver's moving position once the delivery is
  in flight.

---

## Merchant

Sub-nav: **Orders · New order · Catalogue · Account**

### Orders (`#/merchant/orders`)
- Table of all orders: code + items, customer + drop-off, order total, status, deadline.
- Per row: **Mark ready** (created) or **Retry dispatch** (ready/validated/dispatching).
  "Ready" hands the order to the Coordinator and reports the dispatch outcome.
- Click a row → detail panel: customer, deliver-to, items, order total, status, priority,
  package/volume, deadline, assigned driver (+ live position), ETA, and the **agent trail**.
- "+ New order" shortcut in the header.

### New order (`#/merchant/new`)
Storefront-style counter/phone order: pick store, customer name, priority, then a product
grid with steppers + cart, then drop-off X/Y, note, deadline. **Create order** → jumps to
*Orders*.

### Catalogue (`#/merchant/catalogue`)
- Table of products: name + description, price, package size, active/hidden.
- Per product: **Hide/Show** (toggle visibility to shoppers) and **Remove** (soft-delete).
- **Add product** form: name, price (USD), package size, optional description.

### Account (`#/merchant/account`)
- **Join an admin** — enter an admin invite code to request that a dispatcher manage the
  merchant. The request shows up on the admin's Network page for approval.

---

## Driver

Sub-nav: **Deliveries · Account**

### Deliveries (`#/driver/deliveries`)
- One card per active delivery: order code + status, a "➜ Head to / Collecting at /
  Delivering to" next-step line, customer, pickup (store + coords), drop-off, items,
  package + priority, note, deadline, ETA.
- Action button by stage: **Accept — head to pickup** → **I've collected the package** →
  **Mark delivered**. Confirming pickup/delivery snaps the driver's map position to that
  waypoint.
- **Route map**: the driver (teal dot), pickup, drop-off, and the planned route polyline.

### Account (`#/driver/account`)
- Name, vehicle, status, current position.
- **Take a break / Go available / Go offline** (can't change status while carrying a
  package).
- **Set position on map** — when on break/offline, click a grid intersection to reposition;
  a preview marker follows the cursor.

---

## Admin (Dispatch Control)

Sub-nav: **Overview · Autonomous Ops · Orders · Fleet · Evaluation · Network**

> **Autonomous Ops** and **Evaluation** are the multi-agent heart of the app —
> see [AUTONOMY.md](AUTONOMY.md) for the full architecture. Autonomous Ops shows
> every planning run as a decision trace (tools → proposal → critique → revision
> → risk → policy → execute) and holds pending human-approval escalations.
> Evaluation runs golden + adversarial scenarios live and compares the
> autonomous system to a nearest-feasible-driver baseline.

### Overview (`#/admin/overview`)
- Header actions: **▶ Simulate tick** (advance the sim), **Run monitoring** (one monitoring
  cycle), **Reset demo**, and — when a
  delivery is in flight — **⚠ Simulate traffic incident** (close a road on the active route).
- Stat tiles: active orders, drivers available, deliveries in flight, road incidents.
- **Network map**: every driver (with hover card: vehicle, status, load, position, current
  order), every pickup/drop-off, and colour-coded route polylines; congested/closed road
  segments drawn in.
- **Agent activity** feed (live, via SSE + poll).

### Orders (`#/admin/orders`)
- Table of every active order: code + items, customer + drop-off, status, priority,
  deadline (+ minutes left), assigned driver, ETA.
- **Why?** expander per assigned order: the deterministic rationale, the full scoring
  explanation, the score breakdown by factor (ETA / efficiency / deadline / workload /
  vehicle / distance, plus a `latePenalty` line if the driver is projected late), and any
  drivers ruled out with reasons.

### Fleet (`#/admin/fleet`)
- Table of all drivers: name, vehicle + max package size, status, load (n/capacity),
  position, and **Take offline** (triggers the Monitoring Agent to react).

### Network (`#/admin/network`)
- **Merchant join requests** — accept/reject merchants that entered your invite code;
  the invite code is shown to share.
- **Add to network** — create a **merchant** (business + store + login), **driver** (fleet
  vehicle + login), or **customer** (login). Each gets a generated password shown once in a
  table to hand over.

---

## The 6-agent dispatch system (summary)

Runs server-side; you watch it through the Admin feed and the "Why?" panels.

| Agent | Does |
| --- | --- |
| **Order Agent** | Validates the order (merchant/store/customer, coords, deadline), derives constraints, reads the delivery note. |
| **Driver Agent** | Filters drivers to those *eligible* (status, location, capacity, vehicle fit, load). |
| **Routing Agent** | Dijkstra shortest-*time* routes, ETAs, distances, traffic penalties; recalculation mid-trip. |
| **Dispatch Agent** | Deterministic weighted scoring, picks the best driver, atomic + idempotent assignment, notifies. |
| **Monitoring Agent** | Watches in-flight deliveries for delay, deadline risk, route deviation, driver drop-off. |
| **Coordinator** | Orchestrates the pipeline and the monitoring/remediation loop (reroute vs reassign). |

**Scoring weights:** ETA 40 · route efficiency 20 · deadline feasibility 15 · workload 10 ·
vehicle fit 8 · distance 7. A projected-late driver is **not** disqualified — a heavy soft
penalty applies instead, so an on-time driver always wins but a best-effort assignment still
happens when nobody can make the deadline. Hard disqualifiers: incompatible vehicle, full,
on break, offline, no viable route.

The optional LLM layer only writes human explanations, narrates risk, interprets notes, and
picks between pre-validated reroute/reassign options — never numbers, auth, or DB writes.

---

## Data model (tables)

`users` · `merchants` · `stores` · `products` · `customers` · `drivers` (+ `driver_status`,
`driver_locations`) · `orders` (+ `order_items`, now product-linked with price snapshots) ·
`deliveries` · `routes` · `assignments` · `road_segments` · `traffic_conditions` ·
`agent_events` · membership tables (`admin_invites`, `merchant_admins`, `join_requests`).

---

## Simulator

- **Tick** — moves every assigned driver along its route; snaps onto waypoints on arrival;
  advances order/delivery state; drives deliveries to completion.
- **Traffic** — inject congestion/closures on named segments, or close a road on a specific
  order's route (minor = heavy + delay on a few segments; major = close the primary + a
  heavy neighbourhood). Feeds the Monitoring Agent.
- **Driver offline** — force a driver offline mid-delivery to watch remediation.
- **Reset** — reseed the demo (2 merchants with catalogues, 5 drivers, 2 customers, 3
  seed orders).

---

## Running it

```
npm install
npm run dev      # api (tsx watch) + web (vite) together
npm run seed     # reseed the local database
npm test         # vitest
npm run build    # typecheck + vite build
```

Demo accounts (password `demo1234`): `admin@demo.test`, `harbor@demo.test`,
`bakery@demo.test`, `driver1..5@demo.test`, `maya@demo.test`, `james@demo.test`.
