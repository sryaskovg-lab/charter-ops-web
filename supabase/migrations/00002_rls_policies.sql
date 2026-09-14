
alter table public.profiles enable row level security;
alter table public.resources enable row level security;
alter table public.tour_operators enable row level security;
alter table public.contracts enable row level security;
alter table public.flights enable row level security;
alter table public.maintenance_blocks enable row level security;
alter table public.allotments enable row level security;
alter table public.rotation_templates enable row level security;

create policy "profiles_select_all" on public.profiles for select to authenticated using (true);
create policy "profiles_update_own" on public.profiles for update to authenticated using (id = auth.uid());

create policy "resources_select_all" on public.resources for select to authenticated using (true);
create policy "resources_write_ops" on public.resources for all to authenticated
  using (public.current_role_name() in ('ops_coordinator','management'))
  with check (public.current_role_name() in ('ops_coordinator','management'));

create policy "flights_select_all" on public.flights for select to authenticated using (true);
create policy "flights_write_ops" on public.flights for all to authenticated
  using (public.current_role_name() in ('ops_coordinator','management'))
  with check (public.current_role_name() in ('ops_coordinator','management'));

create policy "maintenance_select_all" on public.maintenance_blocks for select to authenticated using (true);
create policy "maintenance_write_ops" on public.maintenance_blocks for all to authenticated
  using (public.current_role_name() in ('ops_coordinator','management'))
  with check (public.current_role_name() in ('ops_coordinator','management'));

create policy "operators_select_all" on public.tour_operators for select to authenticated using (true);
create policy "operators_write_liaison" on public.tour_operators for all to authenticated
  using (public.current_role_name() in ('tour_operator_liaison','management'))
  with check (public.current_role_name() in ('tour_operator_liaison','management'));

create policy "contracts_select_all" on public.contracts for select to authenticated using (true);
create policy "contracts_write_liaison" on public.contracts for all to authenticated
  using (public.current_role_name() in ('tour_operator_liaison','management'))
  with check (public.current_role_name() in ('tour_operator_liaison','management'));

create policy "allotments_select_all" on public.allotments for select to authenticated using (true);
create policy "allotments_write_commercial" on public.allotments for all to authenticated
  using (public.current_role_name() in ('commercial','tour_operator_liaison','management'))
  with check (public.current_role_name() in ('commercial','tour_operator_liaison','management'));

create policy "rotation_select_all" on public.rotation_templates for select to authenticated using (true);
create policy "rotation_write_ops" on public.rotation_templates for all to authenticated
  using (public.current_role_name() in ('ops_coordinator','management'))
  with check (public.current_role_name() in ('ops_coordinator','management'));
