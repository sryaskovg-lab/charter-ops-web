-- Actual flight times from movement (MVT) messages.
--   flights            + actual off-block / airborne / landing / on-block, estimated arrival, the registration that
--                        really operated, and when the last message arrived
--   movement_messages  every MVT received (by e-mail label "Movements", or pasted in the app), what flight it was
--                      matched to and what was done. The server (service role) writes; people can read.
alter table public.flights add column if not exists actual_off_block timestamptz;
alter table public.flights add column if not exists actual_airborne timestamptz;
alter table public.flights add column if not exists actual_landing timestamptz;
alter table public.flights add column if not exists actual_on_block timestamptz;
alter table public.flights add column if not exists estimated_arrival timestamptz;
alter table public.flights add column if not exists actual_registration text;
alter table public.flights add column if not exists movement_updated_at timestamptz;

create table if not exists public.movement_messages (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text,                        -- null when pasted in the app
  part text not null default 'body',
  from_addr text,
  subject text,
  received_at timestamptz,
  raw_text text,                                -- the message as received; rendered as text only
  flight_ref text,
  flight_id uuid references public.flights(id) on delete set null,
  status text not null check (status in ('applied','unmatched','ignored','error')),
  note text,                                    -- what was stored, or why it could not be matched
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists movement_messages_gmail_uq on public.movement_messages (gmail_message_id, part, flight_ref) where gmail_message_id is not null;
create index if not exists movement_messages_created_idx on public.movement_messages (created_at desc);
create index if not exists movement_messages_flight_idx on public.movement_messages (flight_id);

alter table public.movement_messages enable row level security;
drop policy if exists movement_messages_select on public.movement_messages;
create policy movement_messages_select on public.movement_messages for select to authenticated
  using (coalesce((select public.current_role_name()), 'pending') <> 'pending');

do $$ begin
  alter publication supabase_realtime add table public.movement_messages;
exception when duplicate_object then null; end $$;
