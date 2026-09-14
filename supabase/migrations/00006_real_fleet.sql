-- Replaces the placeholder demo fleet with the operator's real aircraft.
-- Applied directly against the live project via the Supabase MCP connector on 2026-09-11;
-- this file exists so the change is reproducible/reviewable in git, not just a dashboard edit.

delete from public.allotments;
delete from public.maintenance_blocks;
delete from public.flights;
delete from public.resources;

insert into public.resources (type, code, variant, capacity) values
  ('aircraft', 'UP-B3748', 'B38M · 189Y', 189),
  ('aircraft', 'UP-B3749', 'B38M · 189Y', 189),
  ('aircraft', 'UP-B3726', 'B39M · 213Y', 213),
  ('aircraft', 'UP-B3727', 'B39M · 213Y', 213),
  ('aircraft', 'UP-B3738', 'B39M · 213Y', 213),
  ('aircraft', 'UP-B3739', 'B39M · 213Y', 213),
  ('aircraft', 'UP-B3740', 'B39M · 213Y', 213),
  ('aircraft', 'UP-B5704', 'B752 · 235Y', 235),
  ('aircraft', 'UP-B5705', 'B752 · 235Y', 235),
  ('aircraft', 'UP-B5703', 'B752 · 235Y', 235);
