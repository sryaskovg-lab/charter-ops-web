-- Airport slot coordination, built as its own connected workspace rather than an extension of
-- SCR message generation. SCR (scr_log) is message drafting/archiving; this is the actual
-- slot-record lifecycle the IATA SSIM Ch.6 workflow runs on: one row per movement (a flight
-- normally has two — departure @origin, arrival @destination), carrying requested/offered/
-- confirmed times, who's responsible, a coordinator reference, and a deadline.
--
-- ATFM/CTOT records are deliberately a SEPARATE table with its own status, per the original
-- spec's explicit warning: "Airport slots must remain distinct from ATFM/CTOT restrictions...
-- They should not share one status field or be treated as interchangeable approvals." Nothing
-- here ever writes to the other table.
create table public.slot_requests (
  id uuid primary key default gen_random_uuid(),
  flight_id uuid not null references public.flights(id) on delete cascade,
  movement_type text not null check (movement_type in ('departure','arrival')),
  airport text not null,
  status text not null default 'draft' check (status in (
    'draft','ready_to_send','sent','offered','waitlisted','confirmed','rejected',
    'cancelled','change_required','not_required','unknown'
  )),
  requested_time timestamptz,
  offered_time timestamptz,
  confirmed_time timestamptz,
  coordinator_reference text,
  responsible_user_id uuid references public.profiles(id),
  action_deadline date,
  last_scr_log_id uuid references public.scr_log(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (flight_id, movement_type)
);

-- Append-only correspondence trail per slot — "an email came back", "coordinator called", etc.
-- Never edited or deleted, only added to, so it reads as a real audit trail.
create table public.slot_correspondence (
  id uuid primary key default gen_random_uuid(),
  slot_request_id uuid not null references public.slot_requests(id) on delete cascade,
  note text not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ATFM/CTOT — a received traffic-flow-management time, not something coordinated like a slot.
-- One flight can only have one; it's about departure, not movement-specific like slots are.
create table public.atfm_records (
  id uuid primary key default gen_random_uuid(),
  flight_id uuid not null references public.flights(id) on delete cascade,
  ctot timestamptz,
  regulation_reference text,
  status text not null default 'pending' check (status in ('pending','received','revised','cancelled')),
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (flight_id)
);

alter table public.slot_requests enable row level security;
alter table public.slot_correspondence enable row level security;
alter table public.atfm_records enable row level security;

create policy "slot_requests_select_all" on public.slot_requests for select to authenticated using (true);
create policy "slot_requests_write_ops" on public.slot_requests for all to authenticated
  using (public.current_role_name() in ('ops_coordinator','management'))
  with check (public.current_role_name() in ('ops_coordinator','management'));

create policy "slot_correspondence_select_all" on public.slot_correspondence for select to authenticated using (true);
create policy "slot_correspondence_write_ops" on public.slot_correspondence for all to authenticated
  using (public.current_role_name() in ('ops_coordinator','management'))
  with check (public.current_role_name() in ('ops_coordinator','management'));

create policy "atfm_records_select_all" on public.atfm_records for select to authenticated using (true);
create policy "atfm_records_write_ops" on public.atfm_records for all to authenticated
  using (public.current_role_name() in ('ops_coordinator','management'))
  with check (public.current_role_name() in ('ops_coordinator','management'));

alter publication supabase_realtime add table public.slot_requests;
alter publication supabase_realtime add table public.slot_correspondence;
alter publication supabase_realtime add table public.atfm_records;
