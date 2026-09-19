-- Every SCR message this app has ever generated, across all the flows that produce one
-- (single flight, rotation generator, bulk import, scheduling engine, the standalone builder).
-- This didn't exist before — SCR text was only ever shown in a textarea for copy/paste, never
-- persisted — so there was no way to report on "what SCRs went out" until now.
create table public.scr_log (
  id uuid primary key default gen_random_uuid(),
  message_text text not null,
  clearance_airport text,
  season text,
  flight_ids uuid[] default '{}',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.scr_log enable row level security;
create policy scr_log_select_all on public.scr_log for select to authenticated using (true);
create policy scr_log_insert_all on public.scr_log for insert to authenticated with check (true);
