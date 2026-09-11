# Delivery Planner

An autonomous, multi-agent delivery-dispatch platform (B2B2C).

A customer places an order → a merchant marks it ready → a **coordinated set of
specialised agents** validates it, finds eligible drivers, computes authoritative
routes/ETAs, scores every driver/order pairing, assigns the best driver, notifies
them, and then **monitors the delivery**, recalculating OSRM routes or reassigning
when route risk or driver availability puts the deadline at risk.

Every business-critical number (location, distance, ETA, deadline slack, capacity,
score) is produced by **deterministic backend tools**. The LLM layer is optional
and only *orchestrates* — it never invents numbers and never authorises anything.

---

## Quick start

```bash
npm install
npm run dev                   # API on :8787, web on :5173 (with /api proxy)
```

By default the server runs a **zero-setup in-process Postgres** (PGlite),
persisted under `server/data/`. Open http://localhost:5173 and sign in with any
seeded account (password **`demo1234`**). One-click demo sign-in buttons are on
the login screen.

### Sharing data with your team (Supabase)

To have everyone see the same live data, point the server at a shared Postgres:

1. Create a Supabase project and run [`server/src/schema.ts`](server/src/schema.ts)'s
   SQL in the SQL editor (or just start the server once — it runs
   `CREATE TABLE IF NOT EXISTS` on boot).
2. Supabase dashboard → **Connect** → **URI** tab → copy the connection string
   and fill in your database password (Settings → Database →
   *Reset database password* if you don't have it). Use the **Direct** or
   **Session pooler** connection (port 5432), *not* the transaction pooler (6543).
3. Put it in `.env.local` (gitignored) as `DATABASE_URL=postgresql://…`.
4. `npm run db:setup` to create the schema + seed demo data, then `npm run dev`.

Everyone who sets the same `DATABASE_URL` now shares one database. The browser
never touches Supabase — only the server does, so the connection string stays
server-side. The service_role / publishable API keys are **not** used.

### Google / Gmail sign-in

Create a Google Cloud OAuth **Web application**, add
`http://localhost:8787/api/auth/google/callback` as an authorized redirect URI,
and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. New Google
accounts are created as customers and are sent through the role-onboarding page.
Google sign-in is disabled until both values are configured.

Tests always run against a private in-process Postgres regardless of
`DATABASE_URL`.

| Role | Email |
|------|-------|
| Dispatch / Admin | `admin@demo.test` |
| Merchant (Harbor Grocery) | `harbor@demo.test` |
| Merchant (North Bakery) | `bakery@demo.test` |
| Drivers | `driver1@demo.test` … `driver5@demo.test` |
| Customers | `maya@demo.test`, `james@demo.test` |

Other scripts: `npm test` (Vitest), `npm run typecheck`, `npm run build`,
`npm run seed` (reseed the DB).

### Vercel deployment

The Vercel deployment exposes the Express API through `api/[...path].ts`.
Configure `DATABASE_URL` (a persistent Postgres/Supabase connection string) and
`AUTH_SECRET` (at least 16 characters) in the Vercel project environment. On a
new empty database the API initialises the schema and creates the demo accounts
automatically; it does not reset an existing database.

After redeploying, verify the API directly at `/api/health`. It should return
JSON with `ok: true`; a Vercel HTML 404 there means the deployment is not using
the repository root or has not deployed the `api/` function.

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
5. Click **▶ Simulate tick** again or **Run monitoring** – the **Monitoring Agent**
   asks the Routing Agent for a fresh OSRM driving route and updates the ETA when
   the current geographic position changes.
6. Alternatively click **Take offline** on the assigned driver, then **tick** –
   the Monitoring Agent detects the driver is gone and the Coordinator runs a
   full **reassignment** to the next-best driver.
7. **Customer** screen – the friendly status (`Placed → Preparing → Driver
   assigned → Picked up → In transit → Delivered`), ETA and live progress feed
   update throughout. Agent messages use driver **names**, not ids.

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
            │ engine/  routing (OSRM)          │
            │          scoring (multi-factor)  │
            │          stateMachine            │
            │ repo/    Postgres (pg / PGlite)  │
            └──────────────────────────────────┘
```

### Agents & responsibilities

| Agent | Decides | Tools (deterministic) |
|-------|---------|-----------------------|
| **Order Agent** | is the order/merchant/pickup/customer valid; constraints & deadline; order state | `get_order` `get_merchant` `get_store` `get_customer` `get_delivery_address` `get_order_constraints` `validate_order` `update_order_status` |
| **Driver Agent** | which drivers are *eligible* (status, live location, capacity, vehicle compatibility, existing load) — **not** "closest" | `get_available_drivers` `get_all_drivers` `get_driver_location` `get_driver_status` `get_driver_capacity` `get_driver_vehicle` `get_driver_current_route` `update_driver_status` |
| **Routing Agent** | authoritative Nominatim location → OSRM driving route, ETA and distance; recalculation from the live geographic position | `calculate_route` `calculate_eta` `calculate_distance` `estimate_delivery_time` `compare_routes` |
| **Dispatch Agent** | score every candidate, compare, pick the best, assign atomically, notify, cancel/reassign | `get_candidate_drivers` `score_driver` `compare_assignments` `assign_order` `notify_driver` `cancel_assignment` `reassign_order` |
| **Monitoring Agent** | for each active delivery: delayed? deviating? driver gone? deadline at risk? recommend reroute vs reassign | `get_driver_position` `get_order_status` `get_current_route` `detect_delay` `detect_route_deviation` `estimate_new_eta` `trigger_reassignment` |
| **Coordinator** | the workflow: run the pipeline, react to monitoring findings, choose remediation, drive reroute/reassignment | (delegates to the agents above; optionally consults the LLM advisor) |

### Deterministic layer (the AI never does this)

- **`engine/geoRouting.ts`** — OSRM driving routes over Nominatim-selected
  Singapore locations. Requests use OSRM's `[longitude, latitude]` order and
  stored/displayed path points use `{ lat, lon }`.
- **`engine/scoring.ts`** — explainable multi-factor score (0–100), sums to the
  product-spec weighting: **ETA 40**, route efficiency 20, deadline feasibility
  15, driver workload 10, spare vehicle capacity 8, raw distance to pickup 7.
  Hard disqualifiers (checked before scoring): vehicle incompatible, driver on
  break/offline, at capacity, no viable route, **deadline cannot be met**. Every
  driver's contributions are shown in the dispatch UI. Ties broken
  deterministically by driver id.
- **`engine/stateMachine.ts`** — legal order/delivery transitions; terminal
  states can't be resurrected.

### LLM reasoning layer (`agents/llm.ts`)

Off unless `LLM_GATEWAY_URL` + `LLM_GATEWAY_API_KEY` (organizer's Bedrock/Ollama
gateway) **or** `ANTHROPIC_API_KEY` is set. When on, the LLM does **reasoning,
explanation and orchestration only** — the deterministic engine still owns every
number:

| Agent | LLM does | Guardrail |
|---|---|---|
| **Coordinator** | choose `reroute` vs `reassign` given the situation + the (deterministically-scored) alternative driver | output must be in the pre-validated allowed set, else deterministic policy |
| **Dispatch Agent** | write the human "why this driver" sentence from the score breakdown (`assignment_explained` event, non-blocking) | display-only; cannot change the pick or the numbers |
| **Monitoring Agent** | narrate the risk + rate urgency (`risk_assessed` event, non-blocking) | severity also computed by rule; numbers from `detect_delay` |
| **Order Agent** | interpret the free-text delivery note → `{contactRequired, leaveUnattended, fragile}` (`note_interpreted` event) | advisory flags only; keyword parser is the fallback |

Every call is time-boxed (5–8 s), validated, has a deterministic fallback, runs
fire-and-forget off the request path where possible, and **never** touches auth,
scoring, routing, or DB writes. Events carry a `source: "llm" | "deterministic"`
tag so you can see which parts the model shaped. `GET /api/health` reports the
active provider + model.

---

## Security

See [SECURITY.md](SECURITY.md). Highlights:

- HMAC-signed bearer tokens with expiry; `scrypt` password hashing; constant-time
  comparison for both.
- Role-based access + **per-resource ownership checks** on every read and mutation
  (merchant ↔ merchant, customer ↔ customer, driver ↔ delivery).
- All input validated server-side; geographic coordinates are restricted to the
  Singapore map bounds; id params
  regex-checked (kills the injection/IDOR probe surface).
- Assignment is **atomic and idempotent**: a transaction gated by an
  order-status compare-and-set (`UPDATE … WHERE status IN (…)`, which row-locks)
  + a unique `idempotency_key`. Concurrent dispatch triggers cannot double-assign
  (tested with 8 parallel requests).
- State-transition guards; completed/cancelled deliveries can't be reassigned.
- Parameterised SQL everywhere; per-IP rate limiting (stricter on `/auth`);
  `express.json` body cap; `X-Frame-Options` / `nosniff` / `Referrer-Policy`.
- The LLM is never in the authorization or numeric path.

---

## Data model (`server/src/schema.ts`)

`users`, `merchants`, `stores`, `customers`, `drivers`, `driver_status`,
`driver_locations`, `orders`, `order_items`, `deliveries`, `routes`,
`assignments`, `agent_events`, `agent_runs`, `agent_escalations`.

## Tests

`npm test` — 57 tests across 8 files:

- `routing.test.ts` — OSRM request coordinate order, Singapore bounds, route
  geometry conversion, chaining, and reachable-route ranking
- `scoring.test.ts` — multi-factor scoring, disqualifiers, "not just the closest",
  deterministic tie-breaks
- `stateMachine.test.ts` — legal/illegal transitions
- `rateLimit.test.ts` — limiter middleware
- `api.security.test.ts` — auth, tampered tokens, role separation, IDOR
  (merchant/customer/driver), input validation, id-shape rejection
- `dispatch.e2e.test.ts` — full multi-agent pipeline, idempotency, concurrent
  no-double-assign, illegal-transition rejection, driver-offline reassignment,
  geographic route recalculation
