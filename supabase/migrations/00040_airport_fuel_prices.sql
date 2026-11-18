-- Fuel price per airport (one current price per IATA code, for every airport in the schedule).
-- Run in the Supabase SQL editor. Read: every approved user. Write: schedule coordinators and management.
create table if not exists public.airport_fuel_prices (
  airport text primary key check (airport = upper(airport) and length(airport) between 3 and 4),
  price numeric not null check (price >= 0),
  unit text not null default 'USD/tonne' check (unit in ('USD/tonne','USD/kg','USD/USG','USD/litre')),
  supplier text,
  valid_from date,
  note text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.airport_fuel_prices enable row level security;
drop policy if exists airport_fuel_prices_select on public.airport_fuel_prices;
create policy airport_fuel_prices_select on public.airport_fuel_prices for select to authenticated
  using (coalesce((select public.current_role_name()), 'pending') <> 'pending');
drop policy if exists airport_fuel_prices_write on public.airport_fuel_prices;
create policy airport_fuel_prices_write on public.airport_fuel_prices for all to authenticated
  using (coalesce((select public.current_role_name()), '') in ('ops_coordinator','management'))
  with check (coalesce((select public.current_role_name()), '') in ('ops_coordinator','management'));

create or replace function public.airport_fuel_prices_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists airport_fuel_prices_touch on public.airport_fuel_prices;
create trigger airport_fuel_prices_touch before insert or update on public.airport_fuel_prices
  for each row execute function public.airport_fuel_prices_touch();

do $$ begin
  alter publication supabase_realtime add table public.airport_fuel_prices;
exception when duplicate_object then null; end $$;
