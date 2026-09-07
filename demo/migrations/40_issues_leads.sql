-- =====================================================================
-- TWO SCREENS THAT STILL DIED, AND WHY.
--
-- Found by opening them rather than by reading the route list — both are
-- shape problems, which is §12's failure #4 and the one the route
-- inventory cannot catch:
--
--   * Engineer Issue fetched /issues AND /issues/balance in one
--     Promise.all. The list worked; the balance 501'd, so the whole
--     screen died on a route that was not obviously part of it.
--
--   * Leads reads `d.items` and `d.counts` — an ENVELOPE, not the bare
--     array the generic resource table returns. It rendered "All 0 New 0"
--     over three real leads, which reads as an empty pipeline rather than
--     as a bug.
-- =====================================================================

-- ---- what each engineer is still carrying ----------------------------
-- ISSUED minus what was USED on their own visits minus what they HANDED
-- BACK. Derived live, so it drops as visits log usage and as returns are
-- signed for — never stored, so it cannot drift.
CREATE OR REPLACE FUNCTION issues_balance(p_agent_id bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE AS
$fn$
DECLARE want bigint;
BEGIN
  IF NOT app_has_perm('issues.view') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  -- An engineer sees only their own; the office may narrow with ?agent_id=.
  want := CASE WHEN app_role() = 'agent' THEN app_uid() ELSE p_agent_id END;

  RETURN jsonb_build_object('engineers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'agent_id', e.agent_id, 'agent_name', e.agent_name,
             'materials', e.materials) ORDER BY lower(e.agent_name))
      FROM (
        SELECT u.id AS agent_id, u.full_name AS agent_name,
               COALESCE(jsonb_agg(jsonb_build_object(
                 'chemical_id', m.chemical_id, 'name_en', m.name_en,
                 'name_ar', m.name_ar, 'unit', m.unit,
                 'issued', m.issued, 'used', m.used, 'returned', m.returned,
                 'remaining', round((m.issued - m.used - m.returned)::numeric, 3))
                 ORDER BY lower(m.name_en)) FILTER (WHERE m.chemical_id IS NOT NULL),
                 '[]'::jsonb) AS materials
          FROM users u
          LEFT JOIN LATERAL (
            SELECT ch.id AS chemical_id, ch.name_en, ch.name_ar, ch.unit,
                   round(COALESCE(iss.q, 0)::numeric, 3) AS issued,
                   round(COALESCE(usd.q, 0)::numeric, 3) AS used,
                   round(COALESCE(ret.q, 0)::numeric, 3) AS returned
              FROM chemicals ch
              LEFT JOIN LATERAL (
                SELECT sum(COALESCE(ii.approved_quantity, ii.quantity)) q
                  FROM engineer_issue_items ii
                  JOIN engineer_issues ei ON ei.id = ii.issue_id
                 WHERE ei.agent_id = u.id AND ei.status = 'approved'
                   AND ii.chemical_id = ch.id) iss ON true
              LEFT JOIN LATERAL (
                SELECT sum(cu.quantity) q FROM chemical_usage cu
                  JOIN visits v ON v.id = cu.visit_id
                 WHERE v.agent_id = u.id AND cu.chemical_id = ch.id) usd ON true
              LEFT JOIN LATERAL (
                SELECT sum(COALESCE(ri.approved_quantity, ri.quantity)) q
                  FROM material_return_items ri
                  JOIN material_returns mr ON mr.id = ri.return_id
                 WHERE mr.agent_id = u.id AND mr.status = 'approved'
                   AND ri.chemical_id = ch.id) ret ON true
             -- only the products this engineer has actually touched
             WHERE COALESCE(iss.q, 0) + COALESCE(usd.q, 0) + COALESCE(ret.q, 0) > 0
          ) m ON true
         WHERE u.role IN ('agent','area_manager','team_leader') AND u.active = 1
           AND (want IS NULL OR u.id = want)
         GROUP BY u.id, u.full_name
      ) e), '[]'::jsonb));
END
$fn$;


-- ---- the pipeline, with its counts -----------------------------------
-- app.js reads d.items and d.counts. The counts are of ALL leads, not of
-- the filtered page — they are the chips you filter BY, so filtering must
-- not change them.
CREATE OR REPLACE FUNCTION list_leads(p_status text DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql STABLE AS
$fn$
BEGIN
  IF NOT app_has_perm('leads.view') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  RETURN jsonb_build_object(
    'items', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC)
        FROM (SELECT l.*, c.name_en AS client_en, c.name_ar AS client_ar,
                     u.full_name AS handled_by_name
                FROM leads l
                LEFT JOIN clients c ON c.id = l.client_id
                LEFT JOIN users u ON u.id = l.handled_by
               WHERE p_status IS NULL OR p_status = '' OR l.status = p_status) x),
      '[]'::jsonb),
    'counts', COALESCE((
      SELECT jsonb_object_agg(status, n)
        FROM (SELECT status, count(*) n FROM leads GROUP BY status) q), '{}'::jsonb));
END
$fn$;

-- Converting a lead is how it leaves the pipeline: it becomes a customer.
CREATE OR REPLACE FUNCTION convert_lead(p_id bigint) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE l record; cid bigint;
BEGIN
  IF NOT app_has_perm('leads.edit') OR NOT app_has_perm('clients.create') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  SELECT * INTO l FROM leads WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead not found'; END IF;
  IF l.client_id IS NOT NULL THEN RAISE EXCEPTION 'Already converted'; END IF;

  INSERT INTO clients(name_en, name_ar, contact_person, phone, email, status)
  VALUES (COALESCE(NULLIF(btrim(COALESCE(l.company,'')), ''), l.name),
          NULL, l.name, l.phone, l.email, 'active')
  RETURNING id INTO cid;

  UPDATE leads SET status = 'won', client_id = cid, handled_by = app_uid()
   WHERE id = p_id;
  PERFORM app_audit('lead.convert', 'client', cid, l.name);
  RETURN jsonb_build_object('ok', true, 'client_id', cid);
END
$fn$;
