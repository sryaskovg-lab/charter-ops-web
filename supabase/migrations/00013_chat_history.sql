create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index chat_messages_user_id_idx on public.chat_messages(user_id, created_at);

alter table public.chat_messages enable row level security;
create policy "chat_messages_own_rows" on public.chat_messages for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
