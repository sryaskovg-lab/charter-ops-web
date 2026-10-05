-- Tour-operator history: who changed an operator's rates, contract terms or already-allocated
-- prices, and when. Written ONLY by database triggers (SECURITY DEFINER), so no client code
-- path -- including a direct API call -- can change a price without leaving a row here, and
-- nobody can edit or delete history (no insert/update/delete policies exist).
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,                       -- auth.uid(); null for system jobs (cron, service role)
  actor_name text,
  kind text not null,               -- rate_set | rate_removed | default_rate | allotment_type | option_days | allotment_reprice | change_requested | change_approved | change_discarded
  tour_operator_id uuid,            -- deliberately no FK: history must survive (and not block) deleting an operator
  details jsonb not null default '{}'::jsonb
);
create index audit_log_operator_at_idx on public.audit_log (tour_operator_id, at desc);
alter table public.audit_log enable row level security;
create policy audit_log_select_all on public.audit_log for select to authenticated using (true);
alter publication supabase_realtime add table public.audit_log;

create or replace function public._audit_actor() returns table(uid uuid, nm text)
language sql stable security definer set search_path = public as $$
  select auth.uid(), (select coalesce(p.name, p.email) from public.profiles p where p.id = auth.uid())
$$;

-- contracts: one row per changed rate key / scalar term
create or replace function public.audit_contract_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare a record; k text; ov jsonb; nv jsonb;
begin
  select * into a from public._audit_actor();
  for k in select jsonb_object_keys(coalesce(old.rates_by_destination,'{}'::jsonb) || coalesce(new.rates_by_destination,'{}'::jsonb)) loop
    ov := coalesce(old.rates_by_destination,'{}'::jsonb) -> k;
    nv := coalesce(new.rates_by_destination,'{}'::jsonb) -> k;
    if ov is distinct from nv then
      insert into public.audit_log(actor, actor_name, kind, tour_operator_id, details)
      values (a.uid, a.nm, case when nv is null then 'rate_removed' else 'rate_set' end, new.tour_operator_id,
              jsonb_build_object('key', k, 'old', ov, 'new', nv));
    end if;
  end loop;
  if new.rate_per_seat is distinct from old.rate_per_seat then
    insert into public.audit_log(actor, actor_name, kind, tour_operator_id, details)
    values (a.uid, a.nm, 'default_rate', new.tour_operator_id, jsonb_build_object('old', old.rate_per_seat, 'new', new.rate_per_seat));
  end if;
  if new.default_allotment_type is distinct from old.default_allotment_type then
    insert into public.audit_log(actor, actor_name, kind, tour_operator_id, details)
    values (a.uid, a.nm, 'allotment_type', new.tour_operator_id, jsonb_build_object('old', old.default_allotment_type, 'new', new.default_allotment_type));
  end if;
  if new.default_option_release_days is distinct from old.default_option_release_days then
    insert into public.audit_log(actor, actor_name, kind, tour_operator_id, details)
    values (a.uid, a.nm, 'option_days', new.tour_operator_id, jsonb_build_object('old', old.default_option_release_days, 'new', new.default_option_release_days));
  end if;
  return new;
end $$;
create trigger contracts_audit after update on public.contracts
  for each row execute function public.audit_contract_update();

-- already-allocated prices (single "Change price" and bulk "Apply to allocations")
create or replace function public.audit_allotment_price() returns trigger
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  if new.price_per_seat is distinct from old.price_per_seat then
    select * into a from public._audit_actor();
    insert into public.audit_log(actor, actor_name, kind, tour_operator_id, details)
    values (a.uid, a.nm, 'allotment_reprice', new.tour_operator_id,
            jsonb_build_object('allotment_id', new.id, 'flight_id', new.flight_id, 'seats', new.seats_allocated,
                               'trip_type', new.trip_type, 'old', old.price_per_seat, 'new', new.price_per_seat));
  end if;
  return new;
end $$;
create trigger allotments_audit_price after update on public.allotments
  for each row execute function public.audit_allotment_price();

-- sign-off requests: filed / approved / discarded
create or replace function public.audit_change_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare a record; approved boolean;
begin
  select * into a from public._audit_actor();
  if tg_op = 'INSERT' then
    insert into public.audit_log(actor, actor_name, kind, tour_operator_id, details)
    values (a.uid, a.nm, 'change_requested', new.tour_operator_id, jsonb_build_object('summary', new.summary, 'patch', new.patch));
    return new;
  end if;
  approved := coalesce(current_setting('app.contract_approval', true), '') = 'on';
  insert into public.audit_log(actor, actor_name, kind, tour_operator_id, details)
  values (a.uid, a.nm, case when approved then 'change_approved' else 'change_discarded' end, old.tour_operator_id,
          jsonb_build_object('summary', old.summary, 'patch', old.patch, 'requested_by', old.requested_by));
  return old;
end $$;
create trigger change_requests_audit_ins after insert on public.contract_change_requests
  for each row execute function public.audit_change_request();
create trigger change_requests_audit_del after delete on public.contract_change_requests
  for each row execute function public.audit_change_request();

-- If 00023 was first applied from an older copy of the file, these two functions return the
-- contracts row type instead of jsonb; Postgres can't change a return type in place, so drop
-- and recreate both (apply_contract_patch first, since approve_contract_change calls it).
drop function if exists public.approve_contract_change(uuid);
drop function if exists public.apply_contract_patch(uuid, jsonb);
create function public.apply_contract_patch(p_operator_id uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if coalesce(public.current_role_name(), '') <> 'management' then
    raise exception 'Only management can change contract terms' using errcode = '42501';
  end if;
  update public.contracts c set
    rates_by_destination =
      (coalesce(c.rates_by_destination, '{}'::jsonb)
        - array(select jsonb_array_elements_text(coalesce(p_patch->'ratesRemove', '[]'::jsonb))))
      || coalesce(p_patch->'ratesSet', '{}'::jsonb),
    rate_per_seat = case when p_patch ? 'defaultRate' then (p_patch->>'defaultRate')::numeric else c.rate_per_seat end,
    default_allotment_type = case when p_patch ? 'allotmentType' then p_patch->>'allotmentType' else c.default_allotment_type end,
    default_option_release_days = case when p_patch ? 'optionReleaseDays' then (p_patch->>'optionReleaseDays')::int else c.default_option_release_days end
  where c.tour_operator_id = p_operator_id
  returning c.* into r;
  if r.id is null then raise exception 'No contract for operator %', p_operator_id; end if;
  return to_jsonb(r);
end $$;

-- approve_contract_change flags the delete as an approval (transaction-local)
create function public.approve_contract_change(p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare req record; r jsonb;
begin
  if coalesce(public.current_role_name(), '') <> 'management' then
    raise exception 'Only management can approve contract changes' using errcode = '42501';
  end if;
  select * into req from public.contract_change_requests where id = p_request_id for update;
  if req.id is null then raise exception 'Request already handled'; end if;
  perform set_config('app.contract_approval', 'on', true);
  r := public.apply_contract_patch(req.tour_operator_id, req.patch);
  delete from public.contract_change_requests where id = p_request_id;
  perform set_config('app.contract_approval', 'off', true);
  return r;
end $$;

-- advisor fixes: trigger/helper functions must not be callable through the API
revoke all on function public.guard_allotment_price() from public, anon, authenticated;
revoke all on function public.audit_contract_update() from public, anon, authenticated;
revoke all on function public.audit_allotment_price() from public, anon, authenticated;
revoke all on function public.audit_change_request() from public, anon, authenticated;
revoke all on function public._audit_actor() from public, anon, authenticated;
-- RLS policy performance: evaluate auth.uid() once per statement, not per row
drop policy if exists contract_change_requests_insert on public.contract_change_requests;
create policy contract_change_requests_insert on public.contract_change_requests for insert to authenticated
  with check (public.current_role_name() in ('tour_operator_liaison','management') and requested_by = (select auth.uid()));
drop policy if exists contract_change_requests_delete on public.contract_change_requests;
create policy contract_change_requests_delete on public.contract_change_requests for delete to authenticated
  using (public.current_role_name() = 'management' or requested_by = (select auth.uid()));

-- drop removed the grants; restore them (same as 00023)
revoke all on function public.apply_contract_patch(uuid, jsonb) from public, anon;
revoke all on function public.approve_contract_change(uuid) from public, anon;
grant execute on function public.apply_contract_patch(uuid, jsonb) to authenticated;
grant execute on function public.approve_contract_change(uuid) to authenticated;
