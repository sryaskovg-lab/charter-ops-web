-- Security pass.
--  1. New accounts start as 'pending': no access to any data until management promotes them.
--     The signup trigger no longer trusts a role passed in user metadata.
--  2. Nobody can change a role except management (and nobody can demote the last manager) --
--     previously any signed-in user could set their own role to management.
--  3. Read policies that were 'true' for every signed-in user now exclude pending accounts.
--  4. Tables that any signed-in user could write (tasks, notifications, drafts, acknowledged
--     issues, SCR log) are limited to active staff / the roles that actually use them.

-- 1. pending role + signup default
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('pending','commercial','tour_operator_liaison','ops_coordinator','management'));
alter table public.profiles alter column role set default 'pending';

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, role, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.email), 'pending', new.email);
  return new;
end $$;

-- 2. role changes: management only; never leave zero managers.
-- auth.uid() is null for the SQL editor and the service-role key (server routes), so those pass.
create or replace function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    if new.id is distinct from old.id then raise exception 'Profile id cannot change' using errcode = '42501'; end if;
    if new.role is distinct from old.role then
      if coalesce(public.current_role_name(), '') <> 'management' then
        raise exception 'Only management can change roles' using errcode = '42501';
      end if;
      if old.role = 'management' and new.role <> 'management'
         and not exists (select 1 from public.profiles where role = 'management' and id <> old.id) then
        raise exception 'Cannot demote the last manager' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_update on public.profiles;
create trigger profiles_guard_update before update on public.profiles
  for each row execute function public.guard_profile_update();
revoke all on function public.guard_profile_update() from public, anon, authenticated;

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- 3. pending accounts read nothing (except their own profile, so the app can tell them to wait)
do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
           where schemaname = 'public' and cmd = 'SELECT' and qual = 'true' and tablename <> 'profiles' loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    execute format('create policy %I on public.%I for select to authenticated using (coalesce((select public.current_role_name()), ''pending'') <> ''pending'')', r.policyname, r.tablename);
  end loop;
end $$;
drop policy if exists profiles_select_all on public.profiles;
create policy profiles_select_all on public.profiles for select to authenticated
  using (id = (select auth.uid()) or coalesce((select public.current_role_name()), 'pending') <> 'pending');

-- 4. formerly open-write tables
drop policy if exists tasks_all_authenticated on public.tasks;
create policy tasks_write_active on public.tasks for all to authenticated
  using (coalesce((select public.current_role_name()), 'pending') <> 'pending')
  with check (coalesce((select public.current_role_name()), 'pending') <> 'pending');

drop policy if exists ack_issues_write_all on public.acknowledged_issues;
create policy ack_issues_write_active on public.acknowledged_issues for all to authenticated
  using (coalesce((select public.current_role_name()), 'pending') <> 'pending')
  with check (coalesce((select public.current_role_name()), 'pending') <> 'pending');

drop policy if exists draft_changes_write_all on public.draft_changes;
create policy draft_changes_write_ops on public.draft_changes for all to authenticated
  using ((select public.current_role_name()) in ('ops_coordinator','management'))
  with check ((select public.current_role_name()) in ('ops_coordinator','management'));

drop policy if exists notifications_insert_all on public.notifications;
create policy notifications_insert_active on public.notifications for insert to authenticated
  with check (coalesce((select public.current_role_name()), 'pending') <> 'pending');

drop policy if exists scr_log_insert_all on public.scr_log;
create policy scr_log_insert_ops on public.scr_log for insert to authenticated
  with check ((select public.current_role_name()) in ('ops_coordinator','management') and created_by = (select auth.uid()));
