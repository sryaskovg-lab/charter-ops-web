-- Charter flight price calculation: aircraft types, airport fee lists, navigation rates and saved quotes (all prices in USD).
-- Run in the Supabase SQL editor, then run 00042_charter_fee_seed.sql to load the airport fee lists.
create table if not exists public.aircraft_types (
  code text primary key,
  name text not null,
  mtow_t numeric not null check (mtow_t > 0),
  seats int not null check (seats > 0),
  cruise_kmh numeric not null default 850 check (cruise_kmh > 0),
  burn_t_per_h numeric not null default 2.5 check (burn_t_per_h >= 0),
  hour_cost_usd numeric not null default 4000 check (hour_cost_usd >= 0),
  crew int not null default 7 check (crew >= 0),
  note text
);

create table if not exists public.airport_fee_lines (
  id bigint generated always as identity primary key,
  airport text not null check (airport = upper(airport) and length(airport) between 3 and 4),
  fee_set text not null default 'STD' check (fee_set in ('STD','INT','DOM')),   -- STD standard, INT international (МВЛ), DOM domestic (ВВЛ)
  sort int not null default 0,
  name text not null,
  basis text not null check (basis in ('turnaround','time','pax','crew','mtow_t','fuel_t','litre')),
  price_usd numeric not null check (price_usd >= 0),
  quantity numeric,                      -- default quantity for turnaround / time / litre lines
  period_minutes int,                    -- length of one period for time lines
  aircraft_type text references public.aircraft_types(code) on update cascade on delete set null,  -- line applies to this type only
  source text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists airport_fee_lines_airport_idx on public.airport_fee_lines (airport, fee_set, sort);

create table if not exists public.nav_rates (
  id bigint generated always as identity primary key,
  mtow_from numeric not null,
  mtow_to numeric not null,
  enroute_usd_per_km numeric not null check (enroute_usd_per_km >= 0),
  terminal_usd_per_leg numeric not null check (terminal_usd_per_leg >= 0),
  note text,
  check (mtow_to >= mtow_from)
);

create table if not exists public.charter_quotes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  aircraft_type text,
  route text,
  pax int,
  inputs jsonb not null,
  result jsonb not null,
  total_usd numeric not null,
  per_seat_usd numeric,
  per_block_hour_usd numeric,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists charter_quotes_created_idx on public.charter_quotes (created_at desc);

create or replace function public.airport_fee_lines_touch() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
drop trigger if exists airport_fee_lines_touch on public.airport_fee_lines;
create trigger airport_fee_lines_touch before insert or update on public.airport_fee_lines
  for each row execute function public.airport_fee_lines_touch();

alter table public.aircraft_types enable row level security;
alter table public.airport_fee_lines enable row level security;
alter table public.nav_rates enable row level security;
alter table public.charter_quotes enable row level security;

do $$
declare t text;
begin
  foreach t in array array['aircraft_types','airport_fee_lines','nav_rates','charter_quotes'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($p$create policy %I on public.%I for select to authenticated using (coalesce((select public.current_role_name()), 'pending') <> 'pending')$p$, t || '_select', t);
  end loop;
  -- price data: contract staff and management
  foreach t in array array['aircraft_types','airport_fee_lines','nav_rates'] loop
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($p$create policy %I on public.%I for all to authenticated using (coalesce((select public.current_role_name()), '') in ('tour_operator_liaison','management')) with check (coalesce((select public.current_role_name()), '') in ('tour_operator_liaison','management'))$p$, t || '_write', t);
  end loop;
end $$;

-- quotes: commercial staff, liaison and management create; you change your own, management changes all
drop policy if exists charter_quotes_insert on public.charter_quotes;
create policy charter_quotes_insert on public.charter_quotes for insert to authenticated
  with check (coalesce((select public.current_role_name()), '') in ('commercial','tour_operator_liaison','management') and created_by = auth.uid());
drop policy if exists charter_quotes_modify on public.charter_quotes;
create policy charter_quotes_modify on public.charter_quotes for all to authenticated
  using (coalesce((select public.current_role_name()), '') = 'management' or (created_by = auth.uid() and coalesce((select public.current_role_name()), '') in ('commercial','tour_operator_liaison')))
  with check (coalesce((select public.current_role_name()), '') = 'management' or (created_by = auth.uid() and coalesce((select public.current_role_name()), '') in ('commercial','tour_operator_liaison')));
