-- Basic sanity rules on flights. Deliberately NOT an overlap/exclusion constraint:
-- planners legitimately park tentative double-bookings while working, and the live data
-- already has overlapping pairs; overlap stays an advisory warning in the checker.
-- Verified against live data before writing: 0 rows violate either rule.

alter table public.flights
  drop constraint if exists flights_arrival_after_departure,
  drop constraint if exists flights_capacity_positive;

alter table public.flights
  add constraint flights_arrival_after_departure
    check (scheduled_arrival is null or scheduled_arrival > scheduled_departure),
  add constraint flights_capacity_positive
    check (capacity is not null and capacity > 0);
