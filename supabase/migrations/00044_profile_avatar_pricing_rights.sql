-- 1. Avatars: a picture per person, kept in a public "avatars" bucket (one folder per user id).
-- 2. Pricing: aircraft types get an "active" flag (only active types appear in the calculator) and the four requested types are added.
-- 3. Navigation fee method (bands per MTOW, or a formula scaled by MTOW) is kept in pricing_settings.
-- 4. Commercial staff manage the whole pricing module (aircraft, fees, navigation, route times, quotes, fuel prices).
-- Run in the Supabase SQL editor after 00043.

alter table public.profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- aircraft types: only the active ones are offered in the calculator
alter table public.aircraft_types add column if not exists active boolean not null default true;
update public.aircraft_types set active = false where code in ('737','max8','max9','757');
insert into public.aircraft_types (code, name, mtow_t, seats, cruise_kmh, burn_t_per_h, hour_cost_usd, crew, note, active) values
  ('crj2', 'Bombardier CRJ-200', 23.1, 50, 790, 1.4, 2500, 3, 'approximate public values: confirm MTOW, seats, burn and hour cost', true),
  ('b733', 'Boeing 737-300', 62.8, 144, 800, 2.5, 3200, 6, 'approximate public values: confirm MTOW, seats, burn and hour cost', true),
  ('b735', 'Boeing 737-500', 60.6, 120, 800, 2.4, 3200, 5, 'approximate public values: confirm MTOW, seats, burn and hour cost', true),
  ('b737', 'Boeing 737-700', 70.1, 140, 830, 2.4, 3500, 6, 'approximate public values: confirm MTOW, seats, burn and hour cost', true)
on conflict (code) do nothing;

-- navigation fee method
create table if not exists public.pricing_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.pricing_settings enable row level security;
insert into public.pricing_settings (key, value) values ('navigation', '{"mode":"bands","refMtow":50,"enroutePerKm":0,"terminalPerLeg":0}'::jsonb) on conflict (key) do nothing;
drop trigger if exists pricing_settings_touch on public.pricing_settings;
create trigger pricing_settings_touch before insert or update on public.pricing_settings
  for each row execute function public.touch_updated();

-- row level security: everyone approved reads, pricing staff write
do $$
declare t text;
begin
  drop policy if exists pricing_settings_select on public.pricing_settings;
  create policy pricing_settings_select on public.pricing_settings for select to authenticated
    using (coalesce((select public.current_role_name()), 'pending') <> 'pending');
  foreach t in array array['aircraft_types','airport_fee_lines','nav_rates','route_times','pricing_settings'] loop
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($p$create policy %I on public.%I for all to authenticated using (coalesce((select public.current_role_name()), '') in ('commercial','tour_operator_liaison','management')) with check (coalesce((select public.current_role_name()), '') in ('commercial','tour_operator_liaison','management'))$p$, t || '_write', t);
  end loop;
  -- fuel prices: schedule coordinators and management as before, plus commercial staff
  foreach t in array array['airport_fuel_prices','airport_fuel_price_history'] loop
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($p$create policy %I on public.%I for all to authenticated using (coalesce((select public.current_role_name()), '') in ('ops_coordinator','commercial','management')) with check (coalesce((select public.current_role_name()), '') in ('ops_coordinator','commercial','management'))$p$, t || '_write', t);
  end loop;
end $$;

-- quotes: commercial, liaison and management create and manage all quotes
drop policy if exists charter_quotes_insert on public.charter_quotes;
create policy charter_quotes_insert on public.charter_quotes for insert to authenticated
  with check (coalesce((select public.current_role_name()), '') in ('commercial','tour_operator_liaison','management') and created_by = auth.uid());
drop policy if exists charter_quotes_modify on public.charter_quotes;
create policy charter_quotes_modify on public.charter_quotes for all to authenticated
  using (coalesce((select public.current_role_name()), '') in ('commercial','tour_operator_liaison','management'))
  with check (coalesce((select public.current_role_name()), '') in ('commercial','tour_operator_liaison','management'));
