# PS Health

A personal food and nutrition app: snap or type what you eat, save it to a foods list for one-tap logging,
answer a quick energy/stomach check-in about two hours later, and get a Sunday summary plus pattern alerts.

- **App:** static PWA (`index.html`, `app.js`, `styles.css`, `sw.js`) on GitHub Pages
- **Backend:** Supabase (Postgres + row-level security, edge functions in `supabase/functions`, pg_cron jobs)
- **Food recognition:** Claude API; nutrition numbers from USDA FoodData Central

Deploys run automatically on push (`.github/workflows`). API keys live in Supabase secrets, never in this repo.
