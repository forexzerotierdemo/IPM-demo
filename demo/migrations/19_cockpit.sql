-- =====================================================================
-- The owner cockpit, matched column-for-column to what cockpitSection()
-- in app.js reads. §12's failure #4: "Response shapes drifting from the
-- Python handlers." The first cut of dashboard_summary() invented its own
-- names and the dashboard died on `c.sla.overdue`.
--
-- app.js needs exactly:
--   revenue_month, revenue_prev, overdue_invoices, overdue_amount,
--   sla: {ok, due_soon, overdue},
--   utilization: [{agent_id, name, total, completed, rate, rating}]
-- =====================================================================

-- Per active-contract SLA status, as _sla_rows() computes it. Tiered:
-- ok / due_soon (period end approaching) / overdue (past period end plus a
-- ~20% grace), against the last COMPLETED visit for that client (+ site if
-- the contract names one). A stopped customer or a shut branch owes nothing,
-- so neither generates a breach.
CREATE OR REPLACE FUNCTION sla_rows() RETURNS TABLE (
  contract_id bigint, client_id bigint, client_en text, client_ar text,
  site_id bigint, site_name text, frequency text, period_days int,
  last_service text, days_since int, days_overdue int, next_run_date text, status text
) LANGUAGE sql STABLE AS
$fn$
  WITH ct AS (
    SELECT c2.id, c2.client_id, c2.site_id, c2.frequency, c2.start_date, c2.next_run_date,
           cl.name_en, cl.name_ar, s.name AS site_name,
           COALESCE((ARRAY[7,14,30,91,182,365])[
             array_position(ARRAY['weekly','biweekly','monthly','quarterly','semiannual','annual'],
                            c2.frequency)], 30) AS period
      FROM contracts c2
      JOIN clients cl ON cl.id = c2.client_id
      LEFT JOIN sites s ON s.id = c2.site_id
     WHERE c2.status = 'active' AND cl.status = 'active'
       AND (s.id IS NULL OR s.status = 'active')
  ), l AS (
    SELECT ct.*, (
      SELECT max(left(COALESCE(v.completed_at, v.scheduled_start), 10))
        FROM visits v
       WHERE v.client_id = ct.client_id AND v.status = 'completed'
         AND (ct.site_id IS NULL OR v.site_id = ct.site_id)
    ) AS last_service
      FROM ct
  ), d AS (
    SELECT l.*,
           GREATEST(0, ((now() AT TIME ZONE 'Africa/Cairo')::date
                        - COALESCE(NULLIF(l.last_service,''), l.start_date)::date))::int AS days_since
      FROM l
     WHERE COALESCE(NULLIF(l.last_service,''), l.start_date) IS NOT NULL
  )
  SELECT d.id, d.client_id, d.name_en, d.name_ar, d.site_id, d.site_name, d.frequency,
         d.period::int, d.last_service, d.days_since,
         GREATEST(0, d.days_since - d.period)::int,
         d.next_run_date,
         CASE WHEN d.days_since <  d.period * 0.8 THEN 'ok'
              WHEN d.days_since <= d.period * 1.2 THEN 'due_soon'
              ELSE 'overdue' END
    FROM d
   ORDER BY d.days_since DESC
$fn$;

CREATE OR REPLACE FUNCTION owner_cockpit() RETURNS jsonb
  LANGUAGE sql STABLE AS
$fn$
SELECT jsonb_build_object(
  'revenue_month', (SELECT COALESCE(sum(amount), 0) FROM payments
                     WHERE left(paid_at, 7) = left(today_cairo(), 7)),
  'revenue_prev',  (SELECT COALESCE(sum(amount), 0) FROM payments
                     WHERE left(paid_at, 7) = to_char(
                             ((now() AT TIME ZONE 'Africa/Cairo')::date - interval '1 month'),
                             'YYYY-MM')),
  'overdue_invoices', (SELECT count(*) FROM invoices i
                        WHERE i.doc_type = 'invoice' AND i.status IN ('sent','overdue')
                          AND i.due_date IS NOT NULL AND i.due_date < today_cairo()),
  'overdue_amount', (SELECT COALESCE(sum(i.total - COALESCE(
                              (SELECT sum(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)), 0)
                       FROM invoices i
                      WHERE i.doc_type = 'invoice' AND i.status IN ('sent','overdue')
                        AND i.due_date IS NOT NULL AND i.due_date < today_cairo()),
  -- The three tiers always exist, even at zero: app.js reads c.sla.overdue
  -- and c.sla.due_soon straight off the object.
  'sla', jsonb_build_object('ok', 0, 'due_soon', 0, 'overdue', 0)
         || COALESCE((SELECT jsonb_object_agg(status, n)
                        FROM (SELECT status, count(*) n FROM sla_rows() GROUP BY status) x),
                     '{}'::jsonb),
  'utilization', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'agent_id', u.id, 'name', u.full_name,
             'total', t.total, 'completed', t.completed,
             'rate', CASE WHEN t.total > 0 THEN round(t.completed * 100.0 / t.total) ELSE 0 END,
             'rating', (SELECT round(avg(vr.stars)::numeric, 1) FROM visit_ratings vr
                          JOIN visits v2 ON v2.id = vr.visit_id WHERE v2.agent_id = u.id))
           ORDER BY t.total DESC, t.completed DESC)
      FROM users u
      CROSS JOIN LATERAL (
        SELECT count(v.id) AS total,
               count(*) FILTER (WHERE v.status = 'completed') AS completed
          FROM visits v
         WHERE v.agent_id = u.id AND left(v.scheduled_start, 7) = left(today_cairo(), 7)
      ) t
     WHERE u.role IN ('agent','area_manager','team_leader') AND u.active = 1), '[]'::jsonb)
)
$fn$;
