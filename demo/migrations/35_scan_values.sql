-- =====================================================================
-- THE SEEDED SCANS USED OPTION KEYS THE APP DOES NOT KNOW.
--
-- 24_device_scans.sql wrote 'ok' for every healthy field. The real option
-- lists in app.js (DEVICE_FIELDS) never use 'ok' — a trap is 'good', power
-- is 'connected' — so t("df_opt_ok") had no label, every healthy field on
-- the scan screen rendered as an empty select, and the analytics fault
-- counters were reading a vocabulary the engineer's phone never writes.
--
-- Nothing was broken; it was quietly wrong, which is worse in a demo,
-- because it reads as "the form does not remember what I filed".
--
-- This restates the seeded history in the app's own vocabulary, adds the
-- catch tick-lists (pests_found), and leaves a few genuine "do it next
-- visit" promises so the carry-over the scan screen shows has something
-- real to show.
-- =====================================================================

-- ---- healthy values, in the app's words ------------------------------
UPDATE device_inspections SET details = (
  details::jsonb
    || CASE WHEN details::jsonb ->> 'trap_condition'     = 'ok' THEN '{"trap_condition":"good"}'::jsonb ELSE '{}'::jsonb END
    || CASE WHEN details::jsonb ->> 'lamp_status'        = 'ok' THEN '{"lamp_status":"good"}'::jsonb ELSE '{}'::jsonb END
    || CASE WHEN details::jsonb ->> 'sheet_status'       = 'ok' THEN '{"sheet_status":"good"}'::jsonb ELSE '{}'::jsonb END
    || CASE WHEN details::jsonb ->> 'trans_light_status' = 'ok' THEN '{"trans_light_status":"good"}'::jsonb ELSE '{}'::jsonb END
    || CASE WHEN details::jsonb ->> 'bait_status'        = 'ok' THEN '{"bait_status":"good"}'::jsonb ELSE '{}'::jsonb END
    || CASE WHEN details::jsonb ->> 'glue_status'        = 'ok' THEN '{"glue_status":"good"}'::jsonb ELSE '{}'::jsonb END
    || CASE WHEN details::jsonb ->> 'station_condition'  = 'ok' THEN '{"station_condition":"good"}'::jsonb ELSE '{}'::jsonb END
    || CASE WHEN details::jsonb ->> 'electricity'        = 'ok' THEN '{"electricity":"connected"}'::jsonb ELSE '{}'::jsonb END
)::text
WHERE COALESCE(details, '') <> '';

-- 'changed' is a real bait/glue/sheet action; 'replaced' is a real
-- trap/lamp/station action. Both already match. What did not exist was the
-- deferred form, so a fault answered with "next visit" never appeared.
-- Give roughly one damaged lamp in six a promise instead of a fix.
UPDATE device_inspections di SET details = (
  di.details::jsonb || '{"lamp_action":"next_visit_replaced"}'::jsonb)::text
WHERE di.details::jsonb ->> 'lamp_status' = 'damaged'
  AND di.id % 6 = 0;

UPDATE device_inspections di SET details = (
  di.details::jsonb || '{"sheet_action":"next_visit_change"}'::jsonb)::text
WHERE di.details::jsonb ->> 'sheet_status' IN ('full','expired')
  AND di.id % 7 = 0;

UPDATE device_inspections di SET details = (
  di.details::jsonb || '{"electricity_action":"next_visit_reconnect"}'::jsonb)::text
WHERE di.details::jsonb ->> 'electricity' = 'disconnected'
  AND di.id % 5 = 0;

-- ---- what was actually caught ----------------------------------------
-- The tick-list stands in for the free-text findings box on a light trap,
-- so the catch is data the reports print in either language rather than one
-- engineer's wording. Only where the scan found something.
UPDATE device_inspections di SET details = (
  di.details::jsonb || jsonb_build_object('pests_found',
    (ARRAY['house_flies','house_flies,fruit_flies','moths',
           'drain_flies,gnats','house_flies,blow_flies','mosquitoes'])[1 + (di.id % 6)]))::text
FROM devices d
WHERE d.id = di.device_id AND d.type IN ('light_trap','fly_trap')
  AND (di.status = 'activity' OR (di.details::jsonb ->> 'fly_count')::numeric > 20);

UPDATE device_inspections di SET details = (
  di.details::jsonb || jsonb_build_object('pests_found',
    (ARRAY['german_cockroach','house_mouse','ants',
           'german_cockroach,ants','gecko','norway_rat'])[1 + (di.id % 6)]))::text
FROM devices d
WHERE d.id = di.device_id AND d.type = 'glue_station'
  AND di.status = 'activity';

-- ---- the catch, in the analytics -------------------------------------
-- fleet.pests was stubbed empty because nothing wrote a tick-list. Now that
-- the scans carry one, count it: app.js reads [{key, count}] and splits it
-- into the flying list (light traps) and the crawling list (glue stations).
CREATE OR REPLACE FUNCTION fleet_pests(p_from text, p_to text,
                                       p_client_id bigint DEFAULT NULL,
                                       p_site_id bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS
$fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('key', k, 'count', n) ORDER BY n DESC), '[]'::jsonb)
    FROM (
      SELECT btrim(x.k) AS k, count(*) AS n
        FROM device_inspections di
        JOIN devices d ON d.id = di.device_id
        CROSS JOIN LATERAL unnest(string_to_array(di.details::jsonb ->> 'pests_found', ',')) AS x(k)
       WHERE COALESCE(di.details, '') <> ''
         AND di.details::jsonb ->> 'pests_found' IS NOT NULL
         AND left(di.recorded_at, 10) BETWEEN p_from AND p_to
         AND (p_client_id IS NULL OR di.client_id = p_client_id)
         AND (p_site_id IS NULL OR d.site_id = p_site_id)
       GROUP BY btrim(x.k)) q
$fn$;
