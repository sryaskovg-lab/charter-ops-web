-- Flight numbers legitimately recur — the same ref (e.g. DV1234) flies every Friday for a
-- whole season. A bare UNIQUE(ref) made that impossible, which is why rotation generation
-- (deliberately reusing one ref across many dates) failed with a constraint violation.
-- What should actually be unique is (ref, departure) — the same flight number can't be
-- scheduled twice at the exact same instant, but recurring across different dates is normal.
alter table public.flights drop constraint flights_ref_key;
alter table public.flights add constraint flights_ref_departure_key unique (ref, scheduled_departure);
