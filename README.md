# 창원정밀 작업일보 — Setup sinkron (Supabase)

## 1. Buat tabel (sekali saja)
Supabase Dashboard → **SQL Editor** → New query → tempel isi `setup.sql` → **Run**.

## 2. Hubungkan aplikasi
Supabase Dashboard → **Project Settings → API**, salin:
- **Project URL** (`https://xxxx.supabase.co`)
- **anon public key** (`eyJ...`) atau **publishable key** (`sb_publishable_...`)

Pilih salah satu cara:
- **Cara A (disarankan):** isi di `config.js`, lalu upload. Semua HP/PC langsung tersambung.
- **Cara B:** biarkan `config.js` kosong, isi lewat tombol **⚙** di aplikasi pada tiap perangkat.

> Jangan pernah memakai `service_role` / secret key.

## 3. Upload
Upload seluruh folder ke hosting HTTPS (mis. GitHub Pages). Setelah file diubah,
naikkan versi `CACHE` di `sw.js` agar perangkat mengambil versi baru.

## Cara pakai
- Pilih **날짜** dan **주간/야간** di atas → satu lembar 작업일보.
- Isi tabel seperti form kertas. Baris **＋** paling bawah = baris baru; begitu diisi, baris berikutnya muncul otomatis
  (작업자, 설비명 dan 시작 diisi dari baris sebelumnya).
- 시간(분) = 종료 − 시작, 순작업시간(분) = 시간 − 비가동시간 (dihitung otomatis).
- Semua isian tersimpan otomatis dan bisa diedit kapan saja. Tombol 🗑 menghapus baris (ada konfirmasi).
- **Copy per kolom:** tombol 📋 di judul kolom (PC) atau chip "열 복사" (HP). Kolom yang sudah disalin berwarna hijau.

## Cara kerja sinkron
- Semua perangkat membaca/menulis tabel `public.worklog` yang sama.
- Perangkat lain menampilkan data baru dalam ±10 detik (dan saat aplikasi dibuka kembali).
- Saat Wi-Fi putus, input tetap tersimpan di perangkat (ikon ⏳) dan dikirim otomatis saat online.
- Status di pojok kanan atas: 🟢 동기화됨 · 🟡 전송 중 · 🔴 오프라인/키 오류. Klik untuk sinkron manual.
- Data lama yang hanya ada di satu perangkat akan ditawarkan untuk diunggah saat pertama tersambung.

## Catatan keamanan
Tanpa PIN: siapa pun yang punya link aplikasi (yang berisi anon key) bisa melihat, menambah,
dan menghapus data. Jangan bagikan link ke luar pabrik.
