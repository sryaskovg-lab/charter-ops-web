-- Optional — only needed when bootstrapping a fresh project. On the live project this data
-- was superseded by 00006_real_fleet.sql once the operator's actual aircraft were known.
insert into public.tour_operators (name, country, status) values
  ('SunTrail Holidays','UK','active'),
  ('Meridian Tours','UK','active'),
  ('Coastline Escapes','NL','active'),
  ('Northgate Travel','IE','on_hold')
on conflict do nothing;

insert into public.contracts (tour_operator_id, season, rate_per_seat, default_allotment_type, default_option_release_days)
select id, 'S27', case name
    when 'SunTrail Holidays' then 118
    when 'Meridian Tours' then 132
    when 'Coastline Escapes' then 109
    when 'Northgate Travel' then 125
  end,
  case name when 'Meridian Tours' then 'option' when 'Northgate Travel' then 'option' else 'fixed' end,
  case name when 'Meridian Tours' then 21 when 'Northgate Travel' then 14 else null end
from public.tour_operators
on conflict do nothing;
