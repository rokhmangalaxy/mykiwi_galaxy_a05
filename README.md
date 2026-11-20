# ShopVault (`com.mykiwi.vault`) + Kiwi Browser Dev Worker

Sistem penangkap & penyimpan data produk lokal otomatis untuk **Samsung Galaxy A05** (dan Android umumnya). Cukup klik **Share ➔ Simpan Produk** saat sedang membuka aplikasi **Shopee** (atau aplikasi lain) — layar tetap berada di Shopee tanpa berpindah aplikasi, sementara **Kiwi Browser Dev** di latar belakang menyadap *response body* API produk asli dan menyimpannya ke database lokal **ShopVault**.

---

## Fitur Utama (MVP Tahap 1)

1. **Tangkap Share Tanpa Pindah Layar (`< 30 ms`):**
   * Tombol **"Simpan Produk"** di Android Share Sheet memakai `Translucent Activity` tanpa animasi (`excludeFromRecents=true`, `noHistory=true`).
   * Link affiliate pendek (`s.shopee.co.id/...` / `shp.ee/...`) langsung diamankan ke SQLite detik itu juga sehingga komisi Keranjang Oren tidak hilang meskipun sinyal sempat putus.
2. **Anti-Mental Balik ke App Shopee:**
   * Resolver di latar belakang mengurai redirect link pendek cukup sampai mendapatkan `shop_id` & `item_id`, lalu mengarahkan worker ke URL web murni `https://shopee.co.id/product/{shop_id}/{item_id}` serta memblokir skema `shopeeid://` & `intent://`.
3. **Penyadapan *Response Body* Hybrid (Hemat RAM Galaxy A05):**
   * Ekstensi **ShopVault Kiwi Worker** menyadap langsung `/api/v4/pdp/get_pc`, `/api/v4/pdp/get_rw`, `/api/v4/item/get`, dan `/api/v4/item/get_ratings` lewat **CDP `Network.getResponseBody`** + **Hook `XMLHttpRequest`/`fetch`**.
   * Hanya memakai **1 tab *anchor* ringan (`idle.html` ~2 MB RAM)** yang digunakan bergantian dengan jeda acak aman (`9–13 detik`) antar-produk beruntun agar terhindar dari HTTP 429 / error `90309999`.
4. **Penyimpanan Lokal Ganda (*Dual Storage*) & Siap Kirim ke Aplikasi Lain:**
   * **SQLite (`shopvault.db`):** Menyimpan judul, harga asli & promo, harga voucher, diskon, stok, jumlah terjual, nama & lokasi toko, varian SKU, ulasan pembeli teratas, **URL langsung Video Produk `.mp4`**, daftar **URL Foto HD**, serta **Link Affiliate asli**.
   * **File Mentah `.json`:** Seluruh *response body* utuh disimpan di `/Android/data/com.mykiwi.vault/files/raw_products/` dan bisa dikirim ke aplikasi lain lewat tombol **Kirim JSON / Ekspor Data (`.json` & `.csv`)** atau diakses lewat REST API lokal.

---

## Struktur Repository

* `android-bridge/` — Aplikasi Android Native Kotlin **ShopVault** (`applicationId = "com.mykiwi.vault"`, label Share: **"Simpan Produk"**).
* `kiwi-extension/` — Ekstensi Chrome Manifest V2 untuk **Kiwi Browser Dev** (`com.kiwibrowser.browser.dev`).
* `.github/workflows/build.yml` — GitHub Actions otomatis yang meng-compile `ShopVault-com.mykiwi.vault-debug.apk` dan `shopvault-kiwi-extension.zip`.
* `tests/test_pipeline.mjs` — Pengujian otomatis ekstraktor link affiliate, parser JSON Shopee, dan validasi manifest/XML.

---

## Cara Instalasi & Setup di Samsung Galaxy A05

### 1. Ambil File Siap Pasang dari GitHub Actions
Setiap kode di-*push* ke GitHub, buka tab **Actions ➔ Build ShopVault APK & Kiwi Extension**, lalu unduh artifact **`shopvault-galaxy-a05-bundle`** yang berisi:
* `ShopVault-com.mykiwi.vault-debug.apk`
* `shopvault-kiwi-extension.zip`

### 2. Pasang Kiwi Browser Dev & Ekstensi Worker
1. Pastikan **Kiwi Browser Dev** (`com.kiwibrowser.browser.dev` arsitektur `arm64`) dari rilis resmi `kiwibrowser/src.next` sudah terpasang.
2. Buka **Kiwi Browser Dev**, masuk ke menu **⋮ ➔ Extensions**, aktifkan **Developer mode**, klik **+ (from .zip/.crx/.user.js)**, lalu pilih file `shopvault-kiwi-extension.zip`.
3. Login ke akun `https://shopee.co.id` di Kiwi Browser Dev **sekali saja**, dan biarkan 1 tab `ShopVault Worker` tetap ada di Kiwi Dev.

### 3. Pasang Aplikasi **ShopVault** & Atur Baterai One UI
1. Install `ShopVault-com.mykiwi.vault-debug.apk` lalu buka **ShopVault** (pastikan indikator di kanan atas berubah menjadi **`Kiwi: Terhubung`**).
2. Supaya One UI Galaxy A05 tidak membekukan proses saat di latar belakang, buka **Pengaturan HP ➔ Aplikasi**:
   * Pilih **ShopVault** ➔ **Baterai** ➔ pilih **Tidak dibatasi (*Unrestricted*)**.
   * Pilih **Kiwi Browser (Dev)** ➔ **Baterai** ➔ pilih **Tidak dibatasi (*Unrestricted*)**.
3. **Tips Cepat:** Saat pertama kali klik tombol **Share** di Shopee, tekan tahan ikon **Simpan Produk** lalu pilih **Sematkan (*Pin*)** agar selalu muncul di baris paling atas!

---

## Local REST API (Untuk Integrasi Aplikasi Lain / Konten Shopee Video)

Saat `ShopVault` berjalan, server lokal aktif di `http://127.0.0.1:8765`:

| Endpoint | Metode | Fungsi |
| :--- | :--- | :--- |
| `/api/health` | `GET` | Cek status koneksi Kiwi Dev & ringkasan jumlah antrean/produk |
| `/api/products?q=...` | `GET` | Ambil daftar produk tersimpan (beserta link video `.mp4`, foto HD, varian, link affiliate) |
| `/api/products/{id}` | `GET` | Ambil detail lengkap 1 produk |
| `/api/products/{id}/raw` | `GET` | Ambil mentahan *response body* asli dari API Shopee |
| `/api/enqueue` | `POST` | Masukkan URL produk baru ke antrean dari aplikasi/skrip lain (`{"url": "..."}`) |
