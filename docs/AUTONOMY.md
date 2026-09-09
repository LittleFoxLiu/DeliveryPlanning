# Autonomous Multi-Agent Architecture

How Delivery Planner turns six agent modules into a genuine autonomous operations
system: agents observe state, use typed tools, propose actions, critique each
other, revise, and execute **only** through a deterministic policy layer and the
Coordinator.

See also [AGENTS.md](AGENTS.md) (per-agent responsibilities) and
[APP-OVERVIEW.md](APP-OVERVIEW.md) (pages & features).

---

## The reasoning loop

Every dispatch and every recovery is one **`PlanningRun`** — an append-only,
persisted, inspectable object (`server/src/agents/protocol.ts`,
`runStore.ts`, table `agent_runs`).

```
Coordinator opens a run
        │
        ▼
Order Agent      ── order.get / order.validate / order.constraints (tools)
        │           advances state, interprets the delivery note (LLM, sandboxed)
        ▼
Driver Agent     ── drivers.list_eligible  → eligible pool + rejected+reasons
        │
        ▼
Routing Agent    ── routing.traffic_state, routing.estimate_delivery ×N
        │           authoritative Dijkstra routes / ETAs / traffic penalties
        ▼
Dispatch Agent   ── dispatch.score_candidates → AgentProposal(assign_driver, D)
        │
        ▼
Monitoring Agent ── AgentCritique: "D has only 3 min slack" + alternative D2
        │           (fires whenever the proposed driver is late or thin on slack)
        ▼
Dispatch Agent   ── AgentRevision: proposal → assign_driver(D2)
        │
        ▼
Coordinator      ── classifyRisk() + validateAction() (deterministic, no LLM)
        │           → PolicyCheck[] + RiskAssessment
        ▼
   auto | auto_policy | escalate | block
        │
        ▼
   atomic idempotent execution  (or an agent_escalations row for a human)
```

The critique/revision is **real**: `dispatch.score_candidates` actually
re-derives the ranking, the Monitoring Agent actually finds an on-time
alternative in that ranking, and the executed assignment reflects the revised
choice. Nothing is scripted. You can watch it live at **Admin → Autonomous Ops**.

---

## Structured agent protocol

Agents never exchange free text. Every message is a typed record on the run:

| Type | Meaning |
| --- | --- |
| `ToolCall` | one tool invocation — agent, tool, access, input/output summary, ok, error, duration |
| `AgentProposal` | proposed action + `target` + `Evidence[]` (each fact sourced from a tool) + risks |
| `AgentCritique` | `supported` / `objections[]` / `evidence[]` / optional concrete `alternative` |
| `AgentRevision` | previous proposal id → new proposal + `changes[]` + `reason` |
| `RiskAssessment` | `level: low\|medium\|high`, `reasons[]`, `autoExecutable` |
| `PolicyCheck` | one deterministic gate — name, passed, detail |
| `AgentDecision` | final action, `mode`, explanation, the policy checks, the risk |
| `ExecutionResult` | what actually happened in the DB |

The UI renders these as a chronological trace with a coloured dot per phase —
PROPOSED → OBJECTED → REVISED → RISK → DECISION → EXECUTED.

---

## Typed tools + least privilege

`server/src/agents/toolRegistry.ts` + `tools.ts`. Each tool declares:

- `access: 'read' | 'write'`
- `allowed: AgentName[]` — an allow-list, enforced on every call
- `input` — a strict validator that **rejects unknown keys** and bad id shapes

`invokeTool(run, agent, name, input)`:
1. unknown tool → `{ ok: false, error: 'unknown_tool' }` (recorded, never throws)
2. agent not in `allowed` → throws `ToolAccessError` (a security bug, not data)
3. input fails the schema → `{ ok: false, error: 'invalid_input: …' }`
4. runs with an 8 s timeout; any throw → `{ ok: false, error }`
5. appends a `ToolCall` to the run either way

Least-privilege examples (verified by tests):
- the **Monitoring Agent cannot call `dispatch.score_candidates`** or any write tool
- every `access: 'write'` tool is `allowed: ['Coordinator']` only
- the Dispatch Agent scores but does not execute — the Coordinator executes

`GET /admin/tools` lists the registry.

---

## Risk-calibrated human-in-the-loop

`server/src/agents/policy.ts`. Deterministic, no LLM.

| Action | Base risk | Autonomy |
| --- | --- | --- |
| reroute (same driver, new path) | **low** | execute |
| assign / reassign a driver | **medium** | execute *iff* every policy gate passes |
| plan is > 10 min late with no better option; no viable route; no eligible driver; ≥ 2 failed recoveries | **high** | **escalate to a human** |

`validateAction()` re-checks the proposal against ground truth — order state,
driver exists / available / has capacity headroom / vehicle-compatible / has a
position, route reachable. A human **cannot** approve past a failed policy gate
(you can't authorise a van-less large-package assignment).

Escalations land in `agent_escalations` and on the **Autonomous Ops** page with
**Approve & execute** / **Reject**. Approval re-runs the loop with
`humanApproved: true`, which lifts a HIGH-risk escalation to `auto_policy`
**only if the deterministic checks still pass**.

`POST /admin/escalations/:id` · `GET /admin/escalations`

---

## Deterministic safety boundary (preserved)

```
LLM  →  proposes / critiques / explains / narrates / interprets notes
         │  (validated against an enum or a char cap; deterministic fallback everywhere)
         ▼
Agent tools  →  ground truth: routes, ETAs, capacity, traffic, state
         ▼
policy.ts  →  risk + validateAction against the DB
         ▼
Coordinator  →  atomic, idempotent execution (order-status CAS + row lock + unique idempotency key)
         ▼
Database / Simulator
```

The LLM is never the source of truth for a number, an identifier, an
authorization decision, or a DB write. Turn it off (`llm.enabled = false`) and
every path still runs — the fallbacks are exercised in the eval suite.

**Prompt injection:** the delivery note reaches only the Order Agent's
`interpretNote`, which maps it to a fixed shape
`{contactRequired, leaveUnattended, fragile, accessNotes}` (validated). It never
reaches the Driver / Routing / Dispatch agents, and it cannot express an action.
The eval scenario `adv_prompt_injection` dispatches the same order with and
without a hostile note and asserts the assignment is identical and nothing
leaked.

---

## Observability

- **`GET /admin/runs`** / **`GET /admin/runs/:id`** — run summaries + full trace + linked events
- Every `agent_events` row carries `run_id` + `cycle_id` (correlation id)
- Order detail (admin / merchant / customer) embeds the run — customers see a
  trimmed timeline ("How the agents decided")
- **Admin → Autonomous Ops** — live runs, the decision trace, pending escalations
- No hidden chain-of-thought is stored or shown — only typed messages + evidence

---

## Evaluation Center

`server/src/evaluation/`. **Admin → Evaluation → Run evaluation**
(`POST /admin/eval/run`). Reseeds, runs every scenario against the real agents,
computes metrics from what happened, then restores the demo world.

**Golden:** standard order · express order · three concurrent orders.

**Adversarial:** assigned driver goes offline · road closure on the route ·
infeasible deadline · no feasible driver in the fleet · large package with only
small vehicles free · prompt-injection note · malformed / unauthorised tool call.

Per scenario: pass/fail, delivered, deadline met, **unsafe actions**, tool
errors, escalations, autonomous actions, reassignments, route changes, planning
ms.

**Baseline comparison:** the same scenarios run against a non-agentic
"nearest-feasible-driver" strategy (`evaluation/baseline.ts`) with monitoring
disabled. Typical result: the baseline fails the driver-dropout and (partly) the
road-closure scenarios that the autonomous system recovers.

---

## Demo flow (≈ 3 min)

1. **Merchant → Orders → Mark ready** three orders. Toasts show autonomous assignment.
2. **Admin → Autonomous Ops** — open a run: tool calls → PROPOSED → critique →
   RISK MEDIUM → DECISION auto_policy (7/7 gates) → EXECUTED.
3. **Admin → Overview → ⚠ Simulate traffic incident** on an assigned order.
4. Back to **Autonomous Ops** — a new *remediation* run appears: Monitoring
   detects the risk, Coordinator decides `reroute` (low → auto) or `reassign`
   (medium → auto_policy). Customer ETA updates.
5. Take every driver offline (Fleet → Take offline ×5), mark another order ready
   → it **escalates**. Approve it on Autonomous Ops after bringing a driver back.
6. **Admin → Evaluation → Run evaluation** — 10/10, 0 unsafe actions, baseline
   comparison table.
