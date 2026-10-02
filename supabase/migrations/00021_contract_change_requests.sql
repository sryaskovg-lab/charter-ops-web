-- Management sign-off on tour-operator contract/rate terms: when a non-management user
-- (tour_operator_liaison) proposes a change to an operator's default rate, default allotment
-- type, option-release window, or per-route rate card, it's queued here instead of written
-- directly to the operators/contracts tables -- mirroring the draft_changes pattern already
-- used for schedule edits in Draft Mode. Management reviews and either approves (applies the
-- patch, then the row is deleted) or discards it (row deleted, nothing applied). No status
-- column, same as draft_changes: existence of a row = pending.
create table public.contract_change_requests (
  id uuid primary key default gen_random_uuid(),
  tour_operator_id uuid not null references public.tour_operators(id) on delete cascade,
  patch jsonb not null default '{}'::jsonb,
  summary text not null,
  requested_by uuid references public.profiles(id),
  requested_at timestamptz not null default now()
);
alter table public.contract_change_requests enable row level security;
create policy contract_change_requests_select_all on public.contract_change_requests for select to authenticated using (true);
create policy contract_change_requests_write_all on public.contract_change_requests for all to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.contract_change_requests;
