-- Nation's Pure CRM — run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste all -> Run

create extension if not exists pgcrypto;

-- ===== Tables =====

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  phone text not null default '',
  email text not null default '',
  address text not null default '',
  county text not null default '',
  csr text not null default '',
  need text not null default '',
  stage text not null default 'new',
  requested_window text not null default '',
  off_hours boolean not null default false,
  rep_confirmed boolean not null default false,
  assigned_rep text not null default '',
  reviewed boolean not null default false,
  sale_price numeric,
  system_name text not null default '',
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

-- ===== Table grants: RLS policies above only take effect once the authenticated
-- role also has base table privileges. Without this, everything fails with
-- "permission denied for table ..." even though the policies look right. =====

grant usage on schema public to authenticated;
grant select, insert, update, delete on leads to authenticated;
grant select, insert, delete on brochures to authenticated;
grant select, insert on work_orders to authenticated;
grant select, insert, update, delete on blocks to authenticated;

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

-- ============ Google Calendar sync (private calendar feed links) ============
-- Run once in Supabase → SQL Editor.
create table if not exists calendar_feeds (
  token text primary key,
  rep text not null,               -- specialist name, or '*' for the whole team
  created_by uuid references auth.users(id) on delete set null,
  created_at bigint not null
);
alter table calendar_feeds enable row level security;
grant select, insert, delete on calendar_feeds to authenticated;
drop policy if exists "feeds_select" on calendar_feeds;
drop policy if exists "feeds_insert" on calendar_feeds;
drop policy if exists "feeds_delete" on calendar_feeds;
create policy "feeds_select" on calendar_feeds for select using (auth.role() = 'authenticated');
create policy "feeds_insert" on calendar_feeds for insert with check (auth.role() = 'authenticated');
create policy "feeds_delete" on calendar_feeds for delete using (auth.role() = 'authenticated');

create or replace function public.calendar_feed(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare f calendar_feeds;
begin
  if p_token is null or length(p_token) < 32 then return null; end if;
  select * into f from calendar_feeds where token = p_token;
  if not found then return null; end if;
  return jsonb_build_object('rep', f.rep, 'appts', coalesce((
    select jsonb_agg(to_jsonb(l) - 'note_log' - 'created_by')
    from leads l
    where l.appt_date <> '' and l.appt_start <> '' and l.assigned_rep <> ''
      and l.stage <> 'lost'
      and l.appt_date >= to_char(now() - interval '60 days', 'YYYY-MM-DD')
      and (f.rep = '*' or lower(trim(l.assigned_rep)) = lower(trim(f.rep)))
  ), '[]'::jsonb));
end $$;
revoke all on function public.calendar_feed(text) from public;
grant execute on function public.calendar_feed(text) to anon, authenticated;

-- ============ Morning briefing (run once in Supabase → SQL Editor) ============
-- Morning briefing: lets the 7am briefing read a summary of the CRM with a secret link.
create table if not exists brief_tokens (
  token text primary key,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);
alter table brief_tokens enable row level security;
insert into brief_tokens (token) values ('<secret token is only in your Supabase project>') on conflict do nothing;

create or replace function public.morning_brief(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare since_ms bigint := (extract(epoch from now() - interval '75 days') * 1000)::bigint;
begin
  if p_token is null or length(p_token) < 32 then return null; end if;
  if not exists (select 1 from brief_tokens where token = p_token) then return null; end if;
  return jsonb_build_object(
    'leads', coalesce((
      select jsonb_agg(jsonb_build_object('name', l.name, 'address', l.address, 'stage', l.stage,
        'channel', to_jsonb(l)->>'channel', 'assigned_rep', l.assigned_rep, 'appt_date', l.appt_date,
        'appt_start', l.appt_start, 'sale_price', l.sale_price, 'off_hours', l.off_hours,
        'rep_confirmed', l.rep_confirmed, 'created_at', l.created_at, 'updated_at', l.updated_at))
      from leads l
      where l.created_at >= since_ms or l.updated_at >= since_ms
         or l.appt_date >= to_char(now() - interval '75 days', 'YYYY-MM-DD')
         or l.stage in ('new', 'scheduled')
    ), '[]'::jsonb),
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object('rep', b.rep, 'date', b.date, 'slot', b.slot, 'status', b.status))
      from blocks b
      where b.date between to_char(now() - interval '1 day', 'YYYY-MM-DD') and to_char(now() + interval '1 day', 'YYYY-MM-DD')
    ), '[]'::jsonb));
end $$;
revoke all on function public.morning_brief(text) from public;
grant execute on function public.morning_brief(text) to anon, authenticated;

-- Water test + customer water report (run once in Supabase → SQL Editor)
alter table leads add column if not exists water_test jsonb;
alter table leads add column if not exists report_token text;
create unique index if not exists leads_report_token_idx on leads (report_token) where report_token is not null;

create or replace function public.water_report(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l leads; parts text[]; n int; city text := '';
begin
  if p_token is null or length(p_token) < 24 then return null; end if;
  select * into l from leads where report_token = p_token;
  if not found or l.water_test is null then return null; end if;
  parts := string_to_array(l.address, ',');
  n := coalesce(array_length(parts, 1), 0);
  if n >= 3 then city := trim(parts[n-1]); elsif n = 2 then city := trim(parts[2]); end if;
  city := trim(regexp_replace(city, '\s*(TX|Texas)?\s*\d{5}(-\d{4})?\s*$', '', 'i'));
  if city ~* '^(tx|texas)$' then city := ''; end if;
  return jsonb_build_object('first', split_part(trim(l.name), ' ', 1), 'city', city,
    'rep', l.assigned_rep, 'test', l.water_test);
end $$;
revoke all on function public.water_report(text) from public;
grant execute on function public.water_report(text) to anon, authenticated;

-- Appointment confirmed by customer (run once)
alter table leads add column if not exists appt_confirmed_at bigint;
alter table leads add column if not exists appt_confirmed_by text not null default '';
