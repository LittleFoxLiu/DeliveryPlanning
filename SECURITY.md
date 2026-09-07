# Security notes

Self-audit performed during development. Scope: the Express API, the agent layer,
and the browser client.

## Authentication & sessions

- Passwords: `crypto.scrypt` with a 16-byte per-user salt; verification uses
  `crypto.timingSafeEqual`.
- Tokens: `payload.HMAC-SHA256(payload)` (base64url). Signature checked with
  `timingSafeEqual`; `exp` enforced; the user is re-loaded from the DB on every
  request so a deleted account is immediately locked out.
- `AUTH_SECRET` is required (≥16 chars) when `NODE_ENV=production`; dev uses a
  random per-process secret (tokens simply don't survive a restart).
- Login returns one generic error for "no such user" and "wrong password"
  (no user enumeration on the login path).

## Authorization

- `requireRole(...)` gates every role-specific route.
- Ownership is checked per resource, not just per role:
  - merchant → `order.merchant_id === user.refId`, and `store.merchant_id` on
    create;
  - customer → `order.customer_id === user.refId`;
  - driver → `delivery.driver_id === user.refId` for every accept/status call.
- Admin-only: fleet data, full assignment reasoning, agent event stream, manual
  dispatch, and **all `/sim/*` endpoints**.
- The LLM is never consulted for an authorization decision.

## Input handling

- Every request body goes through `validation.ts`: typed field extraction,
  length caps, enum whitelists.
- Coordinates are validated as finite numbers within `[0, gridSize]` — client
  coordinates are never trusted.
- Deadlines must be in the (near) future and within a sane horizon.
- Path id params must match `^[a-z]+_[a-z0-9]{6,40}$` — SQLi/IDOR probes like
  `' OR 1=1--` are rejected with 400 before any lookup.
- All SQL is parameterised. The only dynamic SQL fragments are built from
  hard-coded column-name lists, never from request data.
- `express.json({ limit: '128kb' })` caps body size.

## Race conditions / idempotency / state

- `assign_order` runs inside a transaction whose authoritative gate is an
  order-status compare-and-set: `UPDATE orders SET status='assigned' WHERE id=$1
  AND status IN ('validated','dispatching') RETURNING *`. That single statement
  row-locks; the second of two concurrent dispatch cycles for the same order sees
  0 rows affected, throws, and rolls back everything it did — no duplicate
  assignment, route, or driver-count change.
- `assignments.idempotency_key` is `UNIQUE`; replays with the same
  `Idempotency-Key` return the existing assignment.
- Order and delivery state transitions are validated against an explicit state
  machine; terminal states (`delivered`, `cancelled`) cannot transition out.
- Reassignment refuses to touch a delivery whose package is already picked up,
  or one that is already terminal. Driver load counts are rolled back on
  cancellation.

## Transport / headers / abuse

- Per-IP sliding-window rate limiting; a stricter bucket on `/auth/*`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`.
- No CORS headers ⇒ browsers block cross-origin API calls by default; the web
  client is same-origin (vite proxy in dev).
- SSE listeners are wrapped so a dead client socket can never roll back a
  legitimate transaction.

## Client (XSS)

- The browser client renders all server strings as text; every interpolation of
  user-controlled data into `innerHTML` goes through an HTML-escape helper.
- Item names, customer names, notes, and driver names are escaped at render time.

## LLM / agent safety

- The advisory model receives only enum issue-codes and numbers computed by the
  backend — no free-text user input, so prompt-injection has no vector.
- Its output is constrained to a two-value enum and validated; any deviation,
  non-JSON, timeout (6 s) or HTTP error falls back to the deterministic decision.
- Agents mutate the database only through the deterministic tool + repository
  layer, never from a model response.

## Known limitations (acceptable for the hackathon build)

- Signup reveals whether an email is already registered (common trade-off; the
  login path does not leak).
- `/sim/*` endpoints exist for the demo; they are admin-gated but would be
  removed/flagged in a real deployment.
- Rate-limit and idempotency state is in-process (single node). A multi-node
  deployment would move both to shared storage; the Postgres transaction guarantees
  still prevent double-assignment per node.
- Tokens are not revocable before expiry (12 h TTL).
