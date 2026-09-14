
create extension if not exists "pgcrypto";

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'commercial'
    check (role in ('commercial','tour_operator_liaison','ops_coordinator','management')),
  created_at timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    coalesce(new.raw_user_meta_data->>'role', 'commercial')
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create function public.current_role_name()
returns text as $$
  select role from public.profiles where id = auth.uid();
$$ language sql security definer stable set search_path = public;

revoke execute on function public.current_role_name() from public, anon;
grant execute on function public.current_role_name() to authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create table public.resources (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'aircraft' check (type in ('aircraft','coach','vessel','custom')),
  code text not null unique,
  variant text,
  base_station text,
  capacity int not null,
  ownership text default 'owned' check (ownership in ('owned','wet_leased','subcontracted')),
  status text not null default 'active' check (status in ('active','maintenance','stored','withdrawn')),
  created_at timestamptz not null default now()
);

create table public.tour_operators (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text,
  status text not null default 'active' check (status in ('active','on_hold','blacklisted')),
  credit_terms_days int,
  credit_limit numeric,
  created_at timestamptz not null default now()
);

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  tour_operator_id uuid not null references public.tour_operators(id) on delete cascade,
  season text not null,
  currency char(3) not null default 'GBP',
  rate_per_seat numeric not null,
  default_allotment_type text not null default 'fixed' check (default_allotment_type in ('fixed','option')),
  default_option_release_days int,
  status text not null default 'active' check (status in ('draft','active','closed')),
  created_at timestamptz not null default now()
);

create table public.flights (
  id uuid primary key default gen_random_uuid(),
  ref text unique,
  resource_id uuid references public.resources(id),
  origin text not null,
  destination text not null,
  scheduled_departure timestamptz not null,
  scheduled_arrival timestamptz,
  capacity int not null,
  leg_type text not null default 'revenue' check (leg_type in ('revenue','ferry')),
  status text not null default 'tentative' check (status in ('tentative','confirmed','operating','completed','cancelled')),
  import_batch_id uuid,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_flights_resource_date on public.flights (resource_id, scheduled_departure);

create table public.maintenance_blocks (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text
);

create table public.allotments (
  id uuid primary key default gen_random_uuid(),
  flight_id uuid not null references public.flights(id) on delete cascade,
  tour_operator_id uuid not null references public.tour_operators(id),
  contract_id uuid references public.contracts(id),
  seats_allocated int not null check (seats_allocated > 0),
  price_per_seat numeric not null,
  allotment_type text not null default 'fixed' check (allotment_type in ('fixed','option')),
  option_release_at timestamptz,
  status text not null default 'active' check (status in ('active','confirmed','released','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_allotments_flight on public.allotments (flight_id);
create index idx_allotments_operator on public.allotments (tour_operator_id);

create table public.rotation_templates (
  id uuid primary key default gen_random_uuid(),
  origin text not null,
  destination text not null,
  resource_id uuid references public.resources(id),
  days_of_week int[] not null,
  capacity int not null,
  start_date date not null,
  end_date date not null,
  leg_type text not null default 'revenue' check (leg_type in ('revenue','ferry')),
  created_at timestamptz not null default now()
);
