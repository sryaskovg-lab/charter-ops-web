-- Landing permits next to overfly permits, permits that apply to named flights only, an
-- airport -> State directory (so a flight's destination tells us which State's landing permit it
-- needs), and "proposals": permit decisions read from PDF/TXT attachments (Commander's Brief)
-- that a person confirms before anything changes.

-- ---------- Permit type, airport, specific flights ----------
alter table public.overfly_permits add column if not exists kind text not null default 'overfly';
alter table public.overfly_permits drop constraint if exists overfly_permits_kind_check;
alter table public.overfly_permits add constraint overfly_permits_kind_check check (kind in ('overfly','landing'));
alter table public.overfly_permits add column if not exists airport text;                       -- landing permits: optional, limits it to one airport
alter table public.overfly_permits add column if not exists flight_refs text[] not null default '{}'; -- empty = every flight in the period

-- history now records these fields too
create or replace function public.audit_permit_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare a record; ch jsonb := '{}'::jsonb;
begin
  select * into a from public._audit_actor();
  if tg_op = 'INSERT' then
    insert into public.audit_log(actor, actor_name, kind, permit_id, details)
    values (a.uid, a.nm, 'permit_created', new.id, jsonb_build_object(
      'state', new.state, 'type', new.kind, 'status', new.status, 'valid_from', new.valid_from, 'valid_to', new.valid_to,
      'aircraft', coalesce((select array_agg(code order by code) from public.resources where id = any(new.resource_ids)), '{}')));
    return new;
  elsif tg_op = 'UPDATE' then
    if new.state is distinct from old.state then ch := ch || jsonb_build_object('state', jsonb_build_object('old', old.state, 'new', new.state)); end if;
    if new.kind is distinct from old.kind then ch := ch || jsonb_build_object('type', jsonb_build_object('old', old.kind, 'new', new.kind)); end if;
    if new.airport is distinct from old.airport then ch := ch || jsonb_build_object('airport', jsonb_build_object('old', old.airport, 'new', new.airport)); end if;
    if new.flight_refs is distinct from old.flight_refs then ch := ch || jsonb_build_object('flights', jsonb_build_object('old', to_jsonb(old.flight_refs), 'new', to_jsonb(new.flight_refs))); end if;
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
      'state', old.state, 'type', old.kind, 'status', old.status, 'valid_from', old.valid_from, 'valid_to', old.valid_to, 'permit_number', old.permit_number));
    return old;
  end if;
end $$;
revoke all on function public.audit_permit_change() from public, anon, authenticated;

-- ---------- Airport -> State (landing permits) ----------
-- state NULL/empty = reviewed, no landing permit needed (e.g. your home base).
-- Landing checks start once the first airport is listed here.
create table if not exists public.airport_states (
  airport text primary key,
  state text,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.airport_states enable row level security;
drop policy if exists airport_states_select on public.airport_states;
create policy airport_states_select on public.airport_states for select to authenticated
  using (coalesce((select public.current_role_name()), 'pending') <> 'pending');
drop policy if exists airport_states_write on public.airport_states;
create policy airport_states_write on public.airport_states for all to authenticated
  using (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'))
  with check (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'));
drop trigger if exists airport_states_touch on public.airport_states;
create trigger airport_states_touch before update on public.airport_states for each row execute function public._permits_touch();

-- ---------- Proposals read from attachments ----------
create table if not exists public.permit_proposals (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null references public.permit_emails(id) on delete cascade,
  attachment_path text not null,
  file_name text,
  status text not null default 'pending' check (status in ('pending','done','empty','error')),
  items jsonb not null default '[]'::jsonb,   -- [{ kind,state,airport,decision,permitNumber,...,match,state:'open'|'applied'|'dismissed' }]
  summary text,
  error text,
  created_at timestamptz not null default now(),
  unique (email_id, attachment_path)
);
create index if not exists permit_proposals_status_idx on public.permit_proposals (status, created_at desc);
alter table public.permit_proposals enable row level security;
drop policy if exists permit_proposals_select on public.permit_proposals;
create policy permit_proposals_select on public.permit_proposals for select to authenticated
  using (coalesce((select public.current_role_name()), 'pending') <> 'pending');
-- people may only mark items applied/dismissed (update); rows are created by the server
drop policy if exists permit_proposals_update on public.permit_proposals;
create policy permit_proposals_update on public.permit_proposals for update to authenticated
  using (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'))
  with check (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'));

create or replace function public.permit_proposals_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    if new.email_id is distinct from old.email_id or new.attachment_path is distinct from old.attachment_path
       or new.file_name is distinct from old.file_name or new.summary is distinct from old.summary
       or new.error is distinct from old.error or new.created_at is distinct from old.created_at then
      raise exception 'Only the item decisions of a proposal can be changed';
    end if;
    if new.status not in ('pending','done') then raise exception 'Invalid status for a manual change'; end if;
  end if;
  return new;
end $$;
drop trigger if exists permit_proposals_guard_upd on public.permit_proposals;
create trigger permit_proposals_guard_upd before update on public.permit_proposals
  for each row execute function public.permit_proposals_guard();

-- ---------- Realtime ----------
do $$
declare t text;
begin
  foreach t in array array['airport_states','permit_proposals'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;
