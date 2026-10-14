-- The aircraft type a flight was planned for (e.g. from an SSIM file: 7M9, 7M8, 752, 738).
-- Lets the app assign a tail of the right type, and keep flights of a type the airline does not own out of that assignment.
alter table public.flights add column if not exists aircraft_type text;
comment on column public.flights.aircraft_type is 'Planned aircraft type (canonical code such as B39M), null when unknown';
