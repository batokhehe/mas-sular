# Mas Sular — Production (`deploy/prd`)

Stack production untuk **ecommerce.baksomassular.com**. Stack ini berjalan
berdampingan dengan staging di VPS yang sama (1 vCPU / 3.8 GiB) selama masa
transisi, sampai staging di-takedown.

```
                    :80 / :443
                        │
          ┌─────────────┴─────────────┐   project: edge-proxy
          │  mas-sular-nginx (proxy)  │   deploy/prd/proxy
          └──────┬──────────────┬─────┘
  mas-sular_edge │              │ mas-sular-prd_edge
     ┌───────────┴───┐      ┌───┴────────────────────┐
     │ STAGING       │      │ PRODUCTION             │
     │ project       │      │ project mas-sular-prd  │
     │ mas-sular     │      │ (folder ini)           │
     │ staging-*.…   │      │ ecommerce/api/admin.…  │
     └───────────────┘      └────────────────────────┘
```

| | Staging (tidak diubah) | Production |
|---|---|---|
| Folder | `apps/mas-sular` | `apps/mas-sular-prd` |
| Compose project | `mas-sular` | `mas-sular-prd` |
| Volume | `mas-sular_*` | `mas-sular-prd_*` |
| Network | `mas-sular_edge`, `mas-sular_internal` | `mas-sular-prd_edge`, `mas-sular-prd_internal` |
| Image | `mas-sular-*:latest` | `mas-sular-prd/*:<git-sha>` |
| Secret | `apps/mas-sular/production.env` | `/etc/mas-sular-prd/{compose,app,release}.env` |
| Upstream di nginx | `mas-sular-<svc>-1` (nama container) | `prd-<svc>` (alias network) |

Semua perintah compose production lewat **`deploy/prd/dc`**. Wrapper ini
mengunci project ke `mas-sular-prd`, jadi tidak bisa salah menyentuh staging.

---

## 0. Prasyarat

1. **DNS**: buat A record `ecommerce`, `api`, dan `admin` di `baksomassular.com`
   yang mengarah ke `187.53.139.88`. Per 2026-10-13 ketiganya belum ada.
   Cek dengan `getent hosts api.baksomassular.com`.
2. **Google OAuth client untuk production**, dengan authorized JavaScript
   origin `https://ecommerce.baksomassular.com`.
3. Kredensial production (Midtrans, Paxel, JNE, Qontak, Resend) **boleh menyusul**.
   Template default-nya mematikan semua fitur itu untuk boot pertama (lihat langkah 6).

## 1. Siapkan secret (sekali saja)

```bash
cd ~/apps/mas-sular-prd

# Direktori secret, hanya bisa dibaca oleh user massular
sudo install -d -o massular -g massular -m 700 /etc/mas-sular-prd
cp deploy/prd/env/compose.env.example /etc/mas-sular-prd/compose.env
cp deploy/prd/env/app.env.example     /etc/mas-sular-prd/app.env
chmod 600 /etc/mas-sular-prd/*.env

# Isi semua password infrastruktur dengan nilai acak BARU (hex = aman di URL)
for k in POSTGRES_PASSWORD APP_DB_OWNER_PASSWORD APP_DB_APP_PASSWORD REDIS_PASSWORD RABBITMQ_PASSWORD; do
  sed -i "s/^$k=CHANGE_ME$/$k=$(openssl rand -hex 32)/" /etc/mas-sular-prd/compose.env
done

# Isi secret aplikasi dengan nilai acak BARU (jangan pernah salin dari staging)
for k in JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_ADMIN_ACCESS_SECRET COOKIE_SECRET; do
  sed -i "s/^$k=CHANGE_ME$/$k=$(openssl rand -hex 32)/" /etc/mas-sular-prd/app.env
done
```

Lalu edit manual (`nano /etc/mas-sular-prd/compose.env` dan `app.env`):

- `compose.env`: `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, dan opsional `NEXT_PUBLIC_SUPPORT_URL` / `NEXT_PUBLIC_WHATSAPP_*`.
- `app.env`: `GOOGLE_CLIENT_ID` (nilainya sama dengan `NEXT_PUBLIC_GOOGLE_CLIENT_ID`),
  dan semua nilai lain yang masih `<PLACEHOLDER>`. `deploy.sh` dan aplikasi sama-sama
  menolak jalan selama masih ada placeholder. Itu disengaja.

Pastikan tidak ada yang tertinggal:

```bash
grep -nE 'CHANGE_ME|<[A-Z_]+>' /etc/mas-sular-prd/compose.env /etc/mas-sular-prd/app.env | grep -v ':\s*#'
```

**Kunci backup dan direktori backup:**

```bash
sudo install -d -o massular -g massular -m 700 /srv/backups/mas-sular-prd
( umask 077; head -c 48 /dev/urandom | base64 > /etc/mas-sular-prd/backup.key )
```

Simpan salinan `backup.key` **di luar VPS** (password manager). Backup yang
terenkripsi dengan kunci yang hilang tidak bisa dipulihkan.

`DATABASE_URL`, `REDIS_URL`, dan `RABBITMQ_URL` **tidak** ditulis di `app.env`.
Ketiganya dirakit oleh `docker-compose.yml` dari `compose.env`. Aplikasi
terkoneksi sebagai `mas_sular_app` (hanya DML). Migrasi memakai `mas_sular_owner`.
Superuser `mas_sular_admin` hanya untuk operator dan backup.

## 2. Deploy pertama (staging tetap jalan)

```bash
cd ~/apps/mas-sular-prd
deploy/prd/deploy.sh
```

Yang dilakukan script ini:

1. **Preflight**: permission 600, tidak ada `CHANGE_ME`, password aman untuk URL, tidak ada
   nilai `staging`/`sandbox`/`stage-` di `app.env`, dan **tidak ada secret yang sama
   dengan staging**. Kalau salah satu gagal, script berhenti.
2. Build image **satu per satu** (Next.js build bisa memakan sekitar 1–1.5 GiB). Script
   menolak build kalau `MemAvailable` di bawah 1200 MiB. Di 1 vCPU, proses ini
   bisa memakan 15–25 menit dan staging akan terasa lebih lambat selama build.
3. Menyalakan postgres, redis, dan rabbitmq. Pada boot pertama, `postgres/initdb/10-roles.sh`
   membuat role `mas_sular_owner` dan `mas_sular_app`.
4. Backup pre-migrate (dilewati di deploy pertama karena DB masih kosong).
5. `prisma migrate deploy`, lalu `up --wait` untuk backend, frontend, dan admin sampai healthy.
6. Mencatat `IMAGE_TAG` ke `/etc/mas-sular-prd/release.env` untuk keperluan rollback.

Verifikasi bahwa keduanya hidup:

```bash
deploy/prd/dc ps                                  # production
docker ps --filter label=com.docker.compose.project=mas-sular   # staging, harus tetap Up (healthy)
```

**Super Admin pertama** (sekali saja):

```bash
read -rp  'Admin email: '    BOOTSTRAP_ADMIN_EMAIL    && export BOOTSTRAP_ADMIN_EMAIL
read -rsp 'Admin password: ' BOOTSTRAP_ADMIN_PASSWORD && echo && export BOOTSTRAP_ADMIN_PASSWORD
deploy/prd/dc run --rm -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD \
  backend-migrate node node_modules/tsx/dist/cli.mjs prisma/bootstrap-production.ts
unset BOOTSTRAP_ADMIN_PASSWORD
```

**Data wilayah Kemendagri** (idempotent; dibutuhkan untuk form alamat):

```bash
deploy/prd/dc run --rm backend-migrate node node_modules/tsx/dist/cli.mjs prisma/seed-address.ts
```

## 3. Ganti proxy: nginx lama ke edge proxy global

Ini **satu-satunya langkah yang menyentuh traffic staging**. Downtime-nya sekitar 2–5 detik.
Proxy lama (`/opt/mas-sular/docker-compose.proxy.yml`) diganti dengan proxy
yang merutekan **kedua** environment. Nama container tetap `mas-sular-nginx` supaya
deploy-hook certbot (`/etc/letsencrypt/renewal-hooks/deploy/mas-sular-nginx-reload.sh`)
tetap bekerja.

Prasyarat: deploy production (langkah 2) sudah jalan, karena network
`mas-sular-prd_edge` harus sudah ada.

```bash
cd ~/apps/mas-sular-prd/deploy/prd/proxy
cp .env.example .env              # PRD_TLS=off (sertifikat production belum ada)
docker compose config --quiet

# Uji config di container sekali pakai (tanpa port, tanpa network)
docker run --rm --network none \
  -v "$PWD/conf.d:/etc/nginx/conf.d:ro" -v "$PWD/snippets:/etc/nginx/snippets:ro" \
  -v "$PWD/prd-tls-off:/etc/nginx/prd-tls:ro" -v /etc/letsencrypt:/etc/letsencrypt:ro \
  nginx:1.28-alpine nginx -t

# Cut-over
docker stop mas-sular-nginx && docker rm mas-sular-nginx
docker compose up -d

# Verifikasi staging tetap jalan
curl -sI https://staging-ecommerce.baksomassular.com | head -1
curl -sI https://staging-api.baksomassular.com/api/v1/health | head -1
curl -sI https://staging-admin.baksomassular.com | head -1
```

**Rollback ke proxy lama** (kalau staging bermasalah):

```bash
cd ~/apps/mas-sular-prd/deploy/prd/proxy && docker compose down
docker compose -f /opt/mas-sular/docker-compose.proxy.yml up -d nginx
```

> Jangan pernah menambahkan `--remove-orphans` pada perintah compose di `/opt/mas-sular`.
> Project name file itu juga `mas-sular`, sama dengan stack staging.

## 4. Sertifikat TLS production

Setelah DNS resolve ke VPS dan proxy baru berjalan:

```bash
sudo certbot certonly --webroot -w /opt/mas-sular/nginx/certbot/www \
  --cert-name ecommerce.baksomassular.com \
  -d ecommerce.baksomassular.com -d api.baksomassular.com -d admin.baksomassular.com

cd ~/apps/mas-sular-prd/deploy/prd/proxy
sed -i 's/^PRD_TLS=.*/PRD_TLS=on/' .env
docker compose up -d                 # recreate (mount berubah), blip ~2 detik
docker exec mas-sular-nginx nginx -t

curl -sI https://ecommerce.baksomassular.com | head -1
curl -s  https://api.baksomassular.com/api/v1/health
```

Perpanjangan sertifikat berjalan otomatis lewat timer certbot. Deploy-hook yang
sudah ada me-reload `mas-sular-nginx`.

## 5. Operasional harian

```bash
deploy/prd/dc ps
deploy/prd/dc logs -f --tail=200 backend
deploy/prd/dc exec postgres psql -U mas_sular_admin -d mas_sular

# Ubah app.env (tanpa rebuild):
deploy/prd/dc up -d --no-deps --force-recreate backend

# Ubah kode atau NEXT_PUBLIC_* (rebuild + backup + migrate):
git pull --ff-only && deploy/prd/deploy.sh

# Rollback image aplikasi ke rilis sebelumnya (migrasi DB TIDAK di-revert):
deploy/prd/deploy.sh --rollback
```

**Backup harian** (crontab user `massular`, `crontab -e`):

```cron
15 3 * * * cd /home/massular/apps/mas-sular-prd && POSTGRES_CONTAINER=$(docker ps -qf name=mas-sular-prd-postgres-1) UPLOADS_VOLUME=mas-sular-prd_uploads_data BACKUP_DIR=/srv/backups/mas-sular-prd BACKUP_KEY_FILE=/etc/mas-sular-prd/backup.key ./scripts/backup/backup.sh >> /srv/backups/mas-sular-prd/backup.log 2>&1
```

Salin hasil backup ke luar VPS secara berkala. Lakukan restore drill sekali sebelum go-live
(`scripts/backup/restore-drill.sh`).

**Image rollback dan cron prune.** `/etc/cron.d/docker-image-prune` menjalankan
`docker image prune -af --filter until=24h`, sehingga image rilis sebelumnya
terhapus setelah 24 jam dan `--rollback` gagal. Kecualikan image production:

```bash
sudo sed -i 's|--filter "until=24h"|--filter "until=24h" --filter "label!=id.baksomassular.stack=mas-sular-prd"|' /etc/cron.d/docker-image-prune
```

`deploy.sh` sendiri menyimpan 3 tag terakhir per image dan menghapus sisanya.

## 6. Go-live: aktifkan fitur bertahap

`app.env` dimulai dalam keadaan aman: kurir, Midtrans, dan notifikasi **OFF**,
retention dalam **dry-run**. Urutannya:

1. Login admin, lalu buat **outlet aktif** yang asli. Kurir menolak boot tanpa outlet.
2. Isi kredensial production, lalu set flag `*_ENABLED=true` sesuai komentar di `app.env`.
   Setelah itu jalankan `deploy/prd/dc up -d --no-deps --force-recreate backend`.
3. Daftarkan URL **production** di dashboard vendor:
   - Midtrans: `https://api.baksomassular.com/api/v1/payments/webhook/midtrans`
   - Paxel: `https://api.baksomassular.com/api/v1/shipments/webhook/paxel`
   - JNE: `https://api.baksomassular.com/api/v1/shipments/webhook/jne`
   - Template Qontak (tombol URL): `https://ecommerce.baksomassular.com/payment/{{1}}`
4. Cek `NotificationOutbox` PENDING sebelum menyalakan sender.
5. Setelah log `worker.retention` dibaca dan dipastikan aman: `RETENTION_DRY_RUN=false`.

Nilai bisnis (alamat pickup, kode origin JNE, template ID, dan sejenisnya) boleh
disalin dari staging. **Secret dan API key tidak boleh**. `deploy.sh` menolak
deploy kalau ada yang sama.

## Resource budget (VPS 1 vCPU / 3.8 GiB + 2 GiB swap)

| Service | Limit RAM | Heap V8 | CPU limit | cpu_shares | oom_score_adj |
|---|---|---|---|---|---|
| postgres | 640M | – | 0.60 | 2048 | -500 |
| redis | 96M (maxmemory 64mb) | – | 0.25 | 2048 | – |
| rabbitmq | 448M (watermark 256MB) | – | 0.30 | 2048 | -300 |
| backend | 512M | 320M | 0.75 | 2048 | -300 |
| frontend | 384M | 256M | 0.50 | 2048 | – |
| admin | 256M | 160M | 0.30 | 1024 | – |
| **Total ceiling** | **~2.3 GiB** | | | | |
| backend-migrate (one-shot) | 512M | 384M | 0.75 | – | – |

- Staging terukur sekitar 0.3 GiB saat idle. Ceiling production + staging + OS masih muat di RAM + swap.
- `cpu_shares` 2048 membuat production mendapat jatah CPU **2× staging** (default 1024)
  saat satu core sedang diperebutkan.
- `oom_score_adj` negatif membuat OOM killer host **memilih staging lebih dulu**.
- **RabbitMQ:** tanpa `rabbitmq/10-prd.conf`, broker menghitung watermark dari RAM host
  (sekitar 1.5 GiB), jauh di atas limit container, sehingga broker di-OOM-kill sebelum sempat
  menahan publisher. Hal ini sudah diverifikasi. Staging saat ini punya masalah yang sama.

## Cookie: risiko selama staging dan production hidup bersamaan

Staging (`staging-*.baksomassular.com`) dan production sama-sama memakai
`COOKIE_DOMAIN=.baksomassular.com` dengan nama cookie yang **sama**
(`ms_access`, `ms_refresh`, `XSRF-TOKEN`). Selama keduanya hidup:

- Browser yang membuka staging juga mengirim cookie customer production ke host staging.
- Staging bisa menimpa cookie production, sehingga user ter-logout atau mengalami CSRF mismatch.

Customer asli tidak membuka staging, jadi dampaknya ada pada tim internal dan tester.
**Aturan selama transisi:** tester membuka staging dengan **browser profile terpisah**
atau jendela incognito. Session admin bersifat host-only, jadi tidak terdampak.
Masalah ini hilang dengan sendirinya setelah staging di-takedown.

## Takedown staging (setelah UAT OK)

```bash
# 1. Backup terakhir staging (lihat apps/mas-sular/scripts/backup/RUNBOOK.md)

# 2. Lepaskan staging dari proxy
cd ~/apps/mas-sular-prd/deploy/prd/proxy
git rm conf.d/10-staging.conf
#    hapus network `staging_edge` dari docker-compose.yml (service dan blok networks)
docker compose up -d && docker exec mas-sular-nginx nginx -t

# 3. Matikan staging (volume tetap disimpan sampai backup terverifikasi)
cd ~/apps/mas-sular
docker compose --env-file production.env -f docker-compose.production.yml down

# 4. Opsional: cabut sertifikat staging
sudo certbot delete --cert-name staging-ecommerce.baksomassular.com
```

Webroot ACME `/opt/mas-sular/nginx/certbot/www` **tetap dipakai** oleh renewal
sertifikat production. Jangan hapus `/opt/mas-sular/nginx/certbot` kecuali
`/etc/letsencrypt/renewal/ecommerce.baksomassular.com.conf` sudah dipindah ke
webroot lain.
