create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  due_label text not null default 'Today',
  done boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  subtitle text,
  kind text not null default 'info',
  created_at timestamptz not null default now()
);

alter table public.tasks enable row level security;
alter table public.notifications enable row level security;

create policy "tasks_all_authenticated" on public.tasks for all to authenticated using (true) with check (true);
create policy "notifications_select_all" on public.notifications for select to authenticated using (true);
create policy "notifications_insert_all" on public.notifications for insert to authenticated with check (true);

alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.notifications;
