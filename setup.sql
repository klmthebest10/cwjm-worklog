-- ==========================================================
-- 창원정밀 작업일보 — setup database Supabase (v3)
-- Jalankan di: Supabase Dashboard → SQL Editor → New query → Run
-- Aman dijalankan ulang (juga meng-upgrade tabel versi lama).
-- ==========================================================

-- 1) Baris pekerjaan (satu baris = satu baris di form 작업일보)
create table if not exists public.worklog (
  id          text primary key,              -- dibuat di aplikasi (aman untuk antrean offline)
  date        date        not null,           -- 날짜
  shift       text        not null check (shift in ('주간', '야간')),
  worker      text        not null default '',-- 작업자
  machine     text        not null default '',-- 설비명
  item        text        not null default '',-- 품명
  client      text        not null default '',-- 발주처
  process     text        not null default '',-- 진행현황
  good        integer     check (good >= 0),  -- 양품
  bad         integer     check (bad  >= 0),  -- 불량
  start_time  time,                           -- 시작
  end_time    time,                           -- 종료
  downtime    integer     check (downtime >= 0), -- 비가동시간(분)
  remark      text        not null default '',-- 정지내역 및 비고
  copied_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Upgrade dari versi sebelumnya
alter table public.worklog add column if not exists downtime integer check (downtime >= 0);
alter table public.worklog alter column worker  set default '';
alter table public.worklog alter column machine set default '';
alter table public.worklog alter column item    set default '';
alter table public.worklog alter column good drop not null;
alter table public.worklog alter column good drop default;
alter table public.worklog alter column bad  drop not null;
alter table public.worklog alter column bad  drop default;

create index if not exists worklog_sheet_idx on public.worklog (date, shift, created_at);

-- 2) 특이사항 per lembar (tanggal + 근무)
create table if not exists public.worklog_note (
  date        date not null,
  shift       text not null check (shift in ('주간', '야간')),
  note        text not null default '',
  updated_at  timestamptz not null default now(),
  primary key (date, shift)
);

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

drop trigger if exists worklog_note_touch on public.worklog_note;
create trigger worklog_note_touch
  before update on public.worklog_note
  for each row execute function public.worklog_touch();

-- 3) Akses: TANPA PIN — siapa pun yang punya URL + anon key aplikasi
--    bisa membaca, menambah, mengubah, dan menghapus data.
alter table public.worklog      enable row level security;
alter table public.worklog_note enable row level security;

drop policy if exists "worklog public access" on public.worklog;
create policy "worklog public access" on public.worklog
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "worklog_note public access" on public.worklog_note;
create policy "worklog_note public access" on public.worklog_note
  for all to anon, authenticated using (true) with check (true);

grant select, insert, update, delete on public.worklog      to anon, authenticated;
grant select, insert, update, delete on public.worklog_note to anon, authenticated;

-- Segarkan cache skema PostgREST agar kolom baru langsung terbaca
notify pgrst, 'reload schema';
