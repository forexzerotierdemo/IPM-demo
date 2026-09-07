-- =====================================================================
-- GET /api/analytics — company-wide analytics over a date range,
-- optionally narrowed to one client and one of its branches.
--
-- SECURITY INVOKER, so the scoping the Python handler does by hand in
-- scope() — a supervisor sees their patch or their crew and stops there —
-- falls out of the §6 policies instead. That is the whole reason this is a
-- function and not an Edge handler: scope() is 20 lines of role branching
-- that RLS already performs, and a new panel written here is scoped the day
-- it is written rather than the day someone remembers.
--
-- The shape is fixed by analyticsParts() in app.js. It defaults `fleet`,
-- `reports`, `application` and `spend` if they are absent, but reads
-- `months`, `ar_aging`, `agents`, `chemicals`, `services` and `totals`
-- directly — those must always be present, even empty.
-- =====================================================================

-- The month keys between two dates, inclusive, as the x-axis of every chart.
CREATE OR REPLACE FUNCTION month_labels(p_from text, p_to text)
RETURNS TABLE (m text) LANGUAGE sql IMMUTABLE AS
$fn$
  SELECT to_char(g, 'YYYY-MM')
    FROM generate_series(date_trunc('month', p_from::date),
                         date_trunc('month', p_to::date), interval '1 month') g
$fn$;

CREATE OR REPLACE FUNCTION analytics(
  p_from text DEFAULT NULL, p_to text DEFAULT NULL,
  p_client_id bigint DEFAULT NULL, p_site_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE AS
$fn$
DECLARE
  d_to    text := COALESCE(NULLIF(p_to, ''),   today_cairo());
  d_from  text := COALESCE(NULLIF(p_from, ''),
                           to_char((now() AT TIME ZONE 'Africa/Cairo')::date - 365, 'YYYY-MM-DD'));
  -- "none" means the stock that belongs to a client but stands at no branch.
  sid     bigint := CASE WHEN p_site_id ~ '^\d+$' THEN p_site_id::bigint END;
  -- COALESCE, or the whole predicate goes NULL when no site is asked for:
  -- NULL = 'none' is NULL, and "NOT NULL OR false" filters every row out. That
  -- is what made fleet.kpi.total read 0 while by_type counted 80 devices.
  site_none boolean := COALESCE(p_site_id = 'none', false);
  ym      text := left(today_cairo(), 7);
  out     jsonb;
  total_dev int;
BEGIN
  IF NOT app_has_perm('analytics.view') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  SELECT count(*) INTO total_dev FROM devices d
   WHERE d.active = 1 AND d.client_id IS NOT NULL
     AND (p_client_id IS NULL OR d.client_id = p_client_id)
     AND (sid IS NULL OR d.site_id = sid)
     AND (NOT site_none OR d.site_id IS NULL);

  out := jsonb_build_object(
    'from', d_from, 'to', d_to,

    -- revenue trend: invoiced vs collected, per month over the range
    'months', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('m', l.m,
               'total', COALESCE(iv.v, 0), 'paid', COALESCE(pd.v, 0)) ORDER BY l.m)
        FROM month_labels(d_from, d_to) l
        LEFT JOIN (
          SELECT left(i.issue_date, 7) m, round(sum(i.total)::numeric, 2) v
            FROM invoices i
           WHERE i.doc_type = 'invoice' AND i.issue_date BETWEEN d_from AND d_to
             AND (p_client_id IS NULL OR i.client_id = p_client_id)
             AND (sid IS NULL OR i.site_id = sid)
           GROUP BY 1) iv ON iv.m = l.m
        LEFT JOIN (
          SELECT left(p.paid_at, 7) m, round(sum(p.amount)::numeric, 2) v
            FROM payments p JOIN invoices i ON i.id = p.invoice_id
           WHERE p.paid_at BETWEEN d_from AND d_to || ' 23:59:59'
             AND (p_client_id IS NULL OR i.client_id = p_client_id)
             AND (sid IS NULL OR i.site_id = sid)
           GROUP BY 1) pd ON pd.m = l.m), '[]'::jsonb),

    -- AR aging: a point-in-time snapshot of what is still open
    'ar_aging', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'due', due))
        FROM (
          SELECT CASE
                   WHEN i.due_date IS NULL OR i.due_date >= today_cairo() THEN 'current'
                   WHEN i.due_date >= to_char((now() AT TIME ZONE 'Africa/Cairo')::date - 30, 'YYYY-MM-DD') THEN '1-30'
                   WHEN i.due_date >= to_char((now() AT TIME ZONE 'Africa/Cairo')::date - 60, 'YYYY-MM-DD') THEN '31-60'
                   ELSE '60+' END AS bucket,
                 round(sum(i.total - COALESCE(
                   (SELECT sum(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0))::numeric, 2) AS due
            FROM invoices i
           WHERE i.doc_type = 'invoice' AND i.status NOT IN ('paid','cancelled')
             AND (p_client_id IS NULL OR i.client_id = p_client_id)
             AND (sid IS NULL OR i.site_id = sid)
           GROUP BY 1) x), '[]'::jsonb),

    -- who did the work
    'agents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('full_name', u.full_name,
               'total', t.total, 'completed', t.completed) ORDER BY t.completed DESC)
        FROM users u
        CROSS JOIN LATERAL (
          SELECT count(v.id) AS total,
                 count(*) FILTER (WHERE v.status = 'completed') AS completed
            FROM visits v
           WHERE v.agent_id = u.id
             AND left(v.scheduled_start, 10) BETWEEN d_from AND d_to
             AND (p_client_id IS NULL OR v.client_id = p_client_id)
             AND (sid IS NULL OR v.site_id = sid)) t
       WHERE u.role IN ('agent','area_manager','team_leader')), '[]'::jsonb),

    'chemicals', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x->>'used')::numeric DESC)
        FROM (SELECT jsonb_build_object('name_en', ch.name_en, 'name_ar', ch.name_ar,
                       'unit', ch.unit, 'used', round(sum(cu.quantity)::numeric, 2)) AS x
                FROM chemical_usage cu
                JOIN chemicals ch ON ch.id = cu.chemical_id
                JOIN visits v ON v.id = cu.visit_id
               WHERE left(cu.created_at, 10) BETWEEN d_from AND d_to
                 AND (p_client_id IS NULL OR v.client_id = p_client_id)
                 AND (sid IS NULL OR v.site_id = sid)
               GROUP BY ch.id, ch.name_en, ch.name_ar, ch.unit
              HAVING sum(cu.quantity) > 0
               LIMIT 10) q), '[]'::jsonb),

    'services', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x->>'cnt')::int DESC)
        FROM (SELECT jsonb_build_object('name_en', s.name_en, 'name_ar', s.name_ar,
                       'cnt', count(v.id)) AS x
                FROM service_types s
                JOIN visits v ON v.service_type_id = s.id
                 AND left(v.scheduled_start, 10) BETWEEN d_from AND d_to
                 AND (p_client_id IS NULL OR v.client_id = p_client_id)
                 AND (sid IS NULL OR v.site_id = sid)
               GROUP BY s.id, s.name_en, s.name_ar
              HAVING count(v.id) > 0) q), '[]'::jsonb),

    -- what the reports said
    'reports', jsonb_build_object(
      'severity', COALESCE((SELECT jsonb_agg(jsonb_build_object('severity', r.severity, 'cnt', c))
                              FROM (SELECT r.severity, count(*) c FROM reports r
                                      JOIN visits v ON v.id = r.visit_id
                                     WHERE r.severity IS NOT NULL
                                       AND left(v.scheduled_start, 10) BETWEEN d_from AND d_to
                                       AND (p_client_id IS NULL OR v.client_id = p_client_id)
                                       AND (sid IS NULL OR v.site_id = sid)
                                     GROUP BY r.severity) r), '[]'::jsonb),
      'status', COALESCE((SELECT jsonb_agg(jsonb_build_object('status', r.status, 'cnt', c))
                            FROM (SELECT r.status, count(*) c FROM reports r
                                    JOIN visits v ON v.id = r.visit_id
                                   WHERE left(v.scheduled_start, 10) BETWEEN d_from AND d_to
                                     AND (p_client_id IS NULL OR v.client_id = p_client_id)
                                     AND (sid IS NULL OR v.site_id = sid)
                                   GROUP BY r.status) r), '[]'::jsonb),
      -- What the engineers actually wrote on the sheets. `condition` is the
      -- premises grade; the recommendation is free text, counted as written
      -- so the office can see which advice it keeps having to repeat.
      'conditions', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', c, 'count', n)
                                               ORDER BY n DESC)
          FROM (SELECT r.condition c, count(*) n FROM reports r
                  JOIN visits v ON v.id = r.visit_id
                 WHERE r.condition IS NOT NULL AND r.condition <> ''
                   AND left(v.scheduled_start, 10) BETWEEN d_from AND d_to
                   AND (p_client_id IS NULL OR v.client_id = p_client_id)
                   AND (sid IS NULL OR v.site_id = sid)
                 GROUP BY r.condition) q), '[]'::jsonb),
      'recommendations', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', rc, 'count', n)
                                                    ORDER BY n DESC)
          FROM (SELECT r.recommendations rc, count(*) n FROM reports r
                  JOIN visits v ON v.id = r.visit_id
                 WHERE r.recommendations IS NOT NULL AND r.recommendations <> ''
                   AND left(v.scheduled_start, 10) BETWEEN d_from AND d_to
                   AND (p_client_id IS NULL OR v.client_id = p_client_id)
                   AND (sid IS NULL OR v.site_id = sid)
                 GROUP BY r.recommendations
                 ORDER BY count(*) DESC LIMIT 8) q), '[]'::jsonb))
  );

  -- ---- totals + operational / collection KPIs ------------------------
  out := out || jsonb_build_object('totals', (
    SELECT jsonb_build_object(
      'revenue', rev, 'invoiced', inv,
      'visits_total', vt, 'visits_completed', vc, 'visits_cancelled', vx,
      'completion_rate', CASE WHEN vt > 0 THEN round(vc * 100.0 / vt) ELSE 0 END,
      'collection_rate', CASE WHEN inv > 0 THEN round(rev * 100.0 / inv) ELSE 0 END,
      'revenue_per_visit', CASE WHEN vc > 0 THEN round((rev / vc)::numeric, 2) ELSE 0 END,
      'new_clients', (SELECT count(*) FROM clients c
                       WHERE left(c.created_at, 10) BETWEEN d_from AND d_to
                         AND (p_client_id IS NULL OR c.id = p_client_id)),
      'active_contracts', (SELECT count(*) FROM contracts ct WHERE ct.status = 'active'
                            AND (p_client_id IS NULL OR ct.client_id = p_client_id)),
      'sla_overdue', (SELECT count(*) FROM sla_rows() r WHERE r.status = 'overdue'
                       AND (p_client_id IS NULL OR r.client_id = p_client_id)),
      'sla_due_soon', (SELECT count(*) FROM sla_rows() r WHERE r.status = 'due_soon'
                        AND (p_client_id IS NULL OR r.client_id = p_client_id)))
      FROM (
        SELECT
          (SELECT COALESCE(sum(p.amount), 0) FROM payments p JOIN invoices i ON i.id = p.invoice_id
            WHERE p.paid_at BETWEEN d_from AND d_to || ' 23:59:59'
              AND (p_client_id IS NULL OR i.client_id = p_client_id)
              AND (sid IS NULL OR i.site_id = sid)) AS rev,
          (SELECT COALESCE(sum(i.total), 0) FROM invoices i
            WHERE i.doc_type = 'invoice' AND i.issue_date BETWEEN d_from AND d_to
              AND (p_client_id IS NULL OR i.client_id = p_client_id)
              AND (sid IS NULL OR i.site_id = sid)) AS inv,
          (SELECT count(*) FROM visits v WHERE left(v.scheduled_start, 10) BETWEEN d_from AND d_to
              AND (p_client_id IS NULL OR v.client_id = p_client_id)
              AND (sid IS NULL OR v.site_id = sid)) AS vt,
          (SELECT count(*) FROM visits v WHERE v.status = 'completed'
              AND left(v.scheduled_start, 10) BETWEEN d_from AND d_to
              AND (p_client_id IS NULL OR v.client_id = p_client_id)
              AND (sid IS NULL OR v.site_id = sid)) AS vc,
          (SELECT count(*) FROM visits v WHERE v.status = 'cancelled'
              AND left(v.scheduled_start, 10) BETWEEN d_from AND d_to
              AND (p_client_id IS NULL OR v.client_id = p_client_id)
              AND (sid IS NULL OR v.site_id = sid)) AS vx
      ) k));

  -- ---- the fleet & pest rollup from the QR scans ---------------------
  out := out || jsonb_build_object('fleet', jsonb_build_object(
    -- fleetCards reads devices / coverage / needs_service / activity, and
    -- the whole fleet section is gated on `devices` being > 0. Naming this
    -- one `total` is what kept the entire block off the page.
    'kpi', jsonb_build_object(
      'devices', total_dev,
      'needs_service', (SELECT count(*) FROM devices d
                         WHERE d.active = 1 AND d.status = 'needs_service'
                           AND (p_client_id IS NULL OR d.client_id = p_client_id)
                           AND (sid IS NULL OR d.site_id = sid)),
      'activity', (SELECT count(*) FROM device_inspections di
                     JOIN devices d ON d.id = di.device_id
                    WHERE di.status = 'activity'
                      AND left(di.recorded_at, 10) BETWEEN d_from AND d_to
                      AND (p_client_id IS NULL OR di.client_id = p_client_id)
                      AND (sid IS NULL OR d.site_id = sid)),
      'scanned_month', (SELECT count(DISTINCT di.device_id) FROM device_inspections di
                          JOIN devices d ON d.id = di.device_id
                         WHERE left(di.recorded_at, 7) = ym
                           AND (p_client_id IS NULL OR di.client_id = p_client_id)
                           AND (sid IS NULL OR d.site_id = sid)),
      'coverage', CASE WHEN total_dev > 0 THEN round(100.0 *
                    (SELECT count(DISTINCT di.device_id) FROM device_inspections di
                       JOIN devices d ON d.id = di.device_id
                      WHERE left(di.recorded_at, 7) = ym
                        AND (p_client_id IS NULL OR di.client_id = p_client_id)
                        AND (sid IS NULL OR d.site_id = sid)) / total_dev) ELSE 0 END,
      'detections', (SELECT count(*) FROM device_inspections di
                       JOIN devices d ON d.id = di.device_id
                      WHERE di.status = 'activity'
                        AND left(di.recorded_at, 10) BETWEEN d_from AND d_to
                        AND (p_client_id IS NULL OR di.client_id = p_client_id)
                        AND (sid IS NULL OR d.site_id = sid))),

    'months', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('m', l.m,
               'inspections', COALESCE(s.inspections, 0),
               'detections',  COALESCE(s.detections, 0),
               'coverage', CASE WHEN total_dev > 0
                                THEN round(100.0 * COALESCE(s.scanned, 0) / total_dev) ELSE 0 END,
               'fly', s.fly, 'bait_pct', s.bait_pct) ORDER BY l.m)
        FROM month_labels(d_from, d_to) l
        LEFT JOIN (
          SELECT left(di.recorded_at, 7) m, count(*) inspections,
                 count(DISTINCT di.device_id) scanned,
                 count(*) FILTER (WHERE di.status = 'activity') detections,
                 round(avg(COALESCE((di.details::jsonb->>'fly_count')::numeric,
                                    (di.details::jsonb->>'fly_density')::numeric)), 1) fly,
                 round(avg((di.details::jsonb->>'consumption_pct')::numeric), 1) bait_pct
            FROM device_inspections di JOIN devices d ON d.id = di.device_id
           WHERE (p_client_id IS NULL OR di.client_id = p_client_id)
             AND (sid IS NULL OR d.site_id = sid)
           GROUP BY 1) s ON s.m = l.m), '[]'::jsonb),

    'top_clients', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x->>'detections')::int DESC)
        FROM (SELECT jsonb_build_object('name_en', c.name_en, 'name_ar', c.name_ar,
                       'detections', count(*)) AS x
                FROM device_inspections di
                JOIN clients c ON c.id = di.client_id
                JOIN devices d ON d.id = di.device_id
               WHERE di.status = 'activity'
                 AND left(di.recorded_at, 10) BETWEEN d_from AND d_to
                 AND (p_client_id IS NULL OR di.client_id = p_client_id)
                 AND (sid IS NULL OR d.site_id = sid)
               GROUP BY c.id, c.name_en, c.name_ar
               LIMIT 8) q), '[]'::jsonb),

    -- Counted per type first, THEN aggregated: count() inside jsonb_agg() is
    -- a nested aggregate and Postgres refuses it.
    'by_type', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('type', q.type, 'devices', q.devices,
                                          'scans', q.scans, 'detections', q.detections)
                       ORDER BY q.type)
        FROM (
          SELECT d.type,
                 count(DISTINCT d.id) AS devices,
                 count(di.id) AS scans,
                 count(*) FILTER (WHERE di.status = 'activity') AS detections
            FROM devices d
            LEFT JOIN device_inspections di ON di.device_id = d.id
                 AND left(di.recorded_at, 10) BETWEEN d_from AND d_to
           WHERE d.active = 1 AND d.client_id IS NOT NULL
             AND (p_client_id IS NULL OR d.client_id = p_client_id)
             AND (sid IS NULL OR d.site_id = sid)
           GROUP BY d.type) q), '[]'::jsonb),

    -- what was actually replaced or changed on the traps
    'replaced', (
      SELECT jsonb_build_object(
        'lamps',  count(*) FILTER (WHERE j->>'lamp_status' = 'replaced' OR j->>'lamp_action' = 'replaced'),
        'sheets', count(*) FILTER (WHERE j->>'sheet_status' = 'replaced' OR j->>'sheet_action' = 'changed'),
        'glue_boards', count(*) FILTER (WHERE j->>'glue_status' = 'changed' OR j->>'glue_action' = 'changed'),
        'baits',  count(*) FILTER (WHERE j->>'bait_status' = 'changed' OR j->>'bait_action' = 'changed'),
        'traps',  count(*) FILTER (WHERE j->>'trap_action' = 'replaced'),
        'transformers', count(*) FILTER (WHERE j->>'trans_light_action' = 'replaced'),
        'stations', count(*) FILTER (WHERE j->>'station_action' = 'changed'))
        FROM (SELECT di.details::jsonb j FROM device_inspections di
                JOIN devices d ON d.id = di.device_id
               WHERE left(di.recorded_at, 10) BETWEEN d_from AND d_to
                 AND (p_client_id IS NULL OR di.client_id = p_client_id)
                 AND (sid IS NULL OR d.site_id = sid)) z),

    -- What the scans FOUND. app.js does faults.map(x => x.count) and keys the
    -- label off x.key, so this is a LIST of {key, count} — an object of
    -- counts is what made the page die on "faults.map is not a function".
    -- Only faults that actually occurred are listed; a bar chart of zeros
    -- says nothing about which one to fix first.
    'faults', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('key', f.key, 'count', f.count)
                       ORDER BY f.count DESC)
        FROM (
          SELECT k AS key, count(*) AS count
            FROM (SELECT di.details::jsonb j FROM device_inspections di
                    JOIN devices d ON d.id = di.device_id
                   WHERE left(di.recorded_at, 10) BETWEEN d_from AND d_to
                     AND (p_client_id IS NULL OR di.client_id = p_client_id)
                     AND (sid IS NULL OR d.site_id = sid)) z,
                 LATERAL (VALUES
                   ('trap_damaged',       z.j->>'trap_condition'    = 'damaged'),
                   ('trap_missing',       z.j->>'trap_condition'    = 'missing'),
                   ('lamp_damaged',       z.j->>'lamp_status'       = 'damaged'),
                   ('lamp_missing',       z.j->>'lamp_status'       = 'missing'),
                   ('sheet_expired',      z.j->>'sheet_status'      = 'expired'),
                   ('sheet_full',         z.j->>'sheet_status'      = 'full'),
                   ('station_damaged',    z.j->>'station_condition' = 'damaged'),
                   ('power_disconnected', z.j->>'electricity'       = 'disconnected'),
                   ('glue_caught',        z.j->>'glue_status'       = 'caught'),
                   ('bait_activity',      z.j->>'bait_status'       = 'activity_eating')
                 ) AS f(k, hit)
           WHERE f.hit
           GROUP BY k) f), '[]'::jsonb),

    -- The catch, by species, comes off a follow-up sheet this demo does not
    -- fill in; an empty list hides the panel rather than inventing a count.
    'pests', '[]'::jsonb,
    'actions', jsonb_build_object('done', 0, 'deferred', 0),
    'deferred_list', '[]'::jsonb,

    -- `stale` is the LIST the overdue-devices table renders; the count and
    -- the threshold are separate keys beside it.
    'stale', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('code', q.code, 'type', q.type,
               'client_en', q.client_en, 'client_ar', q.client_ar,
               'loc', q.loc, 'site_name', q.site_name, 'last_seen', q.last_seen)
             ORDER BY q.last_seen NULLS FIRST)
        FROM (SELECT d.code, d.type, c.name_en client_en, c.name_ar client_ar,
                     d.label loc, s.name site_name,
                     (SELECT max(di.recorded_at) FROM device_inspections di
                       WHERE di.device_id = d.id) last_seen
                FROM devices d
                LEFT JOIN clients c ON c.id = d.client_id
                LEFT JOIN sites s ON s.id = d.site_id
               WHERE d.active = 1 AND d.client_id IS NOT NULL
                 AND (p_client_id IS NULL OR d.client_id = p_client_id)
                 AND (sid IS NULL OR d.site_id = sid)
                 AND COALESCE((SELECT max(di.recorded_at) FROM device_inspections di
                                WHERE di.device_id = d.id), '0')
                     < to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '30 days',
                               'YYYY-MM-DD HH24:MI:SS')
               LIMIT 50) q), '[]'::jsonb),
    'stale_count', (SELECT count(*) FROM devices d
                     WHERE d.active = 1 AND d.client_id IS NOT NULL
                       AND (p_client_id IS NULL OR d.client_id = p_client_id)
                       AND (sid IS NULL OR d.site_id = sid)
                       AND COALESCE((SELECT max(di.recorded_at) FROM device_inspections di
                                      WHERE di.device_id = d.id), '0')
                           < to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '30 days',
                                     'YYYY-MM-DD HH24:MI:SS')),
    'stale_days', 30
  ));

  -- app.js defaults these two if absent, but an empty shape is kinder than a
  -- missing key when a panel is half-drawn.
  out := out || jsonb_build_object(
    'application', jsonb_build_object('methods', '[]'::jsonb, 'equipment', '[]'::jsonb),
    'spend', jsonb_build_object('clients', '[]'::jsonb, 'visits', '[]'::jsonb,
               'months', '[]'::jsonb,
               'pocket', jsonb_build_object('engineers', '[]'::jsonb, 'categories', '[]'::jsonb)));

  RETURN out;
END
$fn$;
