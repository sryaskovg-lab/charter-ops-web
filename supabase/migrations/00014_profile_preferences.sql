-- Per-user UI preferences (starting with the Gantt board's box-size scale) — a person's own
-- settings, so they get read back on their next login regardless of which device they use.
alter table public.profiles add column if not exists preferences jsonb not null default '{}'::jsonb;
