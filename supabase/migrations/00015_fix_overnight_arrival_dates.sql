-- Every one of these is a real overnight flight (e.g. depart 22:30, arrive 05:40) whose
-- scheduled_arrival was computed onto the SAME calendar day as departure instead of the next
-- one — a bug in every flight-creation path (drawer edits, drag/resize, single-add, bulk
-- import, rotation generator) that combined the arrival's HH:MM with the departure's own date
-- without checking whether that rolled the arrival before the departure. Advancing arrival by
-- one day wherever it's currently at-or-before departure is the correct fix: it's exactly the
-- "crosses midnight" case, not a coincidence, and no flight should have zero or negative
-- duration in real operations.
update public.flights
set scheduled_arrival = scheduled_arrival + interval '1 day'
where scheduled_arrival <= scheduled_departure;
