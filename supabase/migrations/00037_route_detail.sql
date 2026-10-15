-- Airways flown over each country on a route, typed once and copied into agent permit requests
-- (the ROUTE part of the request: "PAKISTAN / MOTMO P500 PS J143 NONIB L509 SULOM / ...").
alter table public.route_overfly_states add column if not exists route_detail text;
