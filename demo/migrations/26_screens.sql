-- =====================================================================
-- Four more screens: the permission matrix's catalogue, the report drafts
-- queue, minting and assigning QR devices, and the client analytics /
-- statement pages.
-- =====================================================================

-- ---------------------------------------------- /permissions/catalog
-- The Python side keeps PERMISSION_CATALOG, ROLES and ROLE_DEFAULTS as
-- module constants and hands them straight to the matrix screen. Here the
-- same facts already exist as rows: `role_permissions` IS the defaults
-- matrix (Appendix A seeded it), so the catalogue is derived from it rather
-- than duplicated — one source of truth, and a permission added to the
-- matrix appears on the screen without a second edit.
--
-- A permission key is "module.action", which is where the grouping comes
-- from; the screen renders one block per module.
CREATE OR REPLACE FUNCTION permissions_catalog() RETURNS jsonb
  LANGUAGE sql STABLE AS
$fn$
  SELECT jsonb_build_object(
    'catalog', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('module', mod, 'actions', acts) ORDER BY mod)
        FROM (SELECT split_part(perm, '.', 1) AS mod,
                     jsonb_agg(DISTINCT split_part(perm, '.', 2)) AS acts
                FROM role_permissions GROUP BY 1) c), '[]'::jsonb),
    'roles', COALESCE((SELECT jsonb_agg(DISTINCT role ORDER BY role) FROM role_permissions),
                      '[]'::jsonb),
    -- The seeded matrix is the defaults. admin is a superuser and is shown
    -- as such rather than as a row of ticks that could be unticked.
    'defaults', COALESCE((
      SELECT jsonb_object_agg(role, perms)
        FROM (SELECT role, jsonb_object_agg(perm, allowed = 1) AS perms
                FROM role_permissions GROUP BY role) d), '{}'::jsonb),
    'roles_effective', COALESCE((
      SELECT jsonb_object_agg(role, perms)
        FROM (SELECT role, jsonb_object_agg(perm, allowed = 1) AS perms
                FROM role_permissions GROUP BY role) d), '{}'::jsonb),
    'role_overrides', '{}'::jsonb)
$fn$;


-- ------------------------------------------------- /reports/drafts
-- Unfinished paperwork the caller is responsible for. Who that is comes
-- from RLS: an engineer's own visits, a supervisor's patch or crew, the
-- office's everything — _draft_reports_for()'s three branches, for free.
CREATE OR REPLACE FUNCTION reports_drafts() RETURNS jsonb
  LANGUAGE sql STABLE AS
$fn$
  SELECT jsonb_build_object('items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'visit_id', r.visit_id, 'created_at', r.created_at,
             'agent_id', v.agent_id, 'agent_name', u.full_name,
             'name_en', c.name_en, 'name_ar', c.name_ar,
             'scheduled_start', v.scheduled_start) ORDER BY r.created_at DESC)
      FROM reports r
      JOIN visits v ON v.id = r.visit_id
      JOIN clients c ON c.id = v.client_id
      LEFT JOIN users u ON u.id = v.agent_id
     WHERE r.status = 'draft'), '[]'::jsonb))
$fn$;


-- ------------------------------------------------ /devices/generate
-- Mint the next N sequential codes for a device type (LIT0001, LIT0002 …).
-- Numbers continue from the highest existing code of that type and are
-- never reused — so a trap that is retired does not hand its number on.
CREATE OR REPLACE FUNCTION devices_generate(
  p_type text, p_count int,
  p_client_id bigint DEFAULT NULL, p_site_id bigint DEFAULT NULL,
  p_placement text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS
$fn$
DECLARE
  prefix text;
  start  int;
  codes  text[] := '{}';
  i      int;
BEGIN
  IF NOT app_has_perm('devices.create') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  prefix := CASE p_type
              WHEN 'light_trap'   THEN 'LIT'
              WHEN 'glue_station' THEN 'GLU'
              WHEN 'bait_station' THEN 'BAI'
              WHEN 'fly_trap'     THEN 'FLY' END;
  IF prefix IS NULL THEN
    RAISE EXCEPTION 'Invalid device type';
  END IF;
  IF p_count IS NULL OR p_count < 1 OR p_count > 500 THEN
    RAISE EXCEPTION 'Count must be between 1 and 500';
  END IF;

  SELECT COALESCE(max(NULLIF(regexp_replace(substr(d.code, length(prefix) + 1),
                                            '\D', '', 'g'), '')::int), 0) + 1
    INTO start
    FROM devices d WHERE d.type = p_type;

  FOR i IN start .. start + p_count - 1 LOOP
    INSERT INTO devices(code, type, client_id, site_id, placement, status, active)
    VALUES (prefix || lpad(i::text, 4, '0'), p_type, p_client_id, p_site_id,
            NULLIF(btrim(COALESCE(p_placement, '')), ''), 'ok', 1);
    codes := codes || (prefix || lpad(i::text, 4, '0'));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'type', p_type, 'codes', to_jsonb(codes));
END
$fn$;


-- -------------------------------------------------- /devices/assign
CREATE OR REPLACE FUNCTION devices_assign(
  p_ids bigint[], p_client_id bigint, p_site_id bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS
$fn$
DECLARE n int;
BEGIN
  IF NOT app_has_perm('devices.edit') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No devices selected';
  END IF;
  IF p_client_id IS NULL THEN
    RAISE EXCEPTION 'client_id required';
  END IF;

  UPDATE devices SET client_id = p_client_id, site_id = p_site_id
   WHERE id = ANY(p_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'count', n);
END
$fn$;


-- --------------------------------------- /clients/:id/analytics
-- Everything known about one client, shaped for the curve and 3D charts.
-- The supervisor boundary at the end is the same one /analytics draws: a
-- supervisor reads the WORK at a client they cover, never what it was
-- billed at or what is still owed.
CREATE OR REPLACE FUNCTION client_analytics(p_client_id bigint, p_site_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE AS
$fn$
DECLARE
  sid  bigint := CASE WHEN p_site_id ~ '^\d+$' THEN p_site_id::bigint END;
  from_m text := to_char((now() AT TIME ZONE 'Africa/Cairo')::date - interval '11 months', 'YYYY-MM-DD');
  to_m   text := today_cairo();
  out  jsonb;
  paid numeric;
  inv  numeric;
BEGIN
  IF app_role() <> 'client' AND NOT app_has_perm('analytics.view') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = p_client_id) THEN
    RAISE EXCEPTION 'Client not found';
  END IF;

  SELECT COALESCE(sum(i.total), 0) INTO inv FROM invoices i
   WHERE i.client_id = p_client_id AND i.doc_type = 'invoice'
     AND (sid IS NULL OR i.site_id = sid);
  SELECT COALESCE(sum(p.amount), 0) INTO paid FROM payments p
   JOIN invoices i ON i.id = p.invoice_id
   WHERE i.client_id = p_client_id AND (sid IS NULL OR i.site_id = sid);

  out := jsonb_build_object(
    'months', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('m', l.m,
               'invoiced', COALESCE(iv.v, 0), 'paid', COALESCE(pd.v, 0),
               'visits', COALESCE(vs.v, 0)) ORDER BY l.m)
        FROM month_labels(from_m, to_m) l
        LEFT JOIN (SELECT left(i.issue_date, 7) m, round(sum(i.total)::numeric, 2) v
                     FROM invoices i WHERE i.client_id = p_client_id AND i.doc_type = 'invoice'
                       AND (sid IS NULL OR i.site_id = sid) GROUP BY 1) iv ON iv.m = l.m
        LEFT JOIN (SELECT left(p.paid_at, 7) m, round(sum(p.amount)::numeric, 2) v
                     FROM payments p JOIN invoices i ON i.id = p.invoice_id
                    WHERE i.client_id = p_client_id
                      AND (sid IS NULL OR i.site_id = sid) GROUP BY 1) pd ON pd.m = l.m
        LEFT JOIN (SELECT left(v.scheduled_start, 7) m, count(*) v
                     FROM visits v WHERE v.client_id = p_client_id
                      AND (sid IS NULL OR v.site_id = sid) GROUP BY 1) vs ON vs.m = l.m),
      '[]'::jsonb),

    'status', COALESCE((SELECT jsonb_agg(jsonb_build_object('status', s, 'cnt', c))
                          FROM (SELECT v.status s, count(*) c FROM visits v
                                 WHERE v.client_id = p_client_id
                                   AND (sid IS NULL OR v.site_id = sid)
                                 GROUP BY v.status) q), '[]'::jsonb),

    'services', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'cnt')::int DESC)
        FROM (SELECT jsonb_build_object('name_en', s.name_en, 'name_ar', s.name_ar,
                       'cnt', count(v.id)) x
                FROM service_types s JOIN visits v ON v.service_type_id = s.id
               WHERE v.client_id = p_client_id AND (sid IS NULL OR v.site_id = sid)
               GROUP BY s.id, s.name_en, s.name_ar HAVING count(v.id) > 0) q), '[]'::jsonb),

    'severity', COALESCE((SELECT jsonb_agg(jsonb_build_object('severity', sv, 'cnt', c))
        FROM (SELECT r.severity sv, count(*) c FROM reports r JOIN visits v ON v.id = r.visit_id
               WHERE v.client_id = p_client_id AND r.severity IS NOT NULL
                 AND (sid IS NULL OR v.site_id = sid) GROUP BY r.severity) q), '[]'::jsonb),

    'chemicals', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'used')::numeric DESC)
        FROM (SELECT jsonb_build_object('name_en', ch.name_en, 'name_ar', ch.name_ar,
                       'unit', ch.unit, 'used', round(sum(cu.quantity)::numeric, 2)) x
                FROM chemical_usage cu JOIN chemicals ch ON ch.id = cu.chemical_id
                JOIN visits v ON v.id = cu.visit_id
               WHERE v.client_id = p_client_id AND (sid IS NULL OR v.site_id = sid)
               GROUP BY ch.id, ch.name_en, ch.name_ar, ch.unit LIMIT 8) q), '[]'::jsonb),

    'materials', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', k, 'total', tot))
        FROM (SELECT k, round(sum(val)::numeric, 2) tot
                FROM (SELECT r.* FROM reports r JOIN visits v ON v.id = r.visit_id
                       WHERE v.client_id = p_client_id
                         AND (sid IS NULL OR v.site_id = sid)) rr,
                     LATERAL (VALUES
                       ('lamps_used', rr.lamps_used), ('cables_used', rr.cables_used),
                       ('transformers_used', rr.transformers_used),
                       ('light_sheets_used', rr.light_sheets_used),
                       ('fipronil_ml', rr.fipronil_ml), ('imidacloprid_gm', rr.imidacloprid_gm),
                       ('baits_count', rr.baits_count), ('glo_pieces', rr.glo_pieces),
                       ('flybase_bags', rr.flybase_bags)) AS m(k, val)
               WHERE val IS NOT NULL GROUP BY k HAVING sum(val) > 0) q), '[]'::jsonb),

    'sites', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)
                                        ORDER BY s.name)
                         FROM sites s WHERE s.client_id = p_client_id), '[]'::jsonb),
    'site_id', COALESCE(p_site_id, ''),

    'totals', jsonb_build_object(
      'visits', (SELECT count(*) FROM visits v WHERE v.client_id = p_client_id
                   AND (sid IS NULL OR v.site_id = sid)),
      'completed', (SELECT count(*) FROM visits v WHERE v.client_id = p_client_id
                      AND v.status = 'completed' AND (sid IS NULL OR v.site_id = sid)),
      'invoiced', inv, 'paid', paid, 'outstanding', round(inv - paid, 2),
      'contracts', (SELECT count(*) FROM contracts ct
                     WHERE ct.client_id = p_client_id AND ct.status = 'active')));

  -- A supervisor reads the work, never the money.
  IF app_role() IN ('area_manager','team_leader') THEN
    out := jsonb_set(out, '{months}', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('m', e->>'m', 'visits', e->'visits'))
        FROM jsonb_array_elements(out->'months') e), '[]'::jsonb));
    out := jsonb_set(out, '{totals}',
      (out->'totals') - 'invoiced' - 'paid' - 'outstanding');
  END IF;

  RETURN out;
END
$fn$;


-- -------------------------------------- /clients/:id/statement
-- The account as the customer sees it: every invoice and every payment on
-- one running balance, oldest first.
CREATE OR REPLACE FUNCTION client_statement(p_client_id bigint, p_site_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE AS
$fn$
DECLARE
  sid bigint := CASE WHEN p_site_id ~ '^\d+$' THEN p_site_id::bigint END;
BEGIN
  IF NOT app_has_perm('invoices.view') AND app_role() <> 'client' THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  RETURN jsonb_build_object(
    'client', (SELECT jsonb_build_object('id', c.id, 'name_en', c.name_en, 'name_ar', c.name_ar)
                 FROM clients c WHERE c.id = p_client_id),
    -- The running balance is a window over the ordered lines, so it has to
    -- be computed BEFORE the rows are aggregated into JSON — a window inside
    -- jsonb_agg() is a nested aggregate and Postgres refuses it.
    'lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'date', b.d, 'kind', b.kind, 'ref', b.ref,
               'debit', b.debit, 'credit', b.credit, 'balance', b.balance)
             ORDER BY b.d, b.ord, b.ref)
        FROM (
          SELECT l.*,
                 round(sum(l.debit - l.credit)
                       OVER (ORDER BY l.d, l.ord, l.ref
                             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::numeric, 2) AS balance
            FROM (
              SELECT i.issue_date AS d, 0 AS ord, 'invoice' AS kind, i.number AS ref,
                     i.total AS debit, 0::double precision AS credit
                FROM invoices i
               WHERE i.client_id = p_client_id AND i.doc_type = 'invoice'
                 AND i.status <> 'cancelled' AND (sid IS NULL OR i.site_id = sid)
              UNION ALL
              SELECT left(p.paid_at, 10), 1, 'payment', i.number,
                     0::double precision, p.amount
                FROM payments p JOIN invoices i ON i.id = p.invoice_id
               WHERE i.client_id = p_client_id AND (sid IS NULL OR i.site_id = sid)
            ) l
        ) b), '[]'::jsonb),
    'totals', (
      SELECT jsonb_build_object('invoiced', COALESCE(sum(i.total), 0),
               'paid', COALESCE((SELECT sum(p.amount) FROM payments p
                                   JOIN invoices i2 ON i2.id = p.invoice_id
                                  WHERE i2.client_id = p_client_id
                                    AND (sid IS NULL OR i2.site_id = sid)), 0))
        FROM invoices i
       WHERE i.client_id = p_client_id AND i.doc_type = 'invoice'
         AND i.status <> 'cancelled' AND (sid IS NULL OR i.site_id = sid)));
END
$fn$;
