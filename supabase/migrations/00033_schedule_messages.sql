-- SSIM / SSM / ASM schedule messages that arrive by e-mail (label "Schedule", see lib/scheduleMailSync.js).
-- The server (service role) stores each message; people with schedule rights review it in the app and
-- apply or dismiss it. Nothing in the schedule changes until a person presses Apply.
create table if not exists public.schedule_messages (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null,
  part text not null default 'body',                -- 'body' or 'att1', 'att2' ... (one row per readable part)
  from_addr text,
  subject text,
  received_at timestamptz,
  file_name text,
  kind text not null check (kind in ('ssim','ssm','asm','other')),
  raw_text text,                                    -- the message as received (max ~1.5 MB); rendered as text only
  summary text,                                     -- e.g. "NEW 2, CNL 1" or "138 flight legs"
  status text not null default 'pending' check (status in ('pending','applied','dismissed','error')),
  result_note text,                                 -- what was done when it was applied
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (gmail_message_id, part)
);
create index if not exists schedule_messages_status_idx on public.schedule_messages (status, received_at desc);

alter table public.schedule_messages enable row level security;
drop policy if exists schedule_messages_select on public.schedule_messages;
create policy schedule_messages_select on public.schedule_messages for select to authenticated
  using (coalesce((select public.current_role_name()), 'pending') <> 'pending');
drop policy if exists schedule_messages_update on public.schedule_messages;
create policy schedule_messages_update on public.schedule_messages for update to authenticated
  using (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'))
  with check (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'));

-- People may only record a decision; the stored message itself cannot be edited.
create or replace function public.schedule_messages_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    if new.gmail_message_id is distinct from old.gmail_message_id or new.part is distinct from old.part
       or new.from_addr is distinct from old.from_addr or new.subject is distinct from old.subject
       or new.received_at is distinct from old.received_at or new.file_name is distinct from old.file_name
       or new.kind is distinct from old.kind or new.raw_text is distinct from old.raw_text or new.summary is distinct from old.summary then
      raise exception 'Stored messages cannot be edited; only applying or dismissing is allowed';
    end if;
    if new.status not in ('pending','applied','dismissed') then
      raise exception 'Invalid status for a manual change';
    end if;
    new.decided_by := auth.uid();
    new.decided_at := now();
  end if;
  return new;
end $$;
drop trigger if exists schedule_messages_guard_upd on public.schedule_messages;
create trigger schedule_messages_guard_upd before update on public.schedule_messages
  for each row execute function public.schedule_messages_guard();

do $$ begin
  alter publication supabase_realtime add table public.schedule_messages;
exception when duplicate_object then null; end $$;
