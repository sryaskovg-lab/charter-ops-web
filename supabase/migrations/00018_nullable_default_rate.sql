-- Allows an operator to have no default rate at all, so every allotment for them then
-- requires an explicit price rather than silently falling back to a number nobody set
-- on purpose.
alter table public.contracts alter column rate_per_seat drop not null;
