-- Replaces the placeholder demo operators (SunTrail Holidays etc.) with the real ones, in USD,
-- with per-destination rate overrides. Rates are placeholders pending real contract figures —
-- edit them from the Tour Operators tab (management/liaison).
delete from public.contracts;
delete from public.tour_operators;

insert into public.tour_operators (name, country, status) values
  ('ANEX', 'RU', 'active'),
  ('FS', 'RU', 'active'),
  ('JOIN UP', 'UA', 'active'),
  ('KOMPAS', 'RU', 'active'),
  ('ONE CLICK', 'KZ', 'on_hold'),
  ('PGS', 'RU', 'active'),
  ('SELFIE', 'RU', 'active');

insert into public.contracts (tour_operator_id, season, currency, rate_per_seat, rates_by_destination, default_allotment_type, default_option_release_days)
select id, 'S27', 'USD',
  case name
    when 'ANEX' then 115 when 'FS' then 110 when 'JOIN UP' then 125 when 'KOMPAS' then 105
    when 'ONE CLICK' then 118 when 'PGS' then 130 when 'SELFIE' then 105 end,
  case name
    when 'ANEX' then '{"SSH": 120, "HKT": 118}'::jsonb
    when 'JOIN UP' then '{"HRI": 128}'::jsonb
    when 'KOMPAS' then '{"PQC": 112}'::jsonb
    when 'PGS' then '{"SYX": 133}'::jsonb
    else '{}'::jsonb end,
  case name when 'JOIN UP' then 'option' when 'ONE CLICK' then 'option' else 'fixed' end,
  case name when 'JOIN UP' then 14 when 'ONE CLICK' then 10 else null end
from public.tour_operators;
