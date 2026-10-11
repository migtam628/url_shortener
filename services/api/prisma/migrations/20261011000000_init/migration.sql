-- MT Link initial schema.
--
-- Hand-written rather than generated, because `click` is a RANGE-partitioned
-- table and Prisma Migrate cannot express partitioning. Everything else
-- matches prisma/schema.prisma one-for-one.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "UserRole"      AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE "CertStatus"    AS ENUM ('pending', 'issuing', 'active', 'failed');
CREATE TYPE "RuleMatchType" AS ENUM ('country', 'region', 'device', 'os', 'language', 'referrer', 'ab');

-- ---------------------------------------------------------------------------
-- Tenancy and identity
-- ---------------------------------------------------------------------------
CREATE TABLE "tenant" (
    "id"         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "name"       TEXT         NOT NULL,
    "slug"       TEXT         NOT NULL UNIQUE,
    "plan"       TEXT         NOT NULL DEFAULT 'self-hosted',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "user" (
    "id"            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"     UUID         NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
    "email"         TEXT         NOT NULL UNIQUE,
    "password_hash" TEXT         NOT NULL,
    "name"          TEXT         NOT NULL,
    "role"          "UserRole"   NOT NULL DEFAULT 'member',
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3)
);
CREATE INDEX "user_tenant_id_idx" ON "user"("tenant_id");

CREATE TABLE "session" (
    "id"         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id"    UUID         NOT NULL REFERENCES "user"("id")   ON DELETE CASCADE,
    "tenant_id"  UUID         NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
    "token_hash" TEXT         NOT NULL UNIQUE,
    "user_agent" TEXT,
    "ip_hash"    TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "session_user_id_idx"    ON "session"("user_id");
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

CREATE TABLE "api_key" (
    "id"           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"    UUID         NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
    "name"         TEXT         NOT NULL,
    "key_hash"     TEXT         NOT NULL UNIQUE,
    "prefix"       TEXT         NOT NULL UNIQUE,
    "scopes"       TEXT[]       NOT NULL DEFAULT '{}',
    "last_used_at" TIMESTAMP(3),
    "expires_at"   TIMESTAMP(3),
    "revoked_at"   TIMESTAMP(3),
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "api_key_tenant_id_idx" ON "api_key"("tenant_id");

-- ---------------------------------------------------------------------------
-- Domains and organization
-- ---------------------------------------------------------------------------
CREATE TABLE "domain" (
    "id"                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"          UUID         NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
    "hostname"           TEXT         NOT NULL UNIQUE,
    "is_default"         BOOLEAN      NOT NULL DEFAULT false,
    "main_page_redirect" TEXT,
    "not_found_redirect" TEXT,
    "cert_status"        "CertStatus" NOT NULL DEFAULT 'pending',
    "cert_last_error"    TEXT,
    "cert_renew_at"      TIMESTAMP(3),
    "verified_at"        TIMESTAMP(3),
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "domain_tenant_id_idx" ON "domain"("tenant_id");

-- At most one default domain per tenant.
CREATE UNIQUE INDEX "domain_one_default_per_tenant"
    ON "domain"("tenant_id") WHERE "is_default";

CREATE TABLE "folder" (
    "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
    "name"      TEXT NOT NULL,
    "parent_id" UUID REFERENCES "folder"("id") ON DELETE CASCADE
);
CREATE INDEX "folder_tenant_id_idx" ON "folder"("tenant_id");
-- NULLS NOT DISTINCT so two root folders cannot share a name.
CREATE UNIQUE INDEX "folder_tenant_id_parent_id_name_key"
    ON "folder"("tenant_id", "parent_id", "name") NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- Links
-- ---------------------------------------------------------------------------
CREATE TABLE "link" (
    "id"             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "domain_id"      UUID         NOT NULL REFERENCES "domain"("id") ON DELETE CASCADE,
    "tenant_id"      UUID         NOT NULL,
    "slug"           TEXT         NOT NULL,
    "destination"    TEXT         NOT NULL,
    "redirect_code"  INTEGER      NOT NULL DEFAULT 302,
    "title"          TEXT,
    "description"    TEXT,
    "folder_id"      UUID         REFERENCES "folder"("id") ON DELETE SET NULL,
    "tags"           TEXT[]       NOT NULL DEFAULT '{}',
    "created_by_id"  UUID         REFERENCES "user"("id") ON DELETE SET NULL,
    "og_title"       TEXT,
    "og_description" TEXT,
    "og_image"       TEXT,
    "og_fetched_at"  TIMESTAMP(3),
    "click_count"    BIGINT       NOT NULL DEFAULT 0,
    "archived_at"    TIMESTAMP(3),
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "link_redirect_code_check" CHECK ("redirect_code" IN (301, 302, 307))
);

-- THE hot index. Every redirect that misses cache resolves through this.
CREATE UNIQUE INDEX "link_domain_id_slug_key" ON "link"("domain_id", "slug");
CREATE INDEX "link_tenant_created_idx" ON "link"("tenant_id", "created_at" DESC);
CREATE INDEX "link_tenant_folder_idx"  ON "link"("tenant_id", "folder_id");
CREATE INDEX "link_tags_idx"           ON "link" USING GIN ("tags");
-- Trigram index for dashboard search over title/destination.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE INDEX "link_search_idx" ON "link"
    USING GIN (("slug" || ' ' || COALESCE("title", '') || ' ' || "destination") gin_trgm_ops);

CREATE TABLE "link_version" (
    "id"            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "link_id"       UUID         NOT NULL REFERENCES "link"("id") ON DELETE CASCADE,
    "destination"   TEXT         NOT NULL,
    "redirect_code" INTEGER      NOT NULL,
    "slug"          TEXT         NOT NULL,
    "changed_by_id" UUID         REFERENCES "user"("id") ON DELETE SET NULL,
    "changed_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note"          TEXT
);
CREATE INDEX "link_version_link_id_changed_at_idx"
    ON "link_version"("link_id", "changed_at" DESC);

CREATE TABLE "link_rule" (
    "id"          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "link_id"     UUID            NOT NULL REFERENCES "link"("id") ON DELETE CASCADE,
    "priority"    INTEGER         NOT NULL DEFAULT 0,
    "match_type"  "RuleMatchType" NOT NULL,
    "match_value" JSONB           NOT NULL,
    "destination" TEXT            NOT NULL,
    "weight"      INTEGER         NOT NULL DEFAULT 100,
    "created_at"  TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "link_rule_link_id_priority_idx" ON "link_rule"("link_id", "priority");

CREATE TABLE "link_security" (
    "link_id"          UUID    PRIMARY KEY REFERENCES "link"("id") ON DELETE CASCADE,
    "password_hash"    TEXT,
    "expires_at"       TIMESTAMP(3),
    "expired_redirect" TEXT,
    "max_clicks"       INTEGER,
    "click_count"      INTEGER NOT NULL DEFAULT 0,
    "cloak"            BOOLEAN NOT NULL DEFAULT false,
    "hide_referrer"    BOOLEAN NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------------
-- Clicks — RANGE partitioned on ts, monthly.
--
-- The primary key must contain the partition key, hence (id, ts). Dropping
-- old data is a DETACH + DROP of one partition rather than a mass DELETE,
-- which is the whole reason for partitioning here.
-- ---------------------------------------------------------------------------
CREATE TABLE "click" (
    "id"            BIGSERIAL    NOT NULL,
    "ts"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "link_id"       UUID         NOT NULL,
    "tenant_id"     UUID         NOT NULL,
    "ip_hash"       TEXT,
    "country"       CHAR(2),
    "region"        TEXT,
    "city"          TEXT,
    "device_type"   TEXT,
    "os"            TEXT,
    "browser"       TEXT,
    "language"      VARCHAR(16),
    "referrer_host" TEXT,
    "rule_id"       UUID,
    "is_bot"        BOOLEAN      NOT NULL DEFAULT false,
    PRIMARY KEY ("id", "ts")
) PARTITION BY RANGE ("ts");

CREATE INDEX "click_link_id_ts_idx"   ON "click"("link_id", "ts" DESC);
CREATE INDEX "click_tenant_id_ts_idx" ON "click"("tenant_id", "ts" DESC);

-- Catch-all so an insert with an out-of-range timestamp (clock skew, a
-- replayed queue job) is never lost. Monitored; should normally be empty.
CREATE TABLE "click_default" PARTITION OF "click" DEFAULT;

/**
 * Create the monthly partition covering `target`, if absent. Idempotent.
 */
CREATE OR REPLACE FUNCTION mtlink_create_click_partition(target DATE)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    start_date DATE := date_trunc('month', target)::DATE;
    end_date   DATE := (date_trunc('month', target) + INTERVAL '1 month')::DATE;
    part_name  TEXT := format('click_%s', to_char(start_date, 'YYYY_MM'));
BEGIN
    IF to_regclass(format('public.%I', part_name)) IS NOT NULL THEN
        RETURN part_name || ' (exists)';
    END IF;
    EXECUTE format(
        'CREATE TABLE %I PARTITION OF "click" FOR VALUES FROM (%L) TO (%L)',
        part_name, start_date, end_date
    );
    RETURN part_name || ' (created)';
END;
$$;

/**
 * Ensure partitions exist for the current month plus `months_ahead`.
 * Called at API boot and by the scheduled partition job.
 */
CREATE OR REPLACE FUNCTION mtlink_ensure_click_partitions(months_ahead INT DEFAULT 12)
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    i INT;
BEGIN
    FOR i IN 0..months_ahead LOOP
        RETURN NEXT mtlink_create_click_partition(
            (date_trunc('month', CURRENT_DATE) + (i || ' month')::INTERVAL)::DATE
        );
    END LOOP;
END;
$$;

-- Current month plus 12 ahead, so the table never needs attention for a year.
SELECT mtlink_ensure_click_partitions(12);

-- ---------------------------------------------------------------------------
-- Daily rollup
-- ---------------------------------------------------------------------------
CREATE TABLE "click_daily" (
    "day"         DATE    NOT NULL,
    "link_id"     UUID    NOT NULL,
    "tenant_id"   UUID    NOT NULL,
    "country"     CHAR(2) NOT NULL DEFAULT '--',
    "device_type" TEXT    NOT NULL DEFAULT 'unknown',
    "clicks"      BIGINT  NOT NULL DEFAULT 0,
    "bots"        BIGINT  NOT NULL DEFAULT 0,
    PRIMARY KEY ("day", "link_id", "country", "device_type")
);
CREATE INDEX "click_daily_tenant_id_day_idx" ON "click_daily"("tenant_id", "day");

/**
 * Recompute the rollup for a single day. Idempotent — safe to re-run for a
 * day that was already rolled up, which is what makes backfill trivial.
 */
CREATE OR REPLACE FUNCTION mtlink_rollup_day(target DATE)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    affected BIGINT;
BEGIN
    DELETE FROM "click_daily" WHERE "day" = target;

    INSERT INTO "click_daily" ("day", "link_id", "tenant_id", "country", "device_type", "clicks", "bots")
    SELECT
        target,
        "link_id",
        "tenant_id",
        COALESCE("country", '--'),
        COALESCE("device_type", 'unknown'),
        COUNT(*) FILTER (WHERE NOT "is_bot"),
        COUNT(*) FILTER (WHERE "is_bot")
    FROM "click"
    WHERE "ts" >= target::TIMESTAMPTZ
      AND "ts" <  (target + INTERVAL '1 day')::TIMESTAMPTZ
    GROUP BY "link_id", "tenant_id", COALESCE("country", '--'), COALESCE("device_type", 'unknown');

    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
END;
$$;

-- ---------------------------------------------------------------------------
-- Worker bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE "system_state" (
    "key"        TEXT         PRIMARY KEY,
    "value"      JSONB        NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
