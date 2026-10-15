-- Permit requests by country: each State is requested either directly from its authority or
-- through a handling agent, and each route has a predefined e-mail form (template).
--   permit_agents     handling agents (name, e-mail address(es), note)
--   permit_templates  editable request forms; one per State, per agent, or the general default
--   overfly_states    + channel ('authority' | 'agent') and agent_id for that State
--   overfly_permits   + agent_id: who the request went through (kept even if the State's setting changes later)

create table if not exists public.permit_agents (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  contact text,                         -- e-mail address(es), comma separated
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.permit_templates (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('default','state','agent')),
  state text,                           -- scope 'state'
  agent_id uuid references public.permit_agents(id) on delete cascade, -- scope 'agent'
  kind text not null default 'overfly' check (kind in ('overfly','landing')),
  subject text not null,
  body text not null,
  updated_at timestamptz not null default now(),
  constraint permit_templates_scope_ck check (
    (scope = 'default' and state is null and agent_id is null) or
    (scope = 'state' and state is not null and agent_id is null) or
    (scope = 'agent' and agent_id is not null and state is null))
);
create unique index if not exists permit_templates_default_uq on public.permit_templates (kind) where scope = 'default';
create unique index if not exists permit_templates_state_uq on public.permit_templates (state, kind) where scope = 'state';
create unique index if not exists permit_templates_agent_uq on public.permit_templates (agent_id, kind) where scope = 'agent';

alter table public.overfly_states add column if not exists channel text not null default 'authority';
alter table public.overfly_states drop constraint if exists overfly_states_channel_check;
alter table public.overfly_states add constraint overfly_states_channel_check check (channel in ('authority','agent'));
alter table public.overfly_states add column if not exists agent_id uuid references public.permit_agents(id) on delete set null;
alter table public.overfly_permits add column if not exists agent_id uuid references public.permit_agents(id) on delete set null;
create index if not exists overfly_states_agent_idx on public.overfly_states (agent_id);
create index if not exists overfly_permits_agent_idx on public.overfly_permits (agent_id);
create index if not exists permit_templates_agent_idx on public.permit_templates (agent_id);

alter table public.permit_agents enable row level security;
alter table public.permit_templates enable row level security;
do $$
declare t text;
begin
  foreach t in array array['permit_agents','permit_templates'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (coalesce((select public.current_role_name()), 'pending') <> 'pending')$p$, t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($p$create policy %I on public.%I for all to authenticated
      using (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'))
      with check (coalesce((select public.current_role_name()), 'pending') in ('ops_coordinator','management'))$p$, t || '_write', t);
  end loop;
end $$;

drop trigger if exists permit_agents_touch on public.permit_agents;
create trigger permit_agents_touch before update on public.permit_agents for each row execute function public._permits_touch();
drop trigger if exists permit_templates_touch on public.permit_templates;
create trigger permit_templates_touch before update on public.permit_templates for each row execute function public._permits_touch();
