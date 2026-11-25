-- Fees can be entered in any currency. The original amount and currency are kept; price_usd / *_usd columns stay as the
-- USD snapshot at the time of saving and are used when no live rate is available. The calculator converts at the live rate.
alter table public.airport_fee_lines add column if not exists currency text not null default 'USD';
alter table public.airport_fee_lines add column if not exists price_orig numeric;
alter table public.nav_rates add column if not exists currency text not null default 'USD';
alter table public.nav_rates add column if not exists enroute_orig numeric;
alter table public.nav_rates add column if not exists terminal_orig numeric;
