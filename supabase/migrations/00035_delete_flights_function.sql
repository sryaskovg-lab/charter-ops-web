-- Deletes many flights in one request and returns the ids that were deleted.
-- The app used to send one request per 150 flights; on a slow or unstable connection one of those requests
-- failed ("Failed to fetch") and left the job half done.
-- SECURITY INVOKER: the caller's own row-level-security rules apply, exactly as for a normal delete.
create or replace function public.delete_flights(ids uuid[])
returns uuid[]
language plpgsql
security invoker
set search_path = public
as $$
declare gone uuid[];
begin
  with d as (delete from public.flights where id = any(ids) returning id)
  select coalesce(array_agg(id), '{}') into gone from d;
  return gone;
end;
$$;
revoke all on function public.delete_flights(uuid[]) from public, anon;
grant execute on function public.delete_flights(uuid[]) to authenticated;
