-- Fuel prices in any currency: the unit text is now "<CUR>/<per>", for example EUR/tonne, KZT/litre, USD/USG.
-- Existing values (USD/tonne ...) stay valid.
alter table public.airport_fuel_prices drop constraint if exists airport_fuel_prices_unit_check;
alter table public.airport_fuel_prices add constraint airport_fuel_prices_unit_check check (unit ~ '^[A-Z]{3}/(tonne|kg|USG|litre)$');
alter table public.airport_fuel_price_history drop constraint if exists airport_fuel_price_history_unit_check;
alter table public.airport_fuel_price_history add constraint airport_fuel_price_history_unit_check check (unit ~ '^[A-Z]{3}/(tonne|kg|USG|litre)$');
