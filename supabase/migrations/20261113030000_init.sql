-- PS Health: initial schema
-- Single-owner app: the first account to sign in claims ownership; every table is
-- locked to that owner by row-level security.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- Private config (never exposed through the API)
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.config (
  key   text primary key,
  value text not null
);

insert into private.config (key, value)
values ('cron_secret', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- Is the caller the app owner?
create or replace function public.is_owner()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from private.config
    where key = 'owner_id' and value = (select auth.uid())::text
  );
$$;

-- First signed-in user claims the app. Returns true if the caller is (now) the owner.
create or replace function public.claim_owner()
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return false;
  end if;
  insert into private.config (key, value)
  values ('owner_id', (select auth.uid())::text)
  on conflict (key) do nothing;
  return public.is_owner();
end;
$$;

revoke all on function public.is_owner() from public, anon;
revoke all on function public.claim_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.claim_owner() to authenticated;

-- ---------------------------------------------------------------------------
-- Saved foods (the one-tap list)
-- ---------------------------------------------------------------------------
create table public.foods (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  name          text not null,
  portion_label text,
  components    jsonb not null default '[]',   -- [{name, grams, portion, nutrients, source}]
  nutrients     jsonb not null default '{}',   -- per one serving: kcal, protein, carbs, fat, sat_fat, fiber, soluble_fiber, sugar, sodium
  tags          text[] not null default '{}',  -- nut, soy, plant_sterol, soluble_fiber
  thumb         text,                          -- small JPEG data URL
  source        text,                          -- photo | text
  times_logged  int not null default 0,
  last_logged_at timestamptz,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Logged meals (each time something is eaten)
-- ---------------------------------------------------------------------------
create table public.meals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users on delete cascade,
  food_id        uuid references public.foods on delete set null,
  name           text not null,
  servings       numeric not null default 1,
  nutrients      jsonb not null default '{}',  -- already scaled by servings
  tags           text[] not null default '{}',
  eaten_at       timestamptz not null default now(),
  checkin_due_at timestamptz,
  checkin_pushed boolean not null default false,
  energy         text check (energy in ('wired','good','flat','crashed')),
  stomach        text check (stomach in ('great','fine','bloated','rough')),
  checked_in_at  timestamptz,
  created_at     timestamptz not null default now()
);
create index meals_user_eaten on public.meals (user_id, eaten_at desc);
create index meals_checkin_due on public.meals (checkin_due_at) where checkin_pushed = false;

create or replace function public.meals_set_due()
returns trigger language plpgsql as $$
begin
  if new.checkin_due_at is null then
    new.checkin_due_at := new.eaten_at + interval '2 hours';
  end if;
  return new;
end;
$$;
create trigger meals_set_due before insert on public.meals
  for each row execute function public.meals_set_due();

-- ---------------------------------------------------------------------------
-- Weight (optional) and lab results
-- ---------------------------------------------------------------------------
create table public.weights (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  measured_at timestamptz not null default now(),
  weight_lb   numeric not null check (weight_lb > 0)
);

create table public.labs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  taken_on      date not null,
  total_chol    numeric,
  ldl           numeric,
  hdl           numeric,
  triglycerides numeric,
  notes         text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Observations: weekly summaries and noticed patterns
-- ---------------------------------------------------------------------------
create table public.observations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  kind        text not null check (kind in ('weekly','pattern')),
  pattern_key text,
  title       text not null,
  short       text not null,     -- one line, used as the notification text
  body        jsonb not null,    -- structured sections for the detail view
  evidence    jsonb not null default '[]',
  created_at  timestamptz not null default now(),
  notified_at timestamptz,
  read_at     timestamptz
);
create index observations_user_created on public.observations (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Push subscriptions (one per device/browser)
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row-level security: owner only
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['foods','meals','weights','labs','observations','push_subscriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy owner_all on public.%I for all to authenticated
         using (user_id = (select auth.uid()) and (select public.is_owner()))
         with check (user_id = (select auth.uid()) and (select public.is_owner()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Scheduled jobs (times in UTC; Boston is UTC-5 in winter, UTC-4 in summer)
-- ---------------------------------------------------------------------------
create or replace function private.call_jobs(task text)
returns void language sql security definer set search_path = ''
as $$
  select net.http_post(
    url     := 'https://ktpztiyqyoalrwnqtqme.supabase.co/functions/v1/jobs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from private.config where key = 'cron_secret')
    ),
    body    := jsonb_build_object('task', task),
    timeout_milliseconds := 60000
  );
$$;

-- Meal check-ins: every 5 minutes
select cron.schedule('ps-health-checkins', '*/5 * * * *', $$ select private.call_jobs('checkins') $$);
-- Pattern scan: nightly ~2-3am Boston
select cron.schedule('ps-health-patterns', '0 7 * * *', $$ select private.call_jobs('patterns') $$);
-- Pattern notification (max one a day): ~12-1pm Boston
select cron.schedule('ps-health-notify', '0 17 * * *', $$ select private.call_jobs('notify') $$);
-- Weekly summary: Sunday ~8-9am Boston
select cron.schedule('ps-health-weekly', '0 13 * * 0', $$ select private.call_jobs('weekly') $$);
