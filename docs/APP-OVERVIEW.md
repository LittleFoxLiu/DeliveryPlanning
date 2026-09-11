# Delivery Planner — App Overview

This document describes the current codebase. Location selection uses Nominatim,
route geometry and driving duration use OSRM, and every map is constrained to
Singapore (`south 1.22`, `north 1.48`, `west 103.60`, `east 104.05`).

## Stack and navigation

The app is a Vite vanilla-TypeScript SPA backed by an Express TypeScript API and
Postgres-compatible storage (PGlite locally or Supabase/Postgres in deployment).
The optional LLM layer only advises or explains deterministic agent decisions.

The browser uses hash routes in the form `#/<role>/<page>`. Each page polls its
API data and preserves in-progress form input while it refreshes.

## Location and maps

Address fields search Nominatim with the Singapore country code and geographic
bounding box. A selected result stores its full Nominatim display address with
`latitude` and `longitude`; no synthetic location is generated.

OSRM requests use its required `[longitude,latitude]` URL order. API responses,
database rows, Leaflet markers, and route paths use `{ lat, lon }`; Leaflet paths
are `[lat, lon]`. The shared map adapter filters markers and paths to Singapore,
uses bounded Leaflet views, and renders OSRM geometry for routes.

## Customer

`Order` is a four-step wizard: select a merchant/store, choose products, search or
pin a Singapore delivery address, then review and place the order. The delivery
address cannot be submitted until it has a valid Singapore latitude/longitude.
The delivery preview calls OSRM directly so the customer sees driving distance
and duration before placing the order.

`My orders` shows status, ETA, agent activity, pickup/drop-off markers, driver
position, and the persisted OSRM route.

## Merchant

`Orders` lists orders and their Nominatim address, status, deadline, assignment,
ETA, event trail, and OSRM route map. `New order` uses the catalogue and the same
Nominatim delivery-address flow. `Catalogue` manages products. `Account` handles
admin membership requests.

## Driver

`Deliveries` shows active work, pickup/drop-off addresses, status actions, current
position, and the OSRM route. Accepting, picking up, and delivering updates the
driver's geographic position to the corresponding persisted waypoint.

`Account` allows an unavailable driver to select a new Singapore position on a
bounded Leaflet map. The selected latitude/longitude and address are stored as a
new driver-location record.

## Admin

`Overview` shows active orders, fleet state, geographic markers, OSRM route
polylines, and agent activity. `Autonomous Ops` exposes planning traces and
human-approval escalations. `Orders` shows assignments and their score evidence.
`Fleet` shows status, load, and geographic position. `Evaluation` runs current
OSRM-backed scenarios against the autonomous planner and a nearest-feasible
baseline. `Network` provisions accounts and handles membership requests.

The simulation tick advances drivers along their persisted OSRM geometry and
invokes monitoring. Taking an assigned driver offline exercises the monitoring
and reassignment path.

## Agents

- Order Agent validates order data, the Nominatim-selected address, deadline, and
  package constraints.
- Driver Agent filters drivers by availability, current geographic position,
  capacity, and vehicle compatibility.
- Routing Agent calls OSRM for every route, ETA, distance, and route geometry.
- Dispatch Agent scores eligible candidates and performs the atomic assignment.
- Monitoring Agent compares the live geographic position with persisted OSRM
  geometry and requests fresh OSRM estimates when risk changes.
- Coordinator orchestrates validation, dispatch, monitoring, rerouting, and
  reassignment.

## Data model

The current schema contains users, merchants, stores, customers, drivers,
driver_status, driver_locations, products, orders, order_items, deliveries,
routes, assignments, agent_events, agent_runs, and agent_escalations.

Stores, driver locations, orders, and routes use geographic latitude/longitude
columns. The old synthetic road tables and coordinate columns are removed during
database initialization; `npm run seed` repopulates valid Singapore sample data.
