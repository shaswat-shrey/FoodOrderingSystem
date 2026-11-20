-- Runs once when the Postgres volume is first created.
-- Prisma migrations also declare these extensions; this ensures the
-- shadow/test databases created by tooling have them available too.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Separate database for automated integration tests.
CREATE DATABASE fos_test;
\connect fos_test
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Shadow database for Prisma drift checks / migrate dev.
CREATE DATABASE fos_shadow;
