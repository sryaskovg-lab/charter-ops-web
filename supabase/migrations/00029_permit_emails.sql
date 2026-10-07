-- Inbox for permit e-mails pulled from Gmail (see app/api/permits/sync). The server (service role)
-- writes rows; people with ops/management rights can file an unmatched e-mail onto a permit or
-- ignore it. Matching is by permit number / authority reference found in the e-mail; status
-- changes on permits stay manual.
create table if not exists public.permit_emails (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null unique,
  thread_id text,
  from_addr text,
  subject text,
  received_at timestamptz,
  body_text text,                                   -- plain text, truncated; always rendered as text, never as HTML
  attachments jsonb not null default '[]'::jsonb,   -- [{ name, path, size }] stored in the permit-docs bucket under mail/
  permit_id uuid references public.overfly_permits(id) on delete set null,
  match_reason text,                                -- e.g. 'reference NNN found', 'ambiguous', 'no reference found'
  status text not null default 'unassigned' check (status in ('unassigned','filed','ignored')),
  created_at timestamptz not null default now()
);
create index if not exists permit_emails_status_idx on public.permit_emails (status, received_at desc);
create index if not exists permit_emails_permit_idx on public.permit_emails (permit_id);

alter table public.permit_emails enable row level security;
drop policy if exists permit_emails_select on public.permit_emails;
create policy permit_emails_select on public.permit_emails for select to authenticated
  using (coalesce((select public.current_role_name()), 'pending') <> 'pending');
-- people may only file / ignore (update); rows are created and removed by the server alone
drop policy if exists permit_emails_update on public.permit_emails;
create policy permit_emails_update on public.permit_emails for update to authenticated
  using (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'))
  with check (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'));

do $$ begin
  alter publication supabase_realtime add table public.permit_emails;
exception when duplicate_object then null; end $$;
