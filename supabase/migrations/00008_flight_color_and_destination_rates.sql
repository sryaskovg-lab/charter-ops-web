-- Custom box color per flight (nullable — null means "use the automatic status color").
alter table public.flights add column color text;

-- Per-destination rate overrides on top of a contract's default rate_per_seat.
-- e.g. {"SSH": 120, "HKT": 118} — anything not listed falls back to rate_per_seat.
alter table public.contracts add column rates_by_destination jsonb not null default '{}'::jsonb;

-- Switch to USD going forward.
alter table public.contracts alter column currency set default 'USD';
