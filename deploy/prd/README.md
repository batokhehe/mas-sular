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

Pastikan tidak ada yang tertinggal. Perintah ini hanya menampilkan file, nomor baris,
dan **nama key**, tidak pernah nilainya:

```bash
grep -nE 'CHANGE_ME|<[A-Z_]+>' /etc/mas-sular-prd/compose.env /etc/mas-sular-prd/app.env \
  | grep -vE '^[^:]*:[0-9]+:[[:space:]]*#' \
  | sed -E 's/^([^:]*:[0-9]+:)([A-Za-z_][A-Za-z0-9_]*)=.*/\1 \2/; t; s/^([^:]*:[0-9]+:).*/\1 (bukan baris KEY=VALUE)/'
```

**Path env staging (opsional).** Secara default, preflight membandingkan secret
production dengan env staging di `/home/massular/apps/mas-sular/production.env`
(stack staging di `~/apps/mas-sular`). Hanya kalau file itu ada di tempat lain,
tulis path-nya ke file konfigurasi production yang dipercaya:

```bash
( umask 077; printf '%s\n' /path/absolut/ke/production.env > /etc/mas-sular-prd/staging-env.path )
```

Aturan `staging-env.path` (dicek setiap deploy dan rollback, gagal = ABORT sebelum
git/docker/compose):

- File biasa, **bukan symlink**, milik user deploy (`massular`), `chmod 600`.
- Tepat satu baris path absolut berisi `[A-Za-z0-9._/-]` tanpa komponen `.`/`..`.
- Path itu (setelah symlink di-resolve) berada di luar `/etc/mas-sular-prd` dan
  bukan file apa pun di dalamnya, termasuk lewat hard link.
- Variabel environment `STAGING_ENV_FILE` **tidak didukung**: kalau di-set,
  `deploy.sh` berhenti (unset dulu).

File env staging itu sendiri (di path default atau dari `staging-env.path`) harus
milik `massular` atau root dan tidak boleh writable oleh group/others. Enam key
staging wajib saja tidak cukup untuk dipercaya.

**Root konfigurasi production dipercaya.** Root-nya **tetap**
`/etc/mas-sular-prd`, ditentukan di `deploy/prd/lib/prd-root.sh`; mengubahnya berarti
perubahan kode yang direview. `deploy.sh` dan `deploy/prd/dc` **menolak**
`PRD_CONF_DIR` yang menunjuk direktori lain (unset dulu). Setiap deploy/rollback
memastikan root itu direktori asli (bukan symlink), milik user yang menjalankan
`deploy.sh` (jalankan sebagai `massular`, bukan `sudo`), `chmod 700`, dan parent-nya
(`/etc`) milik root serta tidak writable oleh group/others. Kalau ada yang tidak
terpenuhi, script ABORT sebelum git/docker/compose.

**Format nilai env yang didukung** (untuk key yang diperiksa guard: secret JWT,
cookie, Paxel, Midtrans, Qontak, Resend, password Postgres/RabbitMQ, dan flag
Midtrans/JNE): `KEY=nilai` (format template; komentar ` # ...` setelah spasi boleh),
`KEY="nilai"`, atau `KEY='nilai'`. Ketiganya dianggap **secret yang sama**, persis
seperti dibaca Docker Compose. Yang **ditolak** (ABORT, nilai tidak dicetak):

- kutip tidak tertutup, atau teks setelah kutip penutup;
- `$`, backslash, atau backtick (interpolasi/escape Compose berbeda dari script);
- spasi di awal nilai, atau `#` yang tidak didahului spasi.

Nilai kosong atau hanya spasi dianggap tidak di-set. Key lain yang tidak diperiksa
guard tidak ditafsirkan sama sekali. File production tidak boleh punya key ganda; di
file staging, setiap nilai key ganda dibandingkan.

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
   Pemeriksaan secret-reuse pada deploy **maju** bersifat ketat (fail closed):
   - `app.env`, `compose.env`, dan env staging **wajib** ada, berupa file biasa, bisa
     dibaca, tidak kosong, dan setiap baris non-komentar berbentuk `KEY=VALUE`.
   - `app.env` dan `compose.env` tidak boleh meng-assign key yang sama dua kali.
   - Env staging diambil **hanya** dari path default
     `/home/massular/apps/mas-sular/production.env` atau dari
     `/etc/mas-sular-prd/staging-env.path` (lihat bagian 1). `STAGING_ENV_FILE` di
     environment ditolak.
   - Env staging harus benar-benar file staging: wajib meng-assign (tidak kosong)
     `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ADMIN_ACCESS_SECRET`,
     `COOKIE_SECRET`, `POSTGRES_PASSWORD`, dan `RABBITMQ_PASSWORD` (seperti template
     `production.env.example`), milik `massular`/root dan tidak writable oleh
     group/others, dan tidak boleh sama dengan file production. Kalau staging
     meng-assign satu key lebih dari sekali, **setiap** nilainya dibandingkan.
   - Nilai dibandingkan dalam bentuk kanonik (`KEY=v`, `KEY="v"`, `KEY='v'` sama);
     sintaks ambigu ditolak (lihat "Format nilai env" di bagian 1).
   - Root konfigurasi `/etc/mas-sular-prd` harus lolos kebijakan root dipercaya
     (bagian 1); `PRD_CONF_DIR` ke direktori lain ditolak.

   Tidak ada flag atau variabel untuk melewati pemeriksaan ini. Pengecualian yang
   berlaku: `MIDTRANS_SERVER_KEY` boleh sama dengan staging **hanya** selama
   `MIDTRANS_ENABLED=false` (persis huruf kecil), serta `QONTAK_API_TOKEN` /
   `RESEND_API_KEY` (otorisasi owner 2026-11-10).

   **Output tidak pernah memuat nilai.** Semua pesan `deploy.sh` (placeholder, nilai
   `staging`/`sandbox`/`stage-`, baris rusak, key ganda, secret yang sama) hanya
   menyebut file, nomor baris, nama key, dan alasannya. `deploy.sh` mematikan shell
   tracing (`set +x`) sebelum membaca file apa pun, jadi `bash -x` atau
   `SHELLOPTS=xtrace` juga tidak menampilkan nilai. Output dari program lain
   (`docker compose`, `scripts/backup/backup.sh`) di luar kendali pemeriksaan ini.
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
docker -H unix:///var/run/docker.sock ps --filter label=com.docker.compose.project=mas-sular   # staging, harus tetap Up (healthy)
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
docker -H unix:///var/run/docker.sock compose config --quiet

# Uji config di container sekali pakai (tanpa port, tanpa network)
docker -H unix:///var/run/docker.sock run --rm --network none \
  -v "$PWD/conf.d:/etc/nginx/conf.d:ro" -v "$PWD/snippets:/etc/nginx/snippets:ro" \
  -v "$PWD/prd-tls-off:/etc/nginx/prd-tls:ro" -v /etc/letsencrypt:/etc/letsencrypt:ro \
  nginx:1.28-alpine nginx -t

# Cut-over
docker -H unix:///var/run/docker.sock stop mas-sular-nginx && docker -H unix:///var/run/docker.sock rm mas-sular-nginx
docker -H unix:///var/run/docker.sock compose up -d

# Verifikasi staging tetap jalan
curl -sI https://staging-ecommerce.baksomassular.com | head -1
curl -sI https://staging-api.baksomassular.com/api/v1/health | head -1
curl -sI https://staging-admin.baksomassular.com | head -1
```

**Rollback ke proxy lama** (kalau staging bermasalah):

```bash
cd ~/apps/mas-sular-prd/deploy/prd/proxy && docker -H unix:///var/run/docker.sock compose down
docker -H unix:///var/run/docker.sock compose -f /opt/mas-sular/docker-compose.proxy.yml up -d nginx
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
docker -H unix:///var/run/docker.sock compose up -d                 # recreate (mount berubah), blip ~2 detik
docker -H unix:///var/run/docker.sock exec mas-sular-nginx nginx -t

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

# Ubah app.env (tanpa rebuild): validasi dulu, lalu terapkan.
deploy/prd/deploy.sh --check
deploy/prd/dc up -d --no-deps --force-recreate backend   # menjalankan preflight yang sama lagi

# Ubah kode atau NEXT_PUBLIC_* (rebuild + backup + migrate):
git pull --ff-only && deploy/prd/deploy.sh

# Rollback image aplikasi ke rilis sebelumnya (migrasi DB TIDAK di-revert):
deploy/prd/deploy.sh --rollback
```

**Argumen `deploy.sh`.** Hanya ada tiga bentuk yang diterima: tanpa argumen (deploy
maju), tepat satu argumen `--check`, dan tepat satu argumen `--rollback`. Rollback
harus diminta secara eksplisit dengan argumen itu. Argumen lain apa pun (salah ketik
seperti `--rollbak`, `--rollback=true`, `--force`, kata positional, string kosong,
atau dua argumen seperti `--check --rollback`) **ditolak** dengan exit code 2, pesan
`ABORT`, dan usage, sebelum preflight, git, docker, atau compose dijalankan. Jadi
salah ketik tidak pernah diam-diam menjalankan deploy maju. Tidak ada opsi
`--force`/bypass. Pesan error hanya menyebut jumlah argumen; nilai argumen yang
ditolak **tidak pernah dicetak**, supaya credential yang tidak sengaja ditempel
sebagai argumen tidak masuk ke log.

**`deploy.sh --check` (preflight saja).** Menjalankan preflight **ketat** yang sama
dengan deploy maju: root konfigurasi dipercaya, `app.env`/`compose.env`, placeholder
dan format nilai, perbandingan secret dengan staging (staging **wajib** ada), dan
`docker compose config --quiet`. Exit 0 hanya kalau semuanya lolos. Tidak build,
pull, migrasi, backup, start/stop/recreate container, dan tidak mengubah git atau
file apa pun. Jalankan setiap kali `app.env`/`compose.env` diubah.

**Perintah `deploy/prd/dc`.** `dc` sendiri menjalankan preflight di proses yang
sama, tepat sebelum perintah compose yang bisa menerapkan konfigurasi. Tidak ada
penanda "sudah lolos" yang bisa dipakai ulang, jadi `dc up` tidak bisa melewati
validasi.

| Kelas | Perintah | Sebelum dijalankan |
|---|---|---|
| read-only | `ps`, `logs`, `top`, `images`, `port`, `stats`, `events`, `version`, `ls`, `config --quiet` | langsung (`config` tanpa `--quiet` ditolak: mencetak semua secret) |
| akses operator | `exec` | langsung (tidak membuat container/menerapkan konfigurasi) |
| menghentikan | `stop`, `kill`, `pause`, `down`, `rm` | langsung, supaya respons insiden tidak terblokir; `-v`/`--volumes` dan `--rmi` ditolak |
| menjalankan ulang | `start`, `restart`, `unpause` | preflight kebijakan rollback (production wajib valid; staging dibandingkan kalau tersedia, kalau tidak WARN) |
| menerapkan konfigurasi | `up`, `create`, `run` | preflight **ketat** (sama dengan `deploy.sh --check`), lalu **semua** image aplikasi untuk `IMAGE_TAG` yang dipakai harus sudah ada; `up`/`create` selalu dengan `--no-build` |
| lainnya | `build`, `pull`, `push`, `cp`, `scale`, `watch`, ... | **ditolak**; image hanya dibangun dan di-deploy oleh `deploy.sh` |

**`dc` tidak pernah build atau pull image aplikasi.** `dc up` dan `dc create` selalu
dijalankan dengan `--no-build` (ditambahkan oleh `dc`). `docker compose run` tidak
punya `--no-build`, jadi sebelum `up`/`create`/`run` `dc` memeriksa bahwa
`mas-sular-prd/{backend-migrate,backend,frontend,admin}:<tag>` **sudah ada** di daemon
yang dikunci. `<tag>` adalah `IMAGE_TAG` dari shell kalau di-set, selain itu dari
`release.env`; tag itu juga yang diteruskan ke compose. Tag kosong, tag dengan format
tidak valid, image yang tidak ada, atau image yang tidak bisa diverifikasi = ABORT
(nilai tag dari shell tidak dicetak). Jadi image yang terhapus prune atau `IMAGE_TAG`
yang salah tidak pernah memicu build dari working tree; build ulang lewat `deploy.sh`.
Opsi `--no-build` pada `up`/`create` diperiksa lokal dengan Docker Compose v5.7.0
(`--help`, tanpa daemon); compose di VPS yang tidak mengenalnya akan gagal (tidak
diam-diam build).

**Migrasi hanya lewat `deploy.sh`.** `backend` bergantung pada `backend-migrate`
(`depends_on`). Jadi `dc up` **tanpa** `--no-deps` untuk `backend`, atau `dc up`
tanpa nama service, ikut menjalankan `prisma migrate deploy` **tanpa** backup
pre-migrate. Untuk me-recreate service aplikasi pakai
`deploy/prd/dc up -d --no-deps --force-recreate <service>`. Migrasi (kode baru) selalu
lewat `deploy/prd/deploy.sh`, yang membuat backup pre-migrate lebih dulu.

Setiap perintah punya daftar opsi yang diizinkan, dicocokkan **persis** per argumen
(bukan substring). Opsi yang mengubah *apa* yang diterapkan ditolak sebelum apa pun
berjalan: `--env-file`, `-f`, `-p`, `--profile`, `--build`, `--pull`,
`run --entrypoint`, dan `run -e` kecuali `-e BOOTSTRAP_*` (nama saja; nilainya dari
shell). Argumen positional harus nama service di `docker-compose.yml` (`postgres`,
`redis`, `rabbitmq`, `backend-migrate`, `backend`, `frontend`, `admin`); `dc port`
menerima tepat `<service> <port>`. Argumen yang ditolak **tidak pernah dicetak**;
pesan hanya menyebut nama opsi compose yang dikenal. Variabel yang diinterpolasi
`docker-compose.yml` (misalnya `POSTGRES_PASSWORD`, `RABBITMQ_PASSWORD`,
`NEXT_PUBLIC_*`) **tidak boleh** di-export di shell, karena nilainya akan menimpa
`compose.env`. Kalau ada, `dc` dan `deploy.sh` berhenti; unset dulu. Hanya
`IMAGE_TAG` yang boleh di-set.

**Daemon Docker dikunci ke socket lokal.** Semua perintah docker yang dijalankan
`deploy.sh` dan `dc` sendiri memakai `docker -H unix:///var/run/docker.sock` secara
eksplisit, dan `deploy.sh` meng-export `DOCKER_HOST=unix:///var/run/docker.sock`.
`scripts/backup/backup.sh` memakai socket itu **hanya kalau dijalankan oleh
`deploy.sh`** (backup pre-migrate; mewarisi `DOCKER_HOST`). Kalau `backup.sh`,
`restore-drill.sh`, atau perintah `docker` lain dijalankan sendiri (cron, operator),
pin harus ditulis di perintah itu sendiri; lihat "Perintah docker di luar `deploy.sh`/`dc`"
di bawah. Preflight (`docker compose config --quiet`) dan perintah yang sebenarnya
memakai daemon yang sama.

- Variabel environment berikut **ditolak** (script berhenti sebelum git/docker,
  nilainya tidak dicetak; di-set kosong pun ditolak): `DOCKER_HOST`,
  `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`,
  `COMPOSE_PROFILES` (`docker-compose.yml` production tidak memakai profile),
  `BUILDX_BUILDER`, dan `BUILDX_CONFIG`. Unset dulu sebelum menjalankan `dc` atau
  `deploy.sh`.
- **Builder BuildKit dikunci.** `deploy.sh` build dengan
  `docker -H unix:///var/run/docker.sock compose build --builder default <service>`:
  builder `default` adalah builder driver `docker` di dalam daemon yang dikunci.
  Builder yang tersimpan lewat `docker buildx use [--global]` (`~/.docker/buildx`)
  dan `BUILDX_BUILDER` tidak dipakai. Yang **dijamin**: perintah build selalu memuat
  `--builder default` dan daemon yang dikunci (diuji offline dengan stub). Yang
  **tidak** diuji di sini: bahwa compose/buildx versi VPS benar-benar menghormati
  `--builder` di atas builder tersimpan (opsi `--builder` ada di Compose v5.7.0
  lokal, diperiksa lewat `--help`; versi yang tidak mengenalnya gagal, tidak
  diam-diam memakai builder lain). Preflight tidak memakai builder.
- Context yang tersimpan lewat `docker context use` (`currentContext` di
  `~/.docker/config.json`) **tidak** bisa membelokkan perintah production: Docker CLI
  memprioritaskan `-H` dan `DOCKER_HOST` di atas context tersimpan. Perilaku ini
  diperiksa lokal dengan Docker CLI 29.9.3 memakai socket sementara yang tidak ada,
  bukan di VPS.
- **Syarat host:** socket `/var/run/docker.sock` harus ada di host deployment dan
  bisa diakses user `massular`. Kalau tidak, setiap perintah gagal dengan error
  koneksi (tidak pernah jatuh ke daemon lain). Identitas daemon dan akses socket di
  VPS **belum** diverifikasi.

Batasan: `dc` adalah **kontrol keselamatan operator, bukan batas keamanan**. Siapa
pun yang punya akses ke socket Docker (grup `docker`, termasuk `massular` yang
menjalankan `deploy.sh`) tetap bisa menjalankan `docker`/`docker compose` langsung
dan melewati `dc`. Akses itu setara root ke host, jadi selalu gunakan
`deploy/prd/dc` atau `deploy/prd/deploy.sh`.

**Perintah docker di luar `deploy.sh`/`dc`.** Cron, restore drill, proxy, dan perintah
operator lain **tidak** melewati pemeriksaan `deploy.sh`/`dc`. Context tersimpan
(`docker context use`) berlaku untuk mereka kecuali daemon ditulis di perintah itu
sendiri. Karena itu setiap perintah di README ini memakai salah satu bentuk:

- `docker -H unix:///var/run/docker.sock ...` untuk perintah interaktif (jangan
  `export DOCKER_HOST` di shell: `dc`/`deploy.sh` akan menolak), atau
- `DOCKER_HOST=unix:///var/run/docker.sock` di depan script, atau
  `sudo env DOCKER_HOST=unix:///var/run/docker.sock ...` kalau lewat `sudo`. `sudo`
  me-reset environment, jadi `DOCKER_HOST=... sudo ...` atau `export` sebelum `sudo`
  **tidak** berlaku. `env` di belakang `sudo` selalu berlaku.

Batasan yang tersisa: perintah yang diketik operator sendiri tanpa pin, cron sistem
`/etc/cron.d/docker-image-prune` (milik host, berjalan sebagai root), dan isi
environment/konfigurasi shell (`PATH`, `BASH_ENV`, fungsi yang di-export, plugin di
`~/.docker/cli-plugins`, `cliPluginsExtraDirs` dan `proxies` di
`~/.docker/config.json`) **tidak** dikontrol oleh tooling ini; shell dan home user
`massular` serta root dianggap dipercaya.

**Backup harian** (crontab user `massular`, `crontab -e`). Daemon dikunci lewat
`DOCKER_HOST` di depan `backup.sh` (berlaku untuk semua perintah docker di dalamnya).
Container dipilih dengan **nama persis** `mas-sular-prd-postgres-1` (bukan filter
`docker ps`): `backup.sh` memakainya langsung untuk `docker inspect`/`docker exec`, dan
gagal kalau container itu tidak ada atau tidak healthy.

```cron
15 3 * * * cd /home/massular/apps/mas-sular-prd && DOCKER_HOST=unix:///var/run/docker.sock POSTGRES_CONTAINER=mas-sular-prd-postgres-1 UPLOADS_VOLUME=mas-sular-prd_uploads_data BACKUP_DIR=/srv/backups/mas-sular-prd BACKUP_KEY_FILE=/etc/mas-sular-prd/backup.key ./scripts/backup/backup.sh >> /srv/backups/mas-sular-prd/backup.log 2>&1
```

Salin hasil backup ke luar VPS secara berkala. Lakukan restore drill sekali sebelum
go-live. Jalankan sebagai `massular` (pemilik `/etc/mas-sular-prd/backup.key`), dari
checkout production, dengan daemon dikunci:

```bash
cd /home/massular/apps/mas-sular-prd
env DOCKER_HOST=unix:///var/run/docker.sock BACKUP_KEY_FILE=/etc/mas-sular-prd/backup.key bash scripts/backup/restore-drill.sh /srv/backups/mas-sular-prd/mas-sular-postgres-<TS>.dump.enc /srv/backups/mas-sular-prd/manifest-<TS>.json
# Hanya kalau memang harus lewat sudo: env DI BELAKANG sudo, supaya pin tetap terpasang.
sudo env DOCKER_HOST=unix:///var/run/docker.sock BACKUP_KEY_FILE=/etc/mas-sular-prd/backup.key bash scripts/backup/restore-drill.sh /srv/backups/mas-sular-prd/mas-sular-postgres-<TS>.dump.enc /srv/backups/mas-sular-prd/manifest-<TS>.json
```

Drill memulihkan dump yang sudah didekripsi ke container sekali pakai tanpa network
dan hanya mencetak baris `DRILL_*` berisi **jumlah** (tabel, migrasi, baris per tabel,
ukuran data). Jangan set `DRILL_EXTRA_SQL` untuk query yang mengembalikan data
pelanggan atau secret, dan jangan tempel dump atau isi tabel ke tiket/log.

**Image rollback dan cron prune.** `/etc/cron.d/docker-image-prune` menjalankan
`docker image prune -af --filter until=24h`, sehingga image rilis sebelumnya
terhapus setelah 24 jam dan `--rollback` gagal. Kecualikan image production:

```bash
sudo sed -i 's|--filter "until=24h"|--filter "until=24h" --filter "label!=id.baksomassular.stack=mas-sular-prd"|' /etc/cron.d/docker-image-prune
sudo grep -F 'label!=id.baksomassular.stack=mas-sular-prd' /etc/cron.d/docker-image-prune
```

Perintah `grep` **harus** mencetak baris cron itu. `sed` di atas hanya cocok dengan bentuk
ber-tanda kutip `--filter "until=24h"`. Kalau baris cron ditulis tanpa kutip,
`sed` diam-diam tidak mengubah apa pun dan `grep` tidak mencetak apa-apa. Dalam kasus
itu, tambahkan `--filter "label!=id.baksomassular.stack=mas-sular-prd"` ke baris itu
secara manual, lalu ulangi `grep`. Image aplikasi production membawa label itu
(`x-build-labels` di `docker-compose.yml`).

`deploy.sh` sendiri menyimpan 3 tag terakhir per image dan menghapus sisanya.

**Preflight rollback (berbeda dari deploy maju).** `--rollback` hanya menjalankan
ulang image yang sudah pernah di-deploy dengan file env production yang **sama**:
tidak ada build, tidak ada migrasi, tidak ada secret yang berubah. Rollback adalah
jalur darurat, jadi ia **tidak boleh bergantung pada staging**: staging bisa saja
sudah di-takedown, atau justru sedang rusak. Karena itu `deploy.sh --rollback`
memakai `preflight_rollback`, bukan `preflight`. Fungsi ini hanya bisa dicapai lewat
argumen `--rollback`; tidak ada flag atau variabel environment yang mengaktifkannya
pada deploy maju.

Tetap **wajib** (gagal = rollback berhenti sebelum `up`, tanpa mengubah apa pun):

- `release.env` punya `PREVIOUS_IMAGE_TAG`, dan image backend/frontend/admin untuk tag
  itu masih ada.
- `app.env` dan `compose.env`: ada, bisa dibaca, `chmod 600`, file biasa, tidak
  kosong, setiap baris non-komentar berbentuk `KEY=VALUE`, dan tanpa key ganda.
- Kebijakan root dipercaya (`PRD_CONF_DIR` tidak menunjuk direktori lain; root
  `chmod 700`, milik user deploy, parent aman) dan kebijakan path staging
  (`STAGING_ENV_FILE` tidak di-set, `staging-env.path` valid, path staging bukan
  file di dalam root).
- Sintaks nilai yang didukung untuk key yang diperiksa di `app.env`/`compose.env`.
- Semua pemeriksaan production lain yang sama dengan deploy maju: tidak ada
  `CHANGE_ME`/placeholder, password compose >= 32 karakter alfanumerik, tidak ada
  `DATABASE_URL`/`REDIS_URL`/`RABBITMQ_URL` di `app.env`, tidak ada nilai
  `staging`/`sandbox`/`stage-`, tidak ada `JNE_WEBHOOK_EXTRA_SOURCE_IPS`, konsistensi
  flag Midtrans/JNE, dan `dc config --quiet`.
- Kalau env staging **bisa dipakai**, perbandingan secret-reuse dijalankan **persis
  sama** dengan deploy maju: secret yang sama dengan staging (termasuk
  `MIDTRANS_SERVER_KEY` bila `MIDTRANS_ENABLED` bukan persis `false`) tetap
  menggagalkan rollback. Pengecualian Qontak/Resend tidak berubah.

Sengaja **tidak** dilakukan: bila env staging (di path default atau path dari
`staging-env.path`) hilang, bukan file biasa, tidak bisa dibaca, kosong, tidak bisa
di-parse, pemilik/permission-nya tidak dipercaya, sintaks nilainya ambigu, atau
tidak meng-assign key staging wajib (jadi bukan file staging),
perbandingan dengan staging **dilewati** untuk rollback ini. File seperti itu
**tidak pernah** dianggap salinan staging yang sah, dan script selalu mencetak:

```text
WARN: secret-reuse (rollback): staging env <alasan> - staging secret-reuse comparison NOT performed for this rollback; ...
```

Cara membaca hasilnya:

- `ABORT: ...` saat `--rollback`: masalah ada di input **production** (`release.env`,
  image, `app.env`, `compose.env`) atau secret yang benar-benar sama dengan staging.
  Perbaiki file yang disebut.
  - Untuk masalah input production, menghapus/memindahkan env staging **tidak
    membantu**: pemeriksaan production tetap berjalan.
  - Untuk ABORT karena **secret sama dengan staging**, menghapus/memindahkan env
    staging secara teknis **memang** membuat rollback melewati perbandingan itu
    (dengan WARN). Ini **dilarang** oleh prosedur, begitu juga mengubah
    `staging-env.path` ke file lain: secret yang sama adalah masalah keamanan nyata.
    Rotasi secret di `app.env`/`compose.env`, atau eskalasi ke owner untuk
    keputusan tertulis.
  - `ABORT` dari `staging path policy` atau `STAGING_ENV_FILE is not supported`:
    konfigurasi path staging salah (bukan staging tidak tersedia). Perbaiki
    `staging-env.path` atau unset `STAGING_ENV_FILE`; rollback juga berhenti di sini.
  - `ABORT ... is the production app/compose env file (wrong role)`: path staging
    menunjuk ke file production. Perbaiki `staging-env.path`.
- `WARN: ... comparison NOT performed`: rollback tetap jalan, tapi pemisahan secret
  dari staging **tidak diverifikasi** kali ini. Setelah insiden, pulihkan/konfirmasi
  file staging lalu jalankan deploy maju berikutnya seperti biasa (yang ketat), atau
  catat bahwa staging memang sudah di-decommission.
- Deploy maju yang gagal dengan `staging env file is missing` (atau `not readable`,
  `empty`, `unparseable line`, `does not assign ... not a staging env file`)
  **disengaja**: kembalikan file staging di path default, atau (kalau staging
  memang dipindah) tulis path yang benar ke `staging-env.path`. Kalau staging sudah
  dimatikan permanen, ganti dulu kebijakannya lewat perubahan kode yang direview,
  bukan dengan file kosong atau file dummy.
- Output yang gagal aman untuk ditempel ke tiket karena tidak memuat nilai dari
  `deploy.sh`. Tetap periksa dulu output `docker compose` atau backup yang ikut
  tercetak.

Status verifikasi: perilaku ini diuji **offline** dengan
`bash deploy/prd/test-secret-reuse.sh` (file sintetis, salinan sandbox `deploy.sh`
dengan stub `dc`/`docker`/`git`). Rollback **belum** diverifikasi di VPS/production.

## 6. Go-live: aktifkan fitur bertahap

`app.env` dimulai dalam keadaan aman: kurir, Midtrans, dan notifikasi **OFF**,
retention dalam **dry-run**. Urutannya:

1. Login admin, lalu buat **outlet aktif** yang asli. Kurir menolak boot tanpa outlet.
2. Isi kredensial production, lalu set flag `*_ENABLED=true` sesuai komentar di `app.env`.
   Setelah itu jalankan `deploy/prd/deploy.sh --check`, dan kalau lolos,
   `deploy/prd/dc up -d --no-deps --force-recreate backend` (yang juga menjalankan
   preflight yang sama sebelum menerapkan apa pun).
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
docker -H unix:///var/run/docker.sock compose up -d && docker -H unix:///var/run/docker.sock exec mas-sular-nginx nginx -t

# 3. Matikan staging (volume tetap disimpan sampai backup terverifikasi)
cd ~/apps/mas-sular
docker -H unix:///var/run/docker.sock compose --env-file production.env -f docker-compose.production.yml down

# 4. Opsional: cabut sertifikat staging
sudo certbot delete --cert-name staging-ecommerce.baksomassular.com
```

**Jangan hapus `~/apps/mas-sular/production.env`** saat takedown: deploy maju
production tetap membandingkan secret dengan file itu dan akan berhenti (fail closed)
kalau file hilang. Rollback tidak terblokir (lihat "Preflight rollback" di bagian 5),
tetapi deploy maju berikutnya akan gagal sampai file dikembalikan atau kebijakan
diubah lewat perubahan kode yang direview.

Webroot ACME `/opt/mas-sular/nginx/certbot/www` **tetap dipakai** oleh renewal
sertifikat production. Jangan hapus `/opt/mas-sular/nginx/certbot` kecuali
`/etc/letsencrypt/renewal/ecommerce.baksomassular.com.conf` sudah dipindah ke
webroot lain.

## Register tindak lanjut keamanan (tooling production, Batch A)

Temuan yang **masih terbuka** dari review independen Batch A. Tidak ada yang dianggap
selesai. **Track 1** = gerbang wajib sebelum deploy production pertama; **pasca-deploy** =
boleh dikerjakan setelah go-live, dengan alasan di bawah.

| ID | Deskripsi | Severity | Mitigasi / batasan saat ini | Tindakan yang disarankan | Klasifikasi |
|---|---|---|---|---|---|
| V1 | Versi Docker Compose/buildx di VPS belum diverifikasi. Opsi yang dipakai: `up --no-build --no-deps --wait --wait-timeout` (deploy dan **rollback**), `create --no-build`, `run --rm --no-deps`, `build --builder` (deploy), dan opsi allow-list `dc`. Semuanya hanya diperiksa terhadap Compose v5.7.0 / buildx v0.38.1 lokal (`--help`, tanpa daemon). Versi minimum yang pasti tidak bisa ditentukan offline. | MEDIUM | Compose yang tidak mengenal opsi itu gagal dengan "unknown flag" (fail closed, tidak diam-diam build atau memakai builder lain). Tapi kegagalan di jalur `--rollback` terjadi saat darurat. | Jalankan "Pemeriksaan Track 1" V1 di bawah. Versi yang tercatat di VPS menjadi versi minimum yang diterima. | **Track 1**: tanpa ini deploy, `dc up`, atau rollback darurat bisa gagal saat go-live. Gagalnya aman, tapi harus diketahui sebelumnya. |
| D2 | Environment shell dipercaya: `PATH`, `BASH_ENV`/`ENV`, fungsi yang di-export (`BASH_FUNC_*`, mis. `stat`/`id`/`git` palsu yang melumpuhkan cek pemilik/mode), `HOME`, `TMPDIR`, `~/.docker/config.json` (`cliPluginsExtraDirs`, `proxies`), `~/.docker/cli-plugins`, `~/.docker/buildx`. Semuanya dibaca sebelum atau di luar kendali script. | MEDIUM (inheren) | Variabel pembelok daemon/builder ditolak; `-H`, `--builder default`, dan root config tetap dipin. `dc` adalah kontrol keselamatan, bukan batas keamanan. Pengendali shell user grup `docker` sudah setara root. | Jalankan "Pemeriksaan Track 1" D2 di bawah (perintah dengan hasil yang ditentukan). Pasca-deploy: jalankan deploy lewat wrapper `env -i` dengan `PATH`/`HOME` tetap. | **Track 1 untuk pemeriksaan prosedural** (murah, menutup jalur yang tidak bisa dicegah dari dalam script). Hardening kode: pasca-deploy, karena `BASH_ENV` dan fungsi yang di-export sudah berjalan sebelum baris pertama script, sehingga perbaikan dari dalam script tidak lengkap. |
| S1 | Path checkout staging belum pasti. README dan default kode memakai `~/apps/mas-sular` (`/home/massular/apps/mas-sular/production.env`); `scripts/backup/RUNBOOK.md` (stack asli) memakai `/opt/mas-sular` sebagai checkout. Nilai key/dir/project staging (`/etc/mas-sular`, `/srv/backups/mas-sular`, project `mas-sular`) sengaja berbeda dari production. | INFO | Default yang salah membuat deploy maju gagal dengan aman ("staging env file is missing"); cron RUNBOOK di direktori salah gagal dengan jelas. | Di VPS: `stat -c '%U %a %n' /home/massular/apps/mas-sular/production.env /opt/mas-sular/production.env` (hanya metadata, bukan isi). Pakai `staging-env.path` kalau file ada di tempat lain, dan sesuaikan `cd` di cron RUNBOOK §15. | **Track 1**: deploy maju pertama butuh file staging yang benar (atau berhenti). |
| M3 | Input backup pre-migrate dari environment. Status: `KEEP_POSTGRES`/`KEEP_UPLOADS`, `COMPOSE_FILE`, `ENV_FILE`, dan `POSTGRES_SERVICE` kini **di-set eksplisit** oleh `deploy.sh`, dan `backup.sh` menolak `KEEP_*` yang bukan angka 1–999. **Masih terbuka:** `BACKUP_DIR` dan `BACKUP_KEY_FILE` tetap bisa menimpa default (`/srv/backups/mas-sular-prd`, `/etc/mas-sular-prd/backup.key`). | LOW | Nilai `BACKUP_DIR` dicetak di log. `backup.sh` mewajibkan key ada, tidak kosong, dan di luar `BACKUP_DIR`, serta memverifikasi artifact dengan dekripsi. Memanipulasi environment = asumsi D2. | Tolak override `BACKUP_DIR`/`BACKUP_KEY_FILE` seperti `PRD_CONF_DIR` (pin ke default), atau validasi pemilik/mode direktori dan key. | **Pasca-deploy, tapi sebelum deploy maju kedua.** Deploy pertama tidak membuat backup pre-migrate (DB kosong), cron backup punya environment bersih, dan rollback tidak membuat backup. Backup pre-migrate baru menjadi jaring pengaman migrasi data nyata mulai deploy kedua, yang bisa saja hotfix di hari yang sama: perlakukan sebagai gerbang bertanggal. |
| M2 | Direktori induk file env staging (dan `staging-env.path`) tidak diperiksa pemilik/mode-nya; hanya file itu sendiri yang diperiksa. | LOW | File staging wajib milik `massular`/root dan tidak writable group/others. Path-nya dari default tetap atau file di root production yang dipercaya; path di dalam root ditolak. Yang bisa menulis ke direktori induk itu sudah `massular`/root. | Periksa setiap komponen induk (pemilik root/deploy user, tidak writable group/others), seperti parent root config. | **Pasca-deploy**: hanya melemahkan perbandingan secret dengan staging (bukan secret production atau target daemon), dan eksploitasinya butuh akses yang sudah setara pemilik konfigurasi production. Gugur saat staging di-takedown. |
| C | `dc exec`/`dc run` mengasumsikan Compose berhenti mem-parse opsi setelah nama service, sehingga argumen sesudahnya menjadi perintah container. Ini tidak bisa diuji dengan stub. | LOW | Semua opsi sebelum service divalidasi persis. Preflight ketat dan cek image tetap berjalan untuk `run`. `exec` tidak menerapkan konfigurasi. Kalau asumsi salah, efeknya hanya opsi compose tambahan yang diketik operator pada container sekali pakai, oleh user yang sudah setara root. | Asumsi terkonfirmasi lokal pada Compose v5.7.0 (review independen: opsi tak dikenal setelah service tidak di-parse untuk `exec`/`run`). Verifikasi sekali di VPS: `deploy/prd/dc exec postgres echo --definitely-not-a-flag` harus mencetak `--definitely-not-a-flag`, bukan `unknown flag`. | **Pasca-deploy**: tidak menyentuh daemon, builder, secret, atau konfigurasi yang diterapkan; hanya akses operator. |

### Pemeriksaan Track 1 sebelum deploy production pertama

Jalankan sebagai `massular`, di **login shell baru yang sama** yang nanti menjalankan
`deploy/prd/deploy.sh`, dari checkout production. Tempel seluruh output ke tiket
go-live. Setiap baris ber-komentar `# harus ...` adalah kriteria lulus. Satu saja
yang gagal = jangan deploy.

```bash
# V1 - kemampuan Compose/buildx di VPS (catat versinya: itu versi minimum yang diterima)
docker -H unix:///var/run/docker.sock compose version
docker -H unix:///var/run/docker.sock buildx version
for f in --no-build --no-deps --wait --wait-timeout; do docker -H unix:///var/run/docker.sock compose up --help | grep -qE -- "[[:space:]]$f[[:space:]]" || echo "MISSING: up $f"; done
docker -H unix:///var/run/docker.sock compose create --help | grep -qE -- '[[:space:]]--no-build[[:space:]]' || echo "MISSING: create --no-build"
docker -H unix:///var/run/docker.sock compose run --help | grep -qE -- '[[:space:]]--no-deps[[:space:]]' || echo "MISSING: run --no-deps"
docker -H unix:///var/run/docker.sock compose build --help | grep -qE -- '[[:space:]]--builder[[:space:]]' || echo "MISSING: build --builder"
# harus: tidak ada baris "MISSING:"

# D2 - environment shell yang dipercaya
env | grep -E '^(BASH_ENV|ENV|BASH_FUNC_|SHELLOPTS|BASHOPTS|DOCKER_|BUILDX_|COMPOSE_|KEEP_|BACKUP_|MIN_FREE_MB|IMAGE_TAG|ALLOW_DIRTY|PRD_|STAGING_|POSTGRES_|APP_DB_|REDIS_|RABBITMQ_|NEXT_PUBLIC_)'
# harus: kosong
declare -Fx
# harus: kosong (tidak ada fungsi yang di-export)
bash -c 'type -a git stat id sed awk grep realpath sha256sum gpg docker'
# harus: setiap nama hanya "... is /usr/bin/..." atau "... is /bin/..." (bukan function atau path lain).
# Dijalankan lewat `bash -c` (shell non-interaktif): alias bawaan ~/.bashrc seperti
# grep='grep --color=auto' tidak ikut (alias juga tidak diwarisi deploy.sh), tapi fungsi
# yang di-export dan PATH tetap terlihat, persis seperti yang dilihat deploy.sh.
ls -A ~/.docker/cli-plugins 2>/dev/null
# harus: kosong atau tidak ada (plugin dari paket resmi ada di /usr/libexec/docker/cli-plugins)
grep -nE 'cliPluginsExtraDirs|proxies|credsStore|credHelpers|aliases' ~/.docker/config.json 2>/dev/null
# harus: kosong, atau setiap baris ditinjau dan dicatat di tiket

# S1 - lokasi file env staging (hanya metadata, bukan isi)
stat -c '%U %a %n' /home/massular/apps/mas-sular/production.env /opt/mas-sular/production.env 2>&1
# harus: path yang dipakai staging terlihat; kalau bukan path pertama, tulis path itu ke /etc/mas-sular-prd/staging-env.path
```
