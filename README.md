# Delivery Planner

An autonomous, multi-agent delivery-dispatch platform (B2B2C).

A customer places an order → a merchant marks it ready → a **coordinated set of
specialised agents** validates it, finds eligible drivers, computes authoritative
routes/ETAs, scores every driver/order pairing, assigns the best driver, notifies
them, and then **monitors the delivery**, rerouting or reassigning when traffic or
driver availability puts the deadline at risk.

Every business-critical number (location, distance, ETA, deadline slack, capacity,
score) is produced by **deterministic backend tools**. The LLM layer is optional
and only *orchestrates* — it never invents numbers and never authorises anything.

---

## Quick start

```bash
npm install
cp .env.example .env          # optional – sensible dev defaults otherwise
npm run dev                   # API on :8787, web on :5173 (with /api proxy)
```

The backend stores application data in Supabase. Run `supabase/schema.sql` in
the Supabase SQL Editor first, then set `SUPABASE_URL` and the server-only
`SUPABASE_SERVICE_ROLE_KEY` in `.env`. Finally run `npm run seed` from this
directory. The server seed creates the demo domain data and the custom scrypt
login users; `supabase/seed.sql` is available for SQL-only domain-data setup,
but it intentionally does not contain password hashes.

Open http://localhost:5173 and sign in with any seeded account
(password **`demo1234`**). One-click demo sign-in buttons are on the login screen.

| Role | Email |
|------|-------|
| Dispatch / Admin | `admin@demo.test` |
| Merchant (Harbor Grocery) | `harbor@demo.test` |
| Merchant (North Bakery) | `bakery@demo.test` |
| Drivers | `driver1@demo.test` … `driver5@demo.test` |
| Customers | `maya@demo.test`, `james@demo.test` |

Other scripts: `npm test` (Vitest), `npm run typecheck`, `npm run build`,
`npm run seed` (reseed the DB).

---

## The demo (≈2 minutes)

1. **Customer** (`maya@demo.test`) – already has an order, or place a new one.
2. **Merchant** (`harbor@demo.test`) – open an order, click **Mark ready**.
   Watch the dispatch outcome toast (driver + score).
3. **Dispatch** (`admin@demo.test`) – the **Agent activity** panel shows the
   full pipeline:
   `Coordinator → Order Agent validated → Driver Agent found N eligible →
   Routing Agent calculated N routes → Dispatch Agent selected Driver X`.
   Click **Why?** on the order row to see the explainable assignment
   (ETA to merchant, ETA to customer, deadline slack, capacity, vehicle,
   route efficiency, and the rejected candidates).
4. On the Dispatch screen click **▶ Simulate tick** a couple of times – drivers
   move along their routes.
5. Click **⚠ Block a route** – a road on the active route is closed and the
   surrounding streets go heavy.
6. Click **▶ Simulate tick** again – the **Monitoring Agent** detects the delay,
   the **Coordinator** decides to reroute, the **Routing Agent** finds an
   alternative, and the customer-facing ETA updates.
7. Alternatively click **Take offline** on the assigned driver, then **tick** –
   the Monitoring Agent detects the driver is gone and the Coordinator runs a
   full **reassignment** to the next-best driver.
8. **Customer** screen – the ETA and the live progress feed update throughout.

`Reset demo` restores the seed data at any time.

---

## Architecture

```
            ┌──────────────┐
  HTTP  ──▶ │  Express API │  auth · ownership checks · validation · rate limit
            └──────┬───────┘
                   │
            ┌──────▼───────┐
            │ Coordinator  │  orchestration – decides which agent acts, and when
            └──────┬───────┘
   ┌─────────┬─────┼───────┬───────────┬──────────────┐
   ▼         ▼     ▼       ▼           ▼              ▼
Order     Driver  Routing Dispatch  Monitoring   (LLM advisor – optional)
Agent     Agent   Agent   Agent     Agent
   │         │     │       │           │
   └─────────┴─────┴───────┴───────────┘
                   │  agents only act through deterministic tools
            ┌──────▼───────────────────────────┐
            │ engine/  routing (Dijkstra)      │
            │          scoring (multi-factor)  │
            │          stateMachine            │
            │ repo/    Supabase PostgREST       │
            └──────────────────────────────────┘
```

### Agents & responsibilities

| Agent | Decides | Tools (deterministic) |
|-------|---------|-----------------------|
| **Order Agent** | is the order/merchant/pickup/delivery valid; what are the constraints & deadline; order state | `get_order` `validate_order` `get_merchant` `get_store` `get_delivery_address` `get_order_constraints` `update_order_status` |
| **Driver Agent** | which drivers are *eligible* (status, live location, capacity, vehicle compatibility, existing load) — **not** "closest" | `get_available_drivers` `get_all_drivers` `get_driver_location` `get_driver_status` `get_driver_capacity` `get_driver_vehicle` `get_driver_current_route` `update_driver_status` |
| **Routing Agent** | authoritative driver→pickup→customer route, ETA, distance, traffic penalty; recalculation when conditions change | `calculate_route` `calculate_eta` `calculate_distance` `check_traffic` `estimate_delivery_time` `compare_routes` |
| **Dispatch Agent** | score every candidate, compare, pick the best, assign atomically, notify, cancel/reassign | `get_candidate_drivers` `score_driver` `compare_assignments` `assign_order` `notify_driver` `cancel_assignment` |
| **Monitoring Agent** | for each active delivery: delayed? deviating? driver gone? deadline at risk? recommend reroute vs reassign | `get_driver_position` `get_order_status` `get_current_route` `detect_delay` `detect_route_deviation` `estimate_new_eta` `trigger_reassignment` |
| **Coordinator** | the workflow: run the pipeline, react to monitoring findings, choose remediation, drive reroute/reassignment | (delegates to the agents above; optionally consults the LLM advisor) |

### Deterministic layer (the AI never does this)

- **`engine/routing.ts`** — Dijkstra shortest-*time* path over a 20×20 road grid.
  Segment cost = `base × trafficMultiplier + delay`; closed roads are impassable.
  Produces path, distance (km), ETA (min), and a traffic-penalty (ETA − ideal
  free-flow time).
- **`engine/scoring.ts`** — explainable multi-factor score (0–100). Hard
  disqualifiers: vehicle incompatible, driver on break/offline, at capacity, no
  viable route, **deadline cannot be met**. Weighted factors: total delivery
  time, deadline slack, route efficiency, availability, capacity headroom.
  Ties broken deterministically by driver id.
- **`engine/stateMachine.ts`** — legal order/delivery transitions; terminal
  states can't be resurrected.

### LLM advisory layer (`agents/llm.ts`)

Disabled unless `ANTHROPIC_API_KEY` is set. When enabled, the Coordinator asks
the model to pick between **pre-validated, feasible** remediation strategies
(`reroute` / `reassign`) and to explain the choice in one sentence. The response
is strictly validated against the allowed set; any deviation, timeout, or error
falls back to the deterministic choice. The model is never given free-text user
input, never returns numbers, and never touches the database.

---

## Security

See [SECURITY.md](SECURITY.md). Highlights:

- HMAC-signed bearer tokens with expiry; `scrypt` password hashing; constant-time
  comparison for both.
- Role-based access + **per-resource ownership checks** on every read and mutation
  (merchant ↔ merchant, customer ↔ customer, driver ↔ delivery).
- All input validated server-side; coordinates bounds-checked; id params
  regex-checked (kills the injection/IDOR probe surface).
- Assignment is **atomic and idempotent**: an `IMMEDIATE` transaction + an
  order-status compare-and-set + a unique `idempotency_key`. Concurrent dispatch
  triggers cannot double-assign (tested with 8 parallel requests).
- State-transition guards; completed/cancelled deliveries can't be reassigned.
- Parameterised SQL everywhere; per-IP rate limiting (stricter on `/auth`);
  `express.json` body cap; `X-Frame-Options` / `nosniff` / `Referrer-Policy`.
- The LLM is never in the authorization or numeric path.

---

## Data model (`server/src/db.ts`)

`users`, `merchants`, `stores`, `customers`, `drivers`, `driver_status`,
`driver_locations`, `orders`, `order_items`, `deliveries`, `routes`,
`assignments`, `road_segments`, `traffic_conditions`, `agent_events`.

## Tests

`npm test` — 36 tests across 6 files:

- `routing.test.ts` — Dijkstra, closed-road detours, traffic multipliers, chaining
- `scoring.test.ts` — multi-factor scoring, disqualifiers, "not just the closest",
  deterministic tie-breaks
- `stateMachine.test.ts` — legal/illegal transitions
- `rateLimit.test.ts` — limiter middleware
- `api.security.test.ts` — auth, tampered tokens, role separation, IDOR
  (merchant/customer/driver), input validation, id-shape rejection
- `dispatch.e2e.test.ts` — full multi-agent pipeline, idempotency, concurrent
  no-double-assign, illegal-transition rejection, driver-offline reassignment,
  traffic reroute
