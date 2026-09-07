-- =====================================================================
-- GET /api/dashboard, as an RPC rather than an Edge Function.
--
-- §9.1's own advice: "Many of the 'Easy' ones should not be Edge Functions
-- at all — write them as Postgres views or RPCs and let the shim's table hit
-- them directly." The dashboard is the landing page, so it is the one that
-- has to be right first.
--
-- This is SECURITY INVOKER (the default) on purpose: every count below runs
-- under the caller's own §6 policies, so an engineer's "visits today" is
-- their round, an area manager's is their patch, and a portal login's is its
-- own company — without a single role branch in the counting SQL.
-- =====================================================================
CREATE OR REPLACE FUNCTION dashboard_summary() RETURNS jsonb
  LANGUAGE plpgsql STABLE AS
$fn$
DECLARE
  r     text := app_role();
  today text := today_cairo();
  ym    text := left(today_cairo(), 7);
  out   jsonb;
BEGIN
  IF r IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  -- ---- the customer portal ------------------------------------------
  IF r = 'client' THEN
    RETURN jsonb_build_object(
      'role', 'client',
      'upcoming_visits', (SELECT count(*) FROM visits
                           WHERE status IN ('scheduled','in_progress')),
      'completed_visits', (SELECT count(*) FROM visits WHERE status = 'completed'),
      'outstanding', (SELECT COALESCE(sum(i.total), 0)
                        - COALESCE((SELECT sum(p.amount) FROM payments p), 0)
                        FROM invoices i WHERE i.status IN ('sent','overdue','paid')),
      'open_invoices', (SELECT count(*) FROM invoices WHERE status IN ('sent','overdue'))
    );
  END IF;

  -- ---- the field engineer's own workload, and nothing else -----------
  -- Deliberately excludes every company-wide figure and all finance: an
  -- agent has no business seeing outstanding balances or revenue.
  out := jsonb_build_object(
    'role', r,
    'visits_today',     (SELECT count(*) FROM visits WHERE left(scheduled_start,10) = today),
    'my_visits',        (SELECT count(*) FROM visits WHERE status IN ('scheduled','in_progress')),
    'in_progress',      (SELECT count(*) FROM visits WHERE status = 'in_progress'),
    'completed_month',  (SELECT count(*) FROM visits WHERE status = 'completed'
                          AND left(COALESCE(completed_at, scheduled_start), 7) = ym),
    'reports_due',      (SELECT count(*) FROM visits v WHERE v.status = 'completed'
                          AND NOT EXISTS (SELECT 1 FROM reports rp
                                           WHERE rp.visit_id = v.id AND rp.status = 'complete'))
  );

  IF r = 'agent' THEN
    RETURN out;
  END IF;

  -- ---- a supervisor: their own work, then what they answer for -------
  -- The oversight half is whatever RLS says this role covers — an area
  -- manager's patch, a team leader's crew — so one branch serves both and
  -- neither can quietly widen.
  IF r IN ('area_manager','team_leader') THEN
    RETURN out || jsonb_build_object(
      'areas', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                  'id', a.id, 'name_en', a.name_en, 'name_ar', a.name_ar)
                                ORDER BY a.sort_order, a.id)
                           FROM areas a WHERE a.id IN (SELECT app_area_ids())), '[]'::jsonb),
      'team_today', (SELECT count(*) FROM users
                      WHERE team_leader_id = app_uid() AND active = 1),
      'sup_visits_today', (SELECT count(*) FROM visits WHERE left(scheduled_start,10) = today),
      'sup_open', (SELECT count(*) FROM visits WHERE status IN ('scheduled','in_progress')),
      'sup_reports_due', (SELECT count(*) FROM visits v WHERE v.status = 'completed'
                           AND NOT EXISTS (SELECT 1 FROM reports rp
                                            WHERE rp.visit_id = v.id AND rp.status = 'complete')),
      'sup_devices_stale', (SELECT count(*) FROM devices d
                             WHERE d.active = 1 AND d.client_id IS NOT NULL
                               AND COALESCE((SELECT max(di.recorded_at) FROM device_inspections di
                                              WHERE di.device_id = d.id), '0')
                                   < to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '30 days',
                                             'YYYY-MM-DD HH24:MI:SS'))
    );
  END IF;

  -- ---- the office -----------------------------------------------------
  out := jsonb_build_object(
    'role', 'staff',
    'clients',      (SELECT count(*) FROM clients),
    'agents',       (SELECT count(*) FROM users
                      WHERE role IN ('agent','area_manager','team_leader') AND active = 1),
    'visits_today', (SELECT count(*) FROM visits WHERE left(scheduled_start,10) = today),
    'scheduled',    (SELECT count(*) FROM visits WHERE status IN ('scheduled','in_progress')),
    'low_stock',    (SELECT count(*) FROM chemicals WHERE quantity_in_stock <= reorder_level),
    -- products already expired or expiring within 60 days
    'expiring',     (SELECT count(*) FROM chemicals
                      WHERE COALESCE(expiry_date,'') <> ''
                        AND expiry_date <= to_char((now() AT TIME ZONE 'Africa/Cairo')::date + 60,
                                                   'YYYY-MM-DD')),
    'outstanding',  (SELECT COALESCE(sum(i.total), 0)
                       - COALESCE((SELECT sum(p.amount) FROM payments p), 0)
                       FROM invoices i WHERE i.status IN ('sent','overdue','paid'))
  );

  -- QR fleet health.
  out := out || jsonb_build_object('devices', (
    SELECT jsonb_build_object(
      'total', t.total,
      'needs_service', (SELECT count(*) FROM devices WHERE active = 1 AND status = 'needs_service'),
      'activity_month', (SELECT count(*) FROM device_inspections
                          WHERE status = 'activity' AND left(recorded_at, 7) = ym),
      'coverage', CASE WHEN t.total > 0 THEN round(100.0 * t.scanned / t.total) END,
      'stale', (SELECT count(*) FROM devices d
                 WHERE d.active = 1 AND d.client_id IS NOT NULL
                   AND COALESCE((SELECT max(di.recorded_at) FROM device_inspections di
                                  WHERE di.device_id = d.id), '0')
                       < to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '30 days',
                                 'YYYY-MM-DD HH24:MI:SS')),
      'stale_days', 30)
    FROM (SELECT (SELECT count(*) FROM devices WHERE active = 1 AND client_id IS NOT NULL) AS total,
                 (SELECT count(DISTINCT device_id) FROM device_inspections
                   WHERE left(recorded_at, 7) = ym) AS scanned) t
  ));

  -- The owner cockpit is a finance view, so it is gated on the permission
  -- rather than on the role — exactly as has_perm(u,'analytics.view') was.
  -- Its shape is fixed by cockpitSection() in app.js; see 19_cockpit.sql.
  IF app_has_perm('analytics.view') THEN
    out := out || jsonb_build_object('cockpit', owner_cockpit());
  END IF;

  RETURN out;
END
$fn$;
