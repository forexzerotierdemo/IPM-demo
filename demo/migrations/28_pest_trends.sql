-- =====================================================================
-- GET /clients/:id/pest-trends — device-monitoring trends for one client,
-- built from the QR scans. The audit/HACCP page: monthly activity and
-- pressure, a breakdown by trap type, and the points where activity keeps
-- turning up.
--
-- app.js treats this one as optional (`.catch(() => null)`) and hides the
-- block when `totals.devices` is falsy, so an empty answer degrades to a
-- missing panel rather than a broken page.
-- =====================================================================
CREATE OR REPLACE FUNCTION client_pest_trends(p_client_id bigint, p_site_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE AS
$fn$
DECLARE
  sid    bigint := CASE WHEN p_site_id ~ '^\d+$' THEN p_site_id::bigint END;
  from_m text := to_char((now() AT TIME ZONE 'Africa/Cairo')::date - interval '11 months', 'YYYY-MM-DD');
  to_m   text := today_cairo();
BEGIN
  IF app_role() <> 'client' AND NOT app_has_perm('analytics.view') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  RETURN jsonb_build_object(
    'totals', (
      SELECT jsonb_build_object(
        'devices', count(DISTINCT d.id),
        'inspections', count(di.id),
        'detections', count(*) FILTER (WHERE di.status = 'activity'),
        'needs_service', count(DISTINCT d.id) FILTER (WHERE d.status = 'needs_service'))
        FROM devices d
        LEFT JOIN device_inspections di ON di.device_id = d.id
       WHERE d.client_id = p_client_id AND (sid IS NULL OR d.site_id = sid)),

    'months', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('m', l.m,
               'inspections', COALESCE(s.inspections, 0),
               'detections', COALESCE(s.detections, 0),
               'fly', s.fly, 'bait_pct', s.bait_pct) ORDER BY l.m)
        FROM month_labels(from_m, to_m) l
        LEFT JOIN (
          SELECT left(di.recorded_at, 7) m, count(*) inspections,
                 count(*) FILTER (WHERE di.status = 'activity') detections,
                 round(avg(COALESCE((di.details::jsonb->>'fly_count')::numeric,
                                    (di.details::jsonb->>'fly_density')::numeric)), 1) fly,
                 round(avg((di.details::jsonb->>'consumption_pct')::numeric), 1) bait_pct
            FROM device_inspections di JOIN devices d ON d.id = di.device_id
           WHERE d.client_id = p_client_id AND (sid IS NULL OR d.site_id = sid)
           GROUP BY 1) s ON s.m = l.m), '[]'::jsonb),

    'by_type', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('type', q.type, 'detections', q.detections)
                       ORDER BY q.detections DESC)
        FROM (SELECT d.type, count(*) FILTER (WHERE di.status = 'activity') detections
                FROM devices d
                LEFT JOIN device_inspections di ON di.device_id = d.id
               WHERE d.client_id = p_client_id AND (sid IS NULL OR d.site_id = sid)
               GROUP BY d.type) q), '[]'::jsonb),

    -- Where activity keeps turning up: the points worth re-siting.
    'hotspots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'label', q.code, 'type', q.type,
                                          'loc', q.loc, 'detections', q.detections,
                                          'status', q.status)
                       ORDER BY q.detections DESC)
        FROM (SELECT d.id, d.code, d.type, COALESCE(d.label, s.name) loc, d.status,
                     count(*) FILTER (WHERE di.status = 'activity') detections
                FROM devices d
                LEFT JOIN sites s ON s.id = d.site_id
                LEFT JOIN device_inspections di ON di.device_id = d.id
               WHERE d.client_id = p_client_id AND (sid IS NULL OR d.site_id = sid)
               GROUP BY d.id, d.code, d.type, d.label, s.name, d.status
              HAVING count(*) FILTER (WHERE di.status = 'activity') > 0
               LIMIT 10) q), '[]'::jsonb),

    'kpis', (
      SELECT jsonb_build_object(
        'catch_rate', CASE WHEN count(di.id) > 0
                      THEN round(100.0 * count(*) FILTER (WHERE di.status = 'activity') / count(di.id))
                      ELSE 0 END,
        'fly_avg', round(avg(COALESCE((di.details::jsonb->>'fly_count')::numeric,
                                      (di.details::jsonb->>'fly_density')::numeric)), 1),
        'replaced', count(*) FILTER (
          WHERE di.details::jsonb->>'lamp_action' = 'replaced'
             OR di.details::jsonb->>'sheet_action' = 'changed'
             OR di.details::jsonb->>'glue_action' = 'changed'
             OR di.details::jsonb->>'bait_action' = 'changed'))
        FROM device_inspections di JOIN devices d ON d.id = di.device_id
       WHERE d.client_id = p_client_id AND (sid IS NULL OR d.site_id = sid)));
END
$fn$;
