-- ==========================================================
-- 창원정밀 작업일보 — setup database Supabase
-- Jalankan sekali di: Supabase Dashboard → SQL Editor → New query → Run
-- ==========================================================

create table if not exists public.worklog (
  id          text primary key,              -- dibuat di aplikasi (aman untuk antrean offline)
  date        date        not null,           -- 날짜
  shift       text        not null check (shift in ('주간', '야간')),
  worker      text        not null,           -- 작업자
  machine     text        not null,           -- 설비명
  item        text        not null,           -- 품명
  client      text        not null default '',-- 발주처
  process     text        not null default '',-- 생산 현황
  good        integer     not null default 0 check (good >= 0),  -- 양품
  bad         integer     not null default 0 check (bad  >= 0),  -- 불량
  start_time  time,                           -- 시작
  end_time    time,                           -- 종료
  remark      text        not null default '',-- 정지 내역 및 비고
  copied_at   timestamptz,                    -- kapan baris ini terakhir di-Copy
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists worklog_date_idx on public.worklog (date, created_at);

-- updated_at otomatis
create or replace function public.worklog_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists worklog_touch on public.worklog;
create trigger worklog_touch
  before update on public.worklog
  for each row execute function public.worklog_touch();

-- Akses: TANPA PIN — siapa pun yang punya URL + anon key aplikasi
-- bisa membaca, menambah, menandai copy, dan menghapus data.
alter table public.worklog enable row level security;

drop policy if exists "worklog public access" on public.worklog;
create policy "worklog public access"
  on public.worklog
  for all
  to anon, authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on public.worklog to anon, authenticated;
