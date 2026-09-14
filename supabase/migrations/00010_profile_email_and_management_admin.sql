-- Denormalize email onto profiles so the Team admin panel can list users without needing the
-- admin API just to display a name/email/role table. Note: profiles_select_all (migration
-- 00002) already lets every authenticated user read all profiles — adding email here means
-- every signed-in user can now see every teammate's email too. Fine for an internal staff
-- tool; revisit if that's not an acceptable tradeoff.
alter table public.profiles add column email text;

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, role, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    coalesce(new.raw_user_meta_data->>'role', 'commercial'),
    new.email
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- Management can change anyone's role (or name); everyone else still only edits their own row.
create policy "profiles_update_by_management" on public.profiles for update to authenticated
  using (public.current_role_name() = 'management')
  with check (public.current_role_name() = 'management');
