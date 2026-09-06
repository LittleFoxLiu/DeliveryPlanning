# RoutePilot

A modular TypeScript route planning control room demo. Copy `.env.example` to `.env`, run `npm install`, then `npm run dev`. Vite loads the TypeScript entrypoint and injects the Supabase connection from environment variables.

The planner sorts express orders first, assigns them to drivers within maximum capacity, and adds heavy-traffic delay to the route estimate. Clicking a route card highlights its path on the SVG map.

The code is separated into `types.ts`, `data.ts`, `storage.ts`, `graph.ts`, `cloud.ts`, and `main.ts`. Demo edits are persisted to browser `localStorage`. After connecting a project in Settings, generated route snapshots are also written to Supabase. Schema and setup instructions are in [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md).
