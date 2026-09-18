-- Draft Mode: when a session has it on, direct board edits (drag, resize, delete, duplicate,
-- color, and general flight-drawer edits) are queued here instead of applied live. flight_id
-- is null for a brand-new flight not yet in the flights table (change_type 'create'); patch
-- holds whatever fields are proposed. summary is computed once at creation time in plain
-- language, so the review panel never has to re-derive "what does this change actually mean"
-- from raw field diffs later.
create table public.draft_changes (
  id uuid primary key default gen_random_uuid(),
  flight_id uuid references public.flights(id) on delete cascade,
  change_type text not null check (change_type in ('move','resize','delete','duplicate','color','update','create')),
  patch jsonb not null default '{}'::jsonb,
  summary text not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.draft_changes enable row level security;
create policy draft_changes_select_all on public.draft_changes for select to authenticated using (true);
create policy draft_changes_write_all on public.draft_changes for all to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.draft_changes;
