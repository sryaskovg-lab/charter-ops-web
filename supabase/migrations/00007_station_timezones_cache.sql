-- Cache of airport-code -> IANA timezone lookups from the APIFreaks Timezone Lookup API,
-- populated by app/api/timezone/route.js. Each station is looked up against the external
-- API at most once ever, across every user of this deployment.
create table public.station_timezones (
  code text primary key,
  tz text not null,
  source text not null default 'apifreaks',
  resolved_at timestamptz not null default now()
);

alter table public.station_timezones enable row level security;
create policy "station_timezones_select_all" on public.station_timezones for select to authenticated using (true);
-- No insert/update policy for authenticated/anon — only the server route (service-role key,
-- bypasses RLS) writes here.
