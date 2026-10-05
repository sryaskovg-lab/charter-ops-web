-- Fixes for the tour-operator sign-off workflow:
--  1. Rate-card changes are now DELTA patches ({ratesSet, ratesRemove, defaultRate, ...}) merged
--     server-side in one atomic UPDATE, so two pending changes on one operator compose and
--     concurrent edits no longer overwrite each other's keys.
--  2. Management sign-off is enforced in the database, not just the UI: only management can
--     UPDATE contracts directly; liaison proposes via contract_change_requests.
--  3. contracts joins the realtime publication so open boards see approved rate changes live.

create or replace function public.apply_contract_patch(p_operator_id uuid, p_patch jsonb)
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

create or replace function public.approve_contract_change(p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare req record; r jsonb;
begin
  if coalesce(public.current_role_name(), '') <> 'management' then
    raise exception 'Only management can approve contract changes' using errcode = '42501';
  end if;
  select * into req from public.contract_change_requests where id = p_request_id for update;
  if req.id is null then raise exception 'Request already handled'; end if;
  r := public.apply_contract_patch(req.tour_operator_id, req.patch);
  delete from public.contract_change_requests where id = p_request_id;
  return r;
end $$;

revoke all on function public.apply_contract_patch(uuid, jsonb) from public, anon;
revoke all on function public.approve_contract_change(uuid) from public, anon;
grant execute on function public.apply_contract_patch(uuid, jsonb) to authenticated;
grant execute on function public.approve_contract_change(uuid) to authenticated;

-- contracts: insert/delete stay with liaison+management (operator creation); UPDATE is management only.
drop policy if exists contracts_write_liaison on public.contracts;
create policy contracts_insert_liaison on public.contracts for insert to authenticated
  with check (public.current_role_name() in ('tour_operator_liaison','management'));
create policy contracts_update_management on public.contracts for update to authenticated
  using (public.current_role_name() = 'management') with check (public.current_role_name() = 'management');
create policy contracts_delete_liaison on public.contracts for delete to authenticated
  using (public.current_role_name() in ('tour_operator_liaison','management'));

-- change requests: only liaison/management may file one (as themselves); management or the author may withdraw.
drop policy if exists contract_change_requests_write_all on public.contract_change_requests;
create policy contract_change_requests_insert on public.contract_change_requests for insert to authenticated
  with check (public.current_role_name() in ('tour_operator_liaison','management') and requested_by = auth.uid());
create policy contract_change_requests_delete on public.contract_change_requests for delete to authenticated
  using (public.current_role_name() = 'management' or requested_by = auth.uid());

-- allotment prices: commercial may create/edit seats but not re-price existing rows.
create or replace function public.guard_allotment_price() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.price_per_seat is distinct from old.price_per_seat
     and auth.uid() is not null
     and coalesce(public.current_role_name(), '') not in ('tour_operator_liaison','management') then
    raise exception 'Only contract staff can change allotment prices' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists allotments_guard_price on public.allotments;
create trigger allotments_guard_price before update on public.allotments
  for each row execute function public.guard_allotment_price();

alter publication supabase_realtime add table public.contracts;
