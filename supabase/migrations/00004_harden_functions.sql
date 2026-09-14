-- Fixes flagged by `get_advisors` after the initial schema: mutable search_path, and
-- SECURITY DEFINER functions callable directly over the REST API when they shouldn't be.
create or replace function public.current_role_name()
returns text as $$
  select role from public.profiles where id = auth.uid();
$$ language sql security definer stable set search_path = public;

revoke execute on function public.current_role_name() from public, anon;
grant execute on function public.current_role_name() to authenticated;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
