-- Tracks which computed schedule issues someone has reviewed and acknowledged. Issue IDs are
-- deterministic (built from flight id + issue kind, e.g. "turn-<flightId>"), so acknowledging
-- one specific issue persists correctly across reloads and for every user, until it's deleted
-- here or the underlying flight changes enough that the issue simply stops being computed.
create table public.acknowledged_issues (
  issue_id text primary key,
  acknowledged_by uuid references public.profiles(id),
  acknowledged_at timestamptz not null default now()
);
alter table public.acknowledged_issues enable row level security;
create policy ack_issues_select_all on public.acknowledged_issues for select to authenticated using (true);
create policy ack_issues_write_all on public.acknowledged_issues for all to authenticated using (true) with check (true);
