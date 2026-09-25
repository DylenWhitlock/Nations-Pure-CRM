-- Nation's Pure CRM — run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste all -> Run

create extension if not exists pgcrypto;

-- ===== Tables =====

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  phone text not null default '',
  address text not null default '',
  need text not null default '',
  stage text not null default 'new',
  requested_window text not null default '',
  off_hours boolean not null default false,
  rep_confirmed boolean not null default false,
  assigned_rep text not null default '',
  reviewed boolean not null default false,
  appt_date text not null default '',
  appt_start text not null default '',
  note_log jsonb not null default '[]'::jsonb,
  notes text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text not null default '',
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists brochures (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  category text not null default '',
  storage_path text,
  content_type text,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_name text not null default '',
  uploaded_at bigint not null
);

create table if not exists work_orders (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  lead_id uuid references leads(id) on delete set null,
  storage_path text,
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text not null default '',
  created_at bigint not null
);

create table if not exists blocks (
  id text primary key,
  rep text not null,
  date text not null,
  slot text not null,
  status text not null,
  lead_id uuid references leads(id) on delete set null,
  customer_name text,
  created_by uuid references auth.users(id) on delete set null,
  created_at bigint not null
);

-- ===== Row Level Security: any signed-in teammate can read/write =====

alter table leads enable row level security;
alter table brochures enable row level security;
alter table work_orders enable row level security;
alter table blocks enable row level security;

create policy "leads_select" on leads for select using (auth.role() = 'authenticated');
create policy "leads_insert" on leads for insert with check (auth.role() = 'authenticated');
create policy "leads_update" on leads for update using (auth.role() = 'authenticated');
create policy "leads_delete" on leads for delete using (auth.role() = 'authenticated');

create policy "brochures_select" on brochures for select using (auth.role() = 'authenticated');
create policy "brochures_insert" on brochures for insert with check (auth.role() = 'authenticated');
create policy "brochures_delete" on brochures for delete using (auth.role() = 'authenticated');

create policy "work_orders_select" on work_orders for select using (auth.role() = 'authenticated');
create policy "work_orders_insert" on work_orders for insert with check (auth.role() = 'authenticated');

create policy "blocks_select" on blocks for select using (auth.role() = 'authenticated');
create policy "blocks_upsert" on blocks for insert with check (auth.role() = 'authenticated');
create policy "blocks_update" on blocks for update using (auth.role() = 'authenticated');
create policy "blocks_delete" on blocks for delete using (auth.role() = 'authenticated');

-- ===== Live updates (so the board/calendar refresh across everyone's screen) =====

alter publication supabase_realtime add table leads, brochures, work_orders, blocks;

-- ===== File storage buckets (private — only signed-in teammates can read/write) =====

insert into storage.buckets (id, name, public)
values ('brochures', 'brochures', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('work-orders', 'work-orders', false)
on conflict (id) do nothing;

create policy "brochures_storage_select" on storage.objects for select using (bucket_id = 'brochures' and auth.role() = 'authenticated');
create policy "brochures_storage_insert" on storage.objects for insert with check (bucket_id = 'brochures' and auth.role() = 'authenticated');
create policy "brochures_storage_delete" on storage.objects for delete using (bucket_id = 'brochures' and auth.role() = 'authenticated');

create policy "workorders_storage_select" on storage.objects for select using (bucket_id = 'work-orders' and auth.role() = 'authenticated');
create policy "workorders_storage_insert" on storage.objects for insert with check (bucket_id = 'work-orders' and auth.role() = 'authenticated');
