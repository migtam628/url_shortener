-- Fix: click partitions were only ever provisioned FORWARD from the current
-- month, so any click with a timestamp in a past month had no partition to
-- land in and fell into click_default. That silently defeats partition
-- pruning for the affected range.
--
-- This happens in three ordinary situations, not just during seeding:
--   * seeding or importing historical click data
--   * a worker draining a queue backlog that straddles a month boundary
--   * replaying a dead-letter job days later
--
-- Two changes:
--   1. mtlink_ensure_click_partitions gains a months_back argument
--      (default 2) so recent history always has somewhere to go.
--   2. mtlink_drain_default_partition rescues anything already stranded.
--
-- Note on ordering inside the drain: Postgres refuses to CREATE a partition
-- whose range overlaps rows currently held by the DEFAULT partition, so the
-- rows must be lifted out BEFORE the partitions are created, then
-- re-inserted so they route correctly. Doing it in one transaction means
-- there is no window in which a click exists in neither place.

-- ---------------------------------------------------------------------------
-- 1. Provision backwards as well as forwards
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS mtlink_ensure_click_partitions(INT);

CREATE OR REPLACE FUNCTION mtlink_ensure_click_partitions(
    months_ahead INT DEFAULT 12,
    months_back  INT DEFAULT 2
)
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    i INT;
BEGIN
    FOR i IN -months_back..months_ahead LOOP
        RETURN NEXT mtlink_create_click_partition(
            (date_trunc('month', CURRENT_DATE) + (i || ' month')::INTERVAL)::DATE
        );
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Rescue rows already stranded in the default partition
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mtlink_drain_default_partition()
RETURNS TABLE(moved BIGINT, partitions TEXT[])
LANGUAGE plpgsql
AS $$
DECLARE
    m       DATE;
    created TEXT[] := '{}';
    total   BIGINT := 0;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM click_default LIMIT 1) THEN
        RETURN QUERY SELECT 0::BIGINT, created;
        RETURN;
    END IF;

    -- Lift the rows out first — a partition cannot be created while the
    -- default still holds rows in its range.
    CREATE TEMP TABLE _mtlink_drain ON COMMIT DROP AS
        SELECT * FROM click_default;

    SELECT COUNT(*) INTO total FROM _mtlink_drain;

    DELETE FROM click_default;

    FOR m IN SELECT DISTINCT date_trunc('month', ts)::DATE FROM _mtlink_drain ORDER BY 1
    LOOP
        created := created || mtlink_create_click_partition(m);
    END LOOP;

    INSERT INTO click (id, ts, link_id, tenant_id, ip_hash, country, region, city,
                       device_type, os, browser, language, referrer_host, rule_id, is_bot)
    SELECT id, ts, link_id, tenant_id, ip_hash, country, region, city,
           device_type, os, browser, language, referrer_host, rule_id, is_bot
    FROM _mtlink_drain;

    RETURN QUERY SELECT total, created;
END;
$$;

-- Rescue stranded rows first, THEN provision the wider window.
SELECT * FROM mtlink_drain_default_partition();
SELECT mtlink_ensure_click_partitions(12, 6);
