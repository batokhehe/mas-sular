#!/bin/sh
# Least-privilege roles for production. Runs ONCE, by the postgres image's
# entrypoint, only when the data volume is empty (first boot). It never runs again,
# so changing a password later is a manual ALTER ROLE (see deploy/prd/README.md).
#
#   mas_sular_owner  owns the database and the public schema. Used ONLY by the
#                    one-shot migrator (`prisma migrate deploy`) and bootstrap.
#   mas_sular_app    the running API. DML only: SELECT/INSERT/UPDATE/DELETE on
#                    tables and USAGE on sequences — no DDL, no superuser, so an
#                    SQL injection cannot drop tables or reach COPY ... PROGRAM.
#
# Default privileges make every table a FUTURE migration creates (as the owner)
# automatically usable by the app role.
set -eu

: "${APP_DB_OWNER_PASSWORD:?APP_DB_OWNER_PASSWORD is required}"
: "${APP_DB_APP_PASSWORD:?APP_DB_APP_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" \
  -v owner_pw="$APP_DB_OWNER_PASSWORD" \
  -v app_pw="$APP_DB_APP_PASSWORD" <<'SQL'
CREATE ROLE mas_sular_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE mas_sular_app   LOGIN PASSWORD :'app_pw';

ALTER DATABASE :"db" OWNER TO mas_sular_owner;
ALTER SCHEMA public OWNER TO mas_sular_owner;

REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO mas_sular_app;
GRANT USAGE ON SCHEMA public TO mas_sular_app;

ALTER DEFAULT PRIVILEGES FOR ROLE mas_sular_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mas_sular_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mas_sular_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mas_sular_app;
SQL

echo "[initdb] roles mas_sular_owner / mas_sular_app created"
