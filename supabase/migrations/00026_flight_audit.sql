-- Flight history: who created, changed (aircraft, times, capacity, status, ...) or deleted a
-- flight, and when. Same table and approach as the tour-operator history (00024): written only
-- by database triggers, so no code path or direct API call can change a flight without a row
-- here, and nobody can edit or delete entries. flight_id deliberately has no foreign key so the
-- history of a deleted flight survives it.
alter table public.audit_log add column if not exists flight_id uuid;
create index if not exists audit_log_flight_at_idx on public.audit_log (flight_id, at desc) where flight_id is not null;

create or replace function public.audit_flight_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare a record; ch jsonb := '{}'::jsonb; rc text; held int; allots int;
begin
  select * into a from public._audit_actor();
  if tg_op = 'INSERT' then
    select code into rc from public.resources where id = new.resource_id;
    insert into public.audit_log(actor, actor_name, kind, flight_id, details)
    values (a.uid, a.nm, 'flight_created', new.id, jsonb_build_object(
      'ref', new.ref, 'aircraft', rc, 'origin', new.origin, 'destination', new.destination,
      'departure', new.scheduled_departure, 'arrival', new.scheduled_arrival, 'capacity', new.capacity, 'status', new.status));
    return new;
  elsif tg_op = 'UPDATE' then
    if new.resource_id is distinct from old.resource_id then
      ch := ch || jsonb_build_object('aircraft', jsonb_build_object(
        'old', (select code from public.resources where id = old.resource_id),
        'new', (select code from public.resources where id = new.resource_id)));
    end if;
    if new.ref is distinct from old.ref then ch := ch || jsonb_build_object('ref', jsonb_build_object('old', old.ref, 'new', new.ref)); end if;
    if new.origin is distinct from old.origin then ch := ch || jsonb_build_object('origin', jsonb_build_object('old', old.origin, 'new', new.origin)); end if;
    if new.destination is distinct from old.destination then ch := ch || jsonb_build_object('destination', jsonb_build_object('old', old.destination, 'new', new.destination)); end if;
    if new.scheduled_departure is distinct from old.scheduled_departure then ch := ch || jsonb_build_object('departure', jsonb_build_object('old', old.scheduled_departure, 'new', new.scheduled_departure)); end if;
    if new.scheduled_arrival is distinct from old.scheduled_arrival then ch := ch || jsonb_build_object('arrival', jsonb_build_object('old', old.scheduled_arrival, 'new', new.scheduled_arrival)); end if;
    if new.capacity is distinct from old.capacity then ch := ch || jsonb_build_object('capacity', jsonb_build_object('old', old.capacity, 'new', new.capacity)); end if;
    if new.status is distinct from old.status then ch := ch || jsonb_build_object('status', jsonb_build_object('old', old.status, 'new', new.status)); end if;
    if new.leg_type is distinct from old.leg_type then ch := ch || jsonb_build_object('leg_type', jsonb_build_object('old', old.leg_type, 'new', new.leg_type)); end if;
    if ch <> '{}'::jsonb then   -- colour-only edits etc. are not logged
      insert into public.audit_log(actor, actor_name, kind, flight_id, details)
      values (a.uid, a.nm, 'flight_updated', new.id, jsonb_build_object('ref', new.ref, 'changes', ch));
    end if;
    return new;
  else -- DELETE (BEFORE trigger, so the cascade has not yet removed slots/allotments)
    select code into rc from public.resources where id = old.resource_id;
    select count(*) into held from public.slot_requests where flight_id = old.id and status in ('confirmed','offered','change_required');
    select count(*) into allots from public.allotments where flight_id = old.id and status not in ('cancelled','released');
    insert into public.audit_log(actor, actor_name, kind, flight_id, details)
    values (a.uid, a.nm, 'flight_deleted', old.id, jsonb_build_object(
      'ref', old.ref, 'aircraft', rc, 'origin', old.origin, 'destination', old.destination,
      'departure', old.scheduled_departure, 'held_slots', held, 'active_allotments', allots));
    return old;
  end if;
end $$;
revoke all on function public.audit_flight_change() from public, anon, authenticated;

drop trigger if exists flights_audit_ins on public.flights;
drop trigger if exists flights_audit_upd on public.flights;
drop trigger if exists flights_audit_del on public.flights;
create trigger flights_audit_ins after insert on public.flights for each row execute function public.audit_flight_change();
create trigger flights_audit_upd after update on public.flights for each row execute function public.audit_flight_change();
create trigger flights_audit_del before delete on public.flights for each row execute function public.audit_flight_change();
