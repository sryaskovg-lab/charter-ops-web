-- What was asked for: the flights (ref|date|origin|destination|dep|arr, UTC) a permit request was made for.
-- Lets the app show later schedule changes and prepare an amendment e-mail.
alter table public.overfly_permits add column if not exists requested_flights text[];
alter table public.overfly_permits add column if not exists requested_at timestamptz;
