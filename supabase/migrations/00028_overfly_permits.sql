-- Overfly permits: which States each route crosses, the permits requested/held per State
-- (per aircraft or all aircraft, with a validity period), their status history, notes and
-- documents. Flights are checked against this in the app (lib/permit-utils.js).
--
-- Access: every approved (non-pending) user can read; only ops_coordinator and management can
-- write. Permit changes are recorded by trigger in audit_log (new permit_id column), like flights
-- and tour-operator money changes, so nobody can change a permit without leaving a row.

-- ---------- States directory: processing lead time + authority contact ----------
create table if not exists public.overfly_states (
  state text primary key,                 -- upper-case code or name used on routes, e.g. 'TM' or 'TURKMENISTAN'
  lead_days int not null default 10 check (lead_days >= 0 and lead_days <= 365),
  authority text,
  contact text,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

-- ---------- Route -> States overflown (applies in both directions) ----------
create table if not exists public.route_overfly_states (
  id uuid primary key default gen_random_uuid(),
  origin text not null,
  destination text not null,
  states text[] not null default '{}',   -- empty array = route reviewed, crosses no State needing a permit
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  unique (origin, destination)
);

-- ---------- Permits ----------
create table if not exists public.overfly_permits (
  id uuid primary key default gen_random_uuid(),
  state text not null,
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','cancelled')),
  valid_from date,
  valid_to date,
  resource_ids uuid[] not null default '{}',  -- empty = valid for every aircraft
  permit_number text,
  authority text,
  authority_ref text,                          -- reference on the authority's side / request number
  submitted_at timestamptz,
  decided_at timestamptz,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint overfly_permits_dates check (valid_from is null or valid_to is null or valid_to >= valid_from)
);
create index if not exists overfly_permits_state_idx on public.overfly_permits (state, valid_to);

-- Append-only correspondence / progress notes
create table if not exists public.permit_notes (
  id uuid primary key default gen_random_uuid(),
  permit_id uuid not null references public.overfly_permits(id) on delete cascade,
  body text not null check (length(btrim(body)) > 0),
  created_by uuid default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists permit_notes_permit_idx on public.permit_notes (permit_id, created_at);

-- Uploaded approval documents (the files live in the private 'permit-docs' storage bucket)
create table if not exists public.permit_documents (
  id uuid primary key default gen_random_uuid(),
  permit_id uuid not null references public.overfly_permits(id) on delete cascade,
  path text not null unique,
  file_name text not null,
  size_bytes bigint,
  uploaded_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists permit_documents_permit_idx on public.permit_documents (permit_id);

-- ---------- RLS ----------
alter table public.overfly_states enable row level security;
alter table public.route_overfly_states enable row level security;
alter table public.overfly_permits enable row level security;
alter table public.permit_notes enable row level security;
alter table public.permit_documents enable row level security;

do $$
declare t text;
begin
  foreach t in array array['overfly_states','route_overfly_states','overfly_permits','permit_notes','permit_documents'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (coalesce((select public.current_role_name()), 'pending') <> 'pending')$p$, t || '_select', t);
  end loop;
  foreach t in array array['overfly_states','route_overfly_states','overfly_permits','permit_documents'] loop
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($p$create policy %I on public.%I for all to authenticated
      using (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'))
      with check (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'))$p$, t || '_write', t);
  end loop;
end $$;

-- notes: insert only (no update / delete policy => append-only), authored by the caller
drop policy if exists permit_notes_insert on public.permit_notes;
create policy permit_notes_insert on public.permit_notes for insert to authenticated
  with check (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management')
              and created_by = (select auth.uid()));

-- ---------- Keep updated_at honest ----------
create or replace function public._permits_touch() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists overfly_permits_touch on public.overfly_permits;
create trigger overfly_permits_touch before update on public.overfly_permits for each row execute function public._permits_touch();
drop trigger if exists overfly_states_touch on public.overfly_states;
create trigger overfly_states_touch before update on public.overfly_states for each row execute function public._permits_touch();
drop trigger if exists route_overfly_touch on public.route_overfly_states;
create trigger route_overfly_touch before update on public.route_overfly_states for each row execute function public._permits_touch();

-- ---------- History (audit_log) ----------
alter table public.audit_log add column if not exists permit_id uuid;
create index if not exists audit_log_permit_at_idx on public.audit_log (permit_id, at desc) where permit_id is not null;

create or replace function public.audit_permit_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare a record; ch jsonb := '{}'::jsonb;
begin
  select * into a from public._audit_actor();
  if tg_op = 'INSERT' then
    insert into public.audit_log(actor, actor_name, kind, permit_id, details)
    values (a.uid, a.nm, 'permit_created', new.id, jsonb_build_object(
      'state', new.state, 'status', new.status, 'valid_from', new.valid_from, 'valid_to', new.valid_to,
      'aircraft', coalesce((select array_agg(code order by code) from public.resources where id = any(new.resource_ids)), '{}')));
    return new;
  elsif tg_op = 'UPDATE' then
    if new.state is distinct from old.state then ch := ch || jsonb_build_object('state', jsonb_build_object('old', old.state, 'new', new.state)); end if;
    if new.status is distinct from old.status then ch := ch || jsonb_build_object('status', jsonb_build_object('old', old.status, 'new', new.status)); end if;
    if new.valid_from is distinct from old.valid_from then ch := ch || jsonb_build_object('valid_from', jsonb_build_object('old', old.valid_from, 'new', new.valid_from)); end if;
    if new.valid_to is distinct from old.valid_to then ch := ch || jsonb_build_object('valid_to', jsonb_build_object('old', old.valid_to, 'new', new.valid_to)); end if;
    if new.resource_ids is distinct from old.resource_ids then
      ch := ch || jsonb_build_object('aircraft', jsonb_build_object(
        'old', coalesce((select array_agg(code order by code) from public.resources where id = any(old.resource_ids)), '{}'),
        'new', coalesce((select array_agg(code order by code) from public.resources where id = any(new.resource_ids)), '{}')));
    end if;
    if new.permit_number is distinct from old.permit_number then ch := ch || jsonb_build_object('permit_number', jsonb_build_object('old', old.permit_number, 'new', new.permit_number)); end if;
    if new.authority_ref is distinct from old.authority_ref then ch := ch || jsonb_build_object('authority_ref', jsonb_build_object('old', old.authority_ref, 'new', new.authority_ref)); end if;
    if ch <> '{}'::jsonb then
      insert into public.audit_log(actor, actor_name, kind, permit_id, details)
      values (a.uid, a.nm, 'permit_updated', new.id, jsonb_build_object('state', new.state, 'changes', ch));
    end if;
    return new;
  else
    insert into public.audit_log(actor, actor_name, kind, permit_id, details)
    values (a.uid, a.nm, 'permit_deleted', old.id, jsonb_build_object(
      'state', old.state, 'status', old.status, 'valid_from', old.valid_from, 'valid_to', old.valid_to, 'permit_number', old.permit_number));
    return old;
  end if;
end $$;
revoke all on function public.audit_permit_change() from public, anon, authenticated;

drop trigger if exists permits_audit_ins on public.overfly_permits;
drop trigger if exists permits_audit_upd on public.overfly_permits;
drop trigger if exists permits_audit_del on public.overfly_permits;
create trigger permits_audit_ins after insert on public.overfly_permits for each row execute function public.audit_permit_change();
create trigger permits_audit_upd after update on public.overfly_permits for each row execute function public.audit_permit_change();
create trigger permits_audit_del before delete on public.overfly_permits for each row execute function public.audit_permit_change();

-- ---------- Realtime ----------
do $$
declare t text;
begin
  foreach t in array array['overfly_states','route_overfly_states','overfly_permits','permit_notes','permit_documents'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------- Document storage (private bucket) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('permit-docs', 'permit-docs', false, 15728640)
on conflict (id) do update set public = false, file_size_limit = 15728640;

drop policy if exists permit_docs_read on storage.objects;
drop policy if exists permit_docs_insert on storage.objects;
drop policy if exists permit_docs_delete on storage.objects;
create policy permit_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'permit-docs' and coalesce((select public.current_role_name()), 'pending') <> 'pending');
create policy permit_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'permit-docs' and coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'));
create policy permit_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'permit-docs' and coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'));
