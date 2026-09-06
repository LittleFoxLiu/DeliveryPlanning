# Supabase setup

1. Create a project at [supabase.com](https://supabase.com/).
2. Run [`supabase/schema.sql`](supabase/schema.sql) in Supabase SQL Editor.
3. Run [`supabase/seed.sql`](supabase/seed.sql) to add demo traffic, customer, driver, and route data.
4. Copy `.env.example` to `.env` and add your Project URL and public anon key:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

5. Run `npm install`, then `npm run dev`. Restart Vite after changing `.env`.

Never put the Supabase `service_role` key in `.env`. Use the public anon key with Row Level Security enabled.
