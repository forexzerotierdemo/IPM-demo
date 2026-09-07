-- =====================================================================
-- Corrections to §6, found by running §6.6 against real JWTs.
--
-- 1. §6.3's sites_sel reads `visits` and visits_sel reads `sites`, so each
--    policy evaluates the other's policy and Postgres raises 42P17,
--    "infinite recursion detected in policy". §6.4 warns about this trap
--    for `users` only; the same trap is live between these two tables.
--    The cure is the one §6.4 uses: do the cross-table lookup inside a
--    SECURITY DEFINER function, which is not itself subject to RLS.
--
-- 2. §6.2 gates the money tables on the permission alone, and the `client`
--    role holds invoices.view, contracts.view and requests.view. A portal
--    login therefore reads EVERY customer's invoices. That is precisely the
--    failure §10.1 warns about. Restrictive policies add the row scope
--    without touching the generated policies from §6.2.
--
-- 3. server.py lets a client account read its own company, branches and
--    devices WITHOUT clients.view/devices.view (`if role != "client":
--    require_perm(...)`). The policies demanded the permission, so the
--    portal saw nothing at all.
-- =====================================================================

-- ---- 1. helpers that break the recursion ----------------------------
-- A branch's area, read without RLS so a policy on `visits` may ask for it.
CREATE OR REPLACE FUNCTION app_site_area_id(p_site_id bigint) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT area_id FROM sites WHERE id = p_site_id $$;

-- The branches the caller's work actually touches: their own visits, or
-- their team's if they lead one. Read without RLS, so a policy on `sites`
-- may ask for it.
CREATE OR REPLACE FUNCTION app_visited_site_ids() RETURNS SETOF bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT DISTINCT v.site_id FROM visits v
    WHERE v.site_id IS NOT NULL
      AND v.agent_id IN (
        SELECT app_uid()
        UNION
        SELECT id FROM users
         WHERE team_leader_id = app_uid() AND app_role() = 'team_leader') $$;

-- Which company an invoice belongs to, for the restrictive scopes below.
CREATE OR REPLACE FUNCTION app_invoice_client_id(p_invoice_id bigint) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT client_id FROM invoices WHERE id = p_invoice_id $$;

CREATE OR REPLACE FUNCTION app_visit_client_id(p_visit_id bigint) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT client_id FROM visits WHERE id = p_visit_id $$;

CREATE OR REPLACE FUNCTION app_contract_client_id(p_contract_id bigint) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT client_id FROM contracts WHERE id = p_contract_id $$;

-- ---- 2. sites and visits, without the mutual reference ---------------
DROP POLICY IF EXISTS sites_sel ON sites;
CREATE POLICY sites_sel ON sites FOR SELECT TO authenticated USING (
  -- A portal login needs no clients.view, exactly as list_all_sites has it.
  (app_role() = 'client' AND client_id = app_client_id()
     AND (app_site_id() IS NULL OR id = app_site_id()))
  OR (app_has_perm('clients.view') AND (
        app_role() IN ('admin','manager')
        -- An area manager's Locations page is their patch's branches, plus
        -- anywhere they are personally sent.
        OR (app_role() = 'area_manager' AND (area_id IN (SELECT app_area_ids())
                                             OR id IN (SELECT app_visited_site_ids())))
        OR (app_role() = 'team_leader' AND id IN (SELECT app_visited_site_ids()))
        OR (app_role() = 'agent' AND (preferred_agent_id = app_uid()
                                      OR id IN (SELECT app_visited_site_ids())))
  )));

DROP POLICY IF EXISTS visits_sel ON visits;
CREATE POLICY visits_sel ON visits FOR SELECT TO authenticated USING (
  app_has_perm('visits.view') AND (
    app_role() IN ('admin','manager')
    OR (app_role() = 'area_manager' AND app_site_area_id(site_id) IN (SELECT app_area_ids()))
    OR (app_role() = 'team_leader' AND agent_id IN (SELECT app_team_ids()))
    OR (app_role() = 'agent' AND agent_id = app_uid())
    -- visits carries client_id itself, so the portal scope needs no join.
    OR (app_role() = 'client' AND client_id = app_client_id()
          AND (app_site_id() IS NULL OR site_id IS NULL OR site_id = app_site_id()))
  ));

DROP POLICY IF EXISTS visits_upd ON visits;
CREATE POLICY visits_upd ON visits FOR UPDATE TO authenticated
  USING (app_has_perm('visits.edit') AND (
        app_role() IN ('admin','manager')
     OR (app_role() = 'agent' AND agent_id = app_uid())
     OR (app_role() = 'team_leader'  AND agent_id IN (SELECT app_team_ids()))
     OR (app_role() = 'area_manager' AND app_site_area_id(site_id) IN (SELECT app_area_ids()))))
  WITH CHECK (app_has_perm('visits.edit'));

-- ---- 3. the portal reads its own company and its own traps -----------
DROP POLICY IF EXISTS clients_sel ON clients;
CREATE POLICY clients_sel ON clients FOR SELECT TO authenticated USING (
  (app_role() = 'client' AND id = app_client_id())
  OR (app_has_perm('clients.view')
      AND app_role() IN ('admin','manager','agent','area_manager','team_leader'))
);

CREATE POLICY devices_client_sel ON devices FOR SELECT TO authenticated
  USING (app_role() = 'client' AND client_id = app_client_id());

-- ---- 4. restrictive row scopes for the portal ------------------------
-- A restrictive policy ANDs with the permissive ones, so these narrow §6.2's
-- permission gate without replacing it. Every one is a no-op for staff.
CREATE POLICY invoices_client_scope ON invoices AS RESTRICTIVE FOR ALL TO authenticated
  USING (app_role() <> 'client' OR client_id = app_client_id());

CREATE POLICY invoice_items_client_scope ON invoice_items AS RESTRICTIVE FOR ALL TO authenticated
  USING (app_role() <> 'client' OR app_invoice_client_id(invoice_id) = app_client_id());

CREATE POLICY payments_client_scope ON payments AS RESTRICTIVE FOR ALL TO authenticated
  USING (app_role() <> 'client' OR app_invoice_client_id(invoice_id) = app_client_id());

CREATE POLICY payment_intents_client_scope ON payment_intents AS RESTRICTIVE FOR ALL TO authenticated
  USING (app_role() <> 'client' OR app_invoice_client_id(invoice_id) = app_client_id());

CREATE POLICY contracts_client_scope ON contracts AS RESTRICTIVE FOR ALL TO authenticated
  USING (app_role() <> 'client' OR client_id = app_client_id());

CREATE POLICY contract_sites_client_scope ON contract_sites AS RESTRICTIVE FOR ALL TO authenticated
  USING (app_role() <> 'client' OR app_contract_client_id(contract_id) = app_client_id());

CREATE POLICY visit_requests_client_scope ON visit_requests AS RESTRICTIVE FOR ALL TO authenticated
  USING (app_role() <> 'client' OR client_id = app_client_id());

CREATE POLICY visit_ratings_client_scope ON visit_ratings AS RESTRICTIVE FOR ALL TO authenticated
  USING (app_role() <> 'client' OR app_visit_client_id(visit_id) = app_client_id());

CREATE POLICY devices_client_scope ON devices AS RESTRICTIVE FOR ALL TO authenticated
  USING (app_role() <> 'client' OR client_id = app_client_id());

-- GPS check-in data is staff-only (list_visits strips CHECKIN_COLS for a
-- client account). The view is the only thing the portal reads, so the
-- projection is where that belongs.
CREATE OR REPLACE VIEW v_visits WITH (security_invoker = true) AS
SELECT v.id, v.client_id, v.site_id, v.agent_id, v.service_type_id,
       v.scheduled_start, v.scheduled_end, v.status, v.location, v.notes,
       v.created_at, v.completed_at, v.contract_id,
       CASE WHEN app_role() = 'client' THEN NULL ELSE v.checkin_at   END AS checkin_at,
       CASE WHEN app_role() = 'client' THEN NULL ELSE v.checkin_lat  END AS checkin_lat,
       CASE WHEN app_role() = 'client' THEN NULL ELSE v.checkin_lng  END AS checkin_lng,
       CASE WHEN app_role() = 'client' THEN NULL ELSE v.checkin_acc  END AS checkin_acc,
       CASE WHEN app_role() = 'client' THEN NULL ELSE v.checkout_at  END AS checkout_at,
       CASE WHEN app_role() = 'client' THEN NULL ELSE v.checkout_lat END AS checkout_lat,
       CASE WHEN app_role() = 'client' THEN NULL ELSE v.checkout_lng END AS checkout_lng,
       CASE WHEN app_role() = 'client' THEN NULL ELSE v.checkout_acc END AS checkout_acc,
       c.name_en AS client_en, c.name_ar AS client_ar,
       sv.name_en AS service_en, sv.name_ar AS service_ar,
       u.full_name AS agent_name,
       st.name AS site_name, st.lat AS site_lat, st.lng AS site_lng,
       st.map_image AS site_map_image,
       COALESCE(st.area_id, c.area_id)     AS area_id,
       COALESCE(va.name_en, ca.name_en)    AS area_en,
       COALESCE(va.name_ar, ca.name_ar)    AS area_ar,
       CASE WHEN v.scheduled_start IS NULL OR v.status = 'cancelled' THEN NULL ELSE (
         SELECT count(*) FROM visits x
          WHERE x.client_id = v.client_id
            AND COALESCE(x.site_id, -1) = COALESCE(v.site_id, -1)
            AND x.status <> 'cancelled' AND x.scheduled_start IS NOT NULL
            AND left(x.scheduled_start, 7) = left(v.scheduled_start, 7)
            AND (x.scheduled_start < v.scheduled_start
                 OR (x.scheduled_start = v.scheduled_start AND x.id <= v.id))
       ) END AS visit_number,
       EXISTS (SELECT 1 FROM reports r
                WHERE r.visit_id = v.id AND r.status = 'complete') AS has_report
FROM visits v
JOIN clients c ON c.id = v.client_id
LEFT JOIN service_types sv ON sv.id = v.service_type_id
LEFT JOIN sites st ON st.id = v.site_id
LEFT JOIN users u ON u.id = v.agent_id
LEFT JOIN areas va ON va.id = st.area_id
LEFT JOIN areas ca ON ca.id = c.area_id;
