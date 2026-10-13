-- Fixes from the 2026-10-13 review of the permit module (see project-state doc).

-- 1) permit_emails: a message that cannot be imported is recorded as 'error' so it is not retried
--    forever (and cannot starve the queue behind it).
alter table public.permit_emails drop constraint if exists permit_emails_status_check;
alter table public.permit_emails add constraint permit_emails_status_check
  check (status in ('unassigned','filed','ignored','error'));

-- 2) Deleting a permit sends the e-mails filed on it back to the inbox (they used to vanish:
--    status stayed 'filed' while permit_id became null).
create or replace function public.permits_release_emails() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.permit_emails set status = 'unassigned', match_reason = 'its permit was deleted - file it again'
   where permit_id = old.id and status = 'filed';
  return old;
end $$;
revoke all on function public.permits_release_emails() from public, anon, authenticated;
drop trigger if exists permits_release_emails_del on public.overfly_permits;
create trigger permits_release_emails_del before delete on public.overfly_permits
  for each row execute function public.permits_release_emails();

-- 3) People may only file / ignore an e-mail: the stored message itself cannot be edited.
create or replace function public.permit_emails_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then   -- signed-in user; the server (service role) has no auth.uid()
    if new.gmail_message_id is distinct from old.gmail_message_id or new.thread_id is distinct from old.thread_id
       or new.from_addr is distinct from old.from_addr or new.subject is distinct from old.subject
       or new.received_at is distinct from old.received_at or new.body_text is distinct from old.body_text
       or new.attachments is distinct from old.attachments then
      raise exception 'Stored e-mails cannot be edited; only filing or ignoring is allowed';
    end if;
    if new.status not in ('unassigned','filed','ignored') then
      raise exception 'Invalid status for a manual change';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists permit_emails_guard_upd on public.permit_emails;
create trigger permit_emails_guard_upd before update on public.permit_emails
  for each row execute function public.permit_emails_guard();

-- 4) Notes: the author name is taken from the signed-in user's profile, not from the client.
create or replace function public.permit_notes_author() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    new.created_by_name := (select coalesce(p.name, p.email) from public.profiles p where p.id = auth.uid());
  end if;
  return new;
end $$;
revoke all on function public.permit_notes_author() from public, anon, authenticated;
drop trigger if exists permit_notes_author_ins on public.permit_notes;
create trigger permit_notes_author_ins before insert on public.permit_notes
  for each row execute function public.permit_notes_author();

-- 5) Security advisor: fix the mutable search_path on the updated_at helper.
create or replace function public._permits_touch() returns trigger
language plpgsql set search_path = public as $$ begin new.updated_at := now(); return new; end $$;

-- 6) Performance advisor: evaluate auth.uid() once per query, not once per row.
drop policy if exists chat_messages_own_rows on public.chat_messages;
create policy chat_messages_own_rows on public.chat_messages for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
