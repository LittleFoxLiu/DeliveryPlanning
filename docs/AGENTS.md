# Delivery Planner — Agents & Tools

How the multi-agent dispatch system is wired. Six agents live in `server/src/agents/`.
Each agent **decides**; its **tools** fetch or compute. All numbers (routes, ETAs,
scores) come from the deterministic engines in `server/src/engine/`. The LLM layer
(`agents/llm.ts`) only reasons, explains, and picks between pre-validated options —
it never touches numbers, auth, or DB writes.

---

## Order Agent — `orderAgent.ts`

**Job:** Decide whether an order is safe to dispatch, and derive its constraints.

Checks that the merchant, store, and customer exist and that the store belongs to
the merchant; that pickup/drop-off coordinates are in bounds; that pickup ≠
drop-off (within 1 grid unit); that volume ≥ 1; and that the deadline is valid and
at least 15 minutes out. On success it advances the order `ready → validated` and
emits the constraints (package size, priority, deadline, pickup/drop-off).

Separately (fire-and-forget, never blocks dispatch) it asks the LLM to read the
free-text delivery note and turn it into flags: `contactRequired`,
`leaveUnattended`, `fragile`.

**Main method:** `validate(orderId, cycleId) → { ok, issues, constraints }`

**Tools:**

| Tool | Purpose |
| --- | --- |
| `get_order` | Load the order row |
| `get_merchant` | Load the merchant |
| `get_store` | Load the pickup store |
| `get_customer` | Load the customer for the order |
| `get_delivery_address` | `{ lat, lng }` of the drop-off |
| `get_order_constraints` | Package size, volume, priority, deadline, pickup, drop-off |
| `validate_order` | Run all the checks above, return `{ ok, issues[] }` |
| `update_order_status` | Advance the order state (guarded by expected-from) |

**Emits:** `order_validated`, `validation_failed`, `note_interpreted`

---

## Driver Agent — `driverAgent.ts`

**Job:** Decide which drivers are *eligible* for an order. It does **not** pick the
"closest" or "best" driver — that's Dispatch's call.

Filters out drivers who are: excluded by the Coordinator, on break, offline,
without a location fix, at capacity (no headroom for another order), driving a
vehicle that can't carry the package size, or already juggling too many active
legs. Returns the eligible candidates plus a rejected list with reasons.

**Main method:** `findCandidates(order, cycleId, excludeDriverIds?, quiet?) → { candidates, rejected }`

**Tools:**

| Tool | Purpose |
| --- | --- |
| `get_available_drivers` | Drivers currently marked available |
| `get_all_drivers` | Every driver (for what-if / rejected reporting) |
| `get_driver_location` | Current position + whether the fix is fresh |
| `get_driver_status` | available / on_route / on_break / offline |
| `get_driver_capacity` | Max load vs. current order count |
| `get_driver_vehicle` | Vehicle type and what package sizes it can carry |
| `get_driver_current_route` | Active legs the driver already has |
| `update_driver_status` | Set a driver's status |

**Emits:** `candidates_found`

---

## Routing Agent — `routingAgent.ts`

**Job:** All authoritative geometry. Shortest-**time** path (Dijkstra) over the
20×20 road grid, where each segment costs `base × trafficMultiplier + delay` and a
closed road is infinite. For every candidate driver it computes the full
driver → pickup → customer route, the ETA, the distance, and the traffic penalty
(ETA minus the ideal Manhattan baseline). It also recalculates a route mid-trip
from the driver's current position, and reports when no viable route exists.

**Main methods:**
- `computeCandidateRoutes(order, candidates, cycleId, quiet?)`
- `recalculate(delivery, order, currentPos, phase, cycleId)`

**Tools:**

| Tool | Purpose |
| --- | --- |
| `calculate_route` | Full path between two points on the current grid |
| `calculate_eta` | Time along a route given traffic |
| `calculate_distance` | Path distance |
| `check_traffic` | Traffic multiplier on a given segment/area |
| `get_traffic_conditions` | `{ incidents, areas, summary }` snapshot |
| `estimate_delivery_time` | End-to-end driver → pickup → drop-off estimate |
| `compare_routes` | Rank several routes by time |

**Emits:** `routes_calculated`, `route_recalculated`, `reroute_failed`

---

## Dispatch Agent — `dispatchAgent.ts`

**Job:** Score the routed candidates, pick the winner, and make the assignment
stick.

Scoring is the deterministic weighted model — ETA 40%, route efficiency 20%,
deadline feasibility 15%, workload 10%, vehicle fit 10%, distance 5% — with hard
disqualifiers (vehicle can't carry, driver full or unavailable, guaranteed
deadline miss, no route). Ties break deterministically by driver id.

The assignment itself runs in a transaction: a conditional
`UPDATE orders SET status='assigned' WHERE id=$1 AND status IN ('validated','dispatching')`
is the authoritative gate (row-locks; 0 rows → rollback), backed by a UNIQUE
`assignments.idempotency_key`. So concurrent dispatches and retries can't
double-assign. Then it notifies the driver.

Fire-and-forget, the LLM writes the human-readable "why this driver" sentence.

**Main method:** `evaluateAndAssign(order, routed, cycleId, { idempotencyKey }) → DispatchDecision`

**Tools:**

| Tool | Purpose |
| --- | --- |
| `score_driver` | Weighted 0–100 score for one candidate |
| `compare_assignments` | Rank scored candidates, return the winner |
| `get_candidate_drivers` | Pull the candidate set for an order |
| `assign_order` | Atomic assignment (tx + order-status CAS + idempotency key) |
| `notify_driver` | Push the assignment to the driver |
| `reassign_order` | Detach the current driver for re-dispatch |
| `cancel_assignment` | Cancel an assignment outright |

**Emits:** `candidates_evaluated`, `driver_assigned`, `driver_notified`,
`assignment_explained` (LLM), `assignment_failed`, `assignment_conflict`,
`assignment_reused`

---

## Monitoring Agent — `monitoringAgent.ts`

**Job:** Watch every in-flight delivery and flag risk. It **detects and
recommends only** — it never changes an assignment.

Each pass, for each active delivery: is the driver still available? Recompute the
ETA from the driver's current position — has it slipped by ≥ 3 minutes, or will
completion land past the deadline? Has the driver strayed > 2.5 units off the
planned path? Is the route now blocked? Each problem becomes a `Finding` with a
recommended trigger (`none` / `reroute` / `reassign`) and a rule-based severity
(info / warn / critical).

Fire-and-forget, the LLM narrates the risk in plain language.

**Main method:** `evaluateActiveDeliveries(cycleId) → Finding[]`

**Constants:** `DELAY_THRESHOLD_MIN = 3`, `DEVIATION_THRESHOLD = 2.5`

**Tools:**

| Tool | Purpose |
| --- | --- |
| `get_driver_position` | Where the driver is now |
| `get_order_status` | Current order state |
| `get_current_route` | The route the driver is following |
| `detect_delay` | Compare projected completion vs. deadline / original ETA |
| `detect_route_deviation` | Distance of the driver from the planned path |
| `estimate_new_eta` | Fresh ETA from the current position |
| `trigger_reassignment` | Hand a finding to the Coordinator |

**Emits:** `driver_unavailable`, `delay_detected`, `deadline_risk_detected`,
`risk_assessed` (LLM)

---

## Coordinator — `coordinator.ts`

**Job:** Orchestration. Decides which agent runs and when, and owns the
loops and branching. **It has no tools of its own** — it delegates.

**Dispatch flow — `dispatchOrder(orderId, { idempotencyKey })`:**
1. Idempotent short-circuit if the order is already assigned / picked up / delivering
2. `cycle_started`
3. Order Agent validates → set `dispatching`
4. `runPipeline`: Driver Agent → Routing Agent → Dispatch Agent
5. `cycle_completed` / `cycle_aborted` / `cycle_noop`

**Monitoring flow — `runMonitoringCycle()`:**
1. Monitoring Agent evaluates active deliveries → `monitoring_alert`
2. For each finding, `remediate`:
   - Work out whether a reroute and/or reassign is actually feasible
   - `bestAlternative(...)` — a **silent** what-if: run Driver + Routing + scoring
     with `quiet=true` to see who else could take it, without emitting events
   - Ask the LLM (`adviseRemediation`, choice constrained to the feasible set,
     deterministic fallback) → `remediation_decided`
   - Call `reroute` or `reassign`
3. `reroute`: Routing Agent recalculates. If the new ETA still misses the deadline
   **and** the package isn't picked up yet **and** a better driver can make it →
   escalate to `reassign`. Otherwise apply the new route (`reroute_kept`).
4. `reassign`: Dispatch Agent detaches the old driver → mark the delivery failed →
   order back to `dispatching` → re-run the pipeline excluding the old driver.

**Emits:** `cycle_started`, `delegating`, `cycle_completed`, `cycle_aborted`,
`cycle_noop`, `monitoring_alert`, `remediation_decided`, `reroute_requested`,
`reroute_applied`, `reroute_insufficient`, `reroute_kept`, `reassign_requested`,
`reassign_applied`, `reassign_failed`

---

## The LLM layer — `agents/llm.ts` (not an agent)

A shared capability. Provider auto-selects between an Ollama-format gateway and the
direct Anthropic API. Every call is validated, time-boxed (5–8s), and has a
deterministic fallback; events carry `source: "llm" | "deterministic"`.

| Function | Returns | Used by |
| --- | --- | --- |
| `interpretNote(note)` | `{ flags: { contactRequired, leaveUnattended, fragile, accessNotes } }` | Order Agent |
| `explainAssignment(input)` | `{ text }` — display-only "why this driver" sentence | Dispatch Agent |
| `narrateRisk(input)` | `{ message, severity }` | Monitoring Agent |
| `adviseRemediation(ctx)` | `{ strategy: 'reroute' \| 'reassign', rationale }` | Coordinator |

---

## Not agents

- **`Driver`** events in the feed are a human driver's own actions (`accept`,
  "I've collected the package", "Mark delivered"), handled in `server/src/services.ts`.
- **`TrafficFeed`** (`traffic_updated`) comes from the traffic simulator.

---

## The demo scenario, in agent terms

1. Merchant marks an order ready → **Coordinator** starts a cycle
2. **Order Agent** validates it
3. **Driver Agent** finds eligible drivers → **Routing Agent** routes each →
   **Dispatch Agent** scores and assigns the best one
4. A traffic incident closes a road on that route
5. **Monitoring Agent** recomputes the ETA, sees the deadline risk, raises a finding
6. **Coordinator** checks feasibility, gets an LLM recommendation, decides
7. **Routing Agent** recalculates; if that's not enough, **Dispatch Agent**
   reassigns to a faster driver
8. The customer's ETA updates
