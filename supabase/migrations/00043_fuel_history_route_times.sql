-- Monthly fuel price history per airport, and average flight time per route (used by the charter price calculator).
-- Run in the Supabase SQL editor after 00042.
create table if not exists public.airport_fuel_price_history (
  airport text not null check (airport = upper(airport) and length(airport) between 3 and 4),
  month date not null check (month = date_trunc('month', month)::date),
  price numeric not null check (price >= 0),
  unit text not null default 'USD/tonne' check (unit in ('USD/tonne','USD/kg','USD/USG','USD/litre')),
  supplier text,
  note text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (airport, month)
);
create index if not exists airport_fuel_price_history_month_idx on public.airport_fuel_price_history (month desc);

create table if not exists public.route_times (
  origin text not null check (origin = upper(origin) and length(origin) between 3 and 4),
  destination text not null check (destination = upper(destination) and length(destination) between 3 and 4),
  avg_minutes int not null check (avg_minutes > 0 and avg_minutes <= 1500),
  km numeric check (km is null or km >= 0),
  note text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (origin, destination)
);

alter table public.airport_fuel_price_history enable row level security;
alter table public.route_times enable row level security;
drop policy if exists airport_fuel_price_history_select on public.airport_fuel_price_history;
create policy airport_fuel_price_history_select on public.airport_fuel_price_history for select to authenticated
  using (coalesce((select public.current_role_name()), 'pending') <> 'pending');
drop policy if exists airport_fuel_price_history_write on public.airport_fuel_price_history;
create policy airport_fuel_price_history_write on public.airport_fuel_price_history for all to authenticated
  using (coalesce((select public.current_role_name()), '') in ('ops_coordinator','management'))
  with check (coalesce((select public.current_role_name()), '') in ('ops_coordinator','management'));
drop policy if exists route_times_select on public.route_times;
create policy route_times_select on public.route_times for select to authenticated
  using (coalesce((select public.current_role_name()), 'pending') <> 'pending');
drop policy if exists route_times_write on public.route_times;
create policy route_times_write on public.route_times for all to authenticated
  using (coalesce((select public.current_role_name()), '') in ('tour_operator_liaison','management'))
  with check (coalesce((select public.current_role_name()), '') in ('tour_operator_liaison','management'));

create or replace function public.touch_updated() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
drop trigger if exists airport_fuel_price_history_touch on public.airport_fuel_price_history;
create trigger airport_fuel_price_history_touch before insert or update on public.airport_fuel_price_history
  for each row execute function public.touch_updated();
drop trigger if exists route_times_touch on public.route_times;
create trigger route_times_touch before insert or update on public.route_times
  for each row execute function public.touch_updated();

-- Keep the "current price" table and the history in step (only at the top level, so the two triggers cannot loop):
-- a change of the current price is recorded in the history for its month; a history entry for the newest month becomes the current price.
create or replace function public.fuel_price_to_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  -- the month is the one typed in "valid from" when that was just changed, otherwise the current month
  insert into public.airport_fuel_price_history (airport, month, price, unit, supplier, note)
  values (new.airport,
          date_trunc('month', case when new.valid_from is not null and (tg_op = 'INSERT' or new.valid_from is distinct from old.valid_from) then new.valid_from else current_date end)::date,
          new.price, new.unit, new.supplier, new.note)
  on conflict (airport, month) do update set price = excluded.price, unit = excluded.unit, supplier = excluded.supplier, note = excluded.note;
  return new;
end $$;
drop trigger if exists airport_fuel_prices_history on public.airport_fuel_prices;
create trigger airport_fuel_prices_history after insert or update of price, unit, supplier on public.airport_fuel_prices
  for each row execute function public.fuel_price_to_history();

create or replace function public.fuel_history_to_current() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.month >= coalesce((select max(month) from public.airport_fuel_price_history where airport = new.airport), new.month) then
    insert into public.airport_fuel_prices (airport, price, unit, supplier, valid_from, note)
    values (new.airport, new.price, new.unit, new.supplier, new.month, new.note)
    on conflict (airport) do update set price = excluded.price, unit = excluded.unit, supplier = excluded.supplier, valid_from = excluded.valid_from, note = excluded.note;
  end if;
  return new;
end $$;
drop trigger if exists airport_fuel_history_current on public.airport_fuel_price_history;
create trigger airport_fuel_history_current after insert or update on public.airport_fuel_price_history
  for each row execute function public.fuel_history_to_current();

-- start the history from today's prices
insert into public.airport_fuel_price_history (airport, month, price, unit, supplier, note)
select airport, date_trunc('month', coalesce(valid_from, updated_at::date))::date, price, unit, supplier, note from public.airport_fuel_prices
on conflict (airport, month) do nothing;

do $$ begin
  alter publication supabase_realtime add table public.airport_fuel_price_history;
exception when duplicate_object then null; end $$;
