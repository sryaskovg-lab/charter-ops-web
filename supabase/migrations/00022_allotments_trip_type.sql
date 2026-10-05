-- Roundtrip vs one-way is chosen per allocation. Allotments stay one row per flight leg; a
-- roundtrip allotment's price_per_seat is already the per-leg share (half the operator's
-- roundtrip rate for that route), so revenue math elsewhere is unchanged.
alter table public.allotments
  add column trip_type text not null default 'one_way' check (trip_type in ('one_way','roundtrip'));
