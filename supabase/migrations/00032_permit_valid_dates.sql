-- A permit can be limited to specific operating dates (a Commander's Brief lists the exact days
-- of each leg, e.g. "20,24-OCT; 29-OCT; 05,12,19,26-NOV"). Empty = every day between
-- valid_from and valid_to. valid_from / valid_to still hold the first and last of those dates.
alter table public.overfly_permits add column if not exists valid_dates date[] not null default '{}';

-- history records the dates too (same function as 00031 plus one line)
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
    if new.valid_dates is distinct from old.valid_dates then ch := ch || jsonb_build_object('dates', jsonb_build_object('old', coalesce(array_length(old.valid_dates, 1), 0) || ' dates', 'new', coalesce(array_length(new.valid_dates, 1), 0) || ' dates')); end if;
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
