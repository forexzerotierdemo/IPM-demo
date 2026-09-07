DO $$
DECLARE
  m text[][] := ARRAY[
    -- table                    module
    ['chemicals',               'chemicals'],
    ['chemical_usage',          'chemicals'],
    ['inventory_transactions',  'chemicals'],
    ['engineer_issues',         'issues'],
    ['engineer_issue_items',    'issues'],
    ['material_returns',        'issues'],
    ['material_return_items',   'issues'],
    ['invoices',                'invoices'],
    ['invoice_items',           'invoices'],
    ['payments',                'payments'],
    ['payment_intents',         'payments'],
    ['contracts',               'contracts'],
    ['contract_sites',          'contracts'],
    ['price_book',              'invoices'],
    ['leads',                   'leads'],
    ['marketing_targets',       'targets'],
    ['expenses',                'finance'],
    ['cost_recurring',          'finance'],
    ['cost_budgets',            'finance'],
    ['petty_cash',              'cash'],
    ['vat_returns',             'finance'],
    ['purchase_orders',         'finance'],
    ['purchase_order_items',    'finance'],
    ['devices',                 'devices'],
    ['device_inspections',      'devices'],
    ['maps',                    'maps'],
    ['map_markers',             'maps'],
    ['marker_events',           'maps'],
    ['company_files',           'ipm'],
    ['zones',                   'shifts'],
    ['areas',                   'shifts'],
    ['agent_areas',             'shifts'],
    ['agent_availability',      'shifts'],
    ['agent_shifts',            'shifts'],
    ['shift_types',             'shifts'],
    ['area_manager_areas',      'shifts'],
    ['fixed_assignments',       'shifts'],
    ['site_service_days',       'visits'],
    ['service_types',           'visits'],
    ['visit_requests',          'requests'],
    ['visit_ratings',           'visits'],
    ['transport_entries',       'transport'],
    ['report_options',          'visits'],
    ['roster_runs',             'dispatch'],
    ['roster_run_items',        'dispatch'],
    ['roster_run_unplaced',     'dispatch']
  ];
  i int;
  tbl text; mod text;
BEGIN
  FOR i IN 1 .. array_length(m, 1) LOOP
    tbl := m[i][1]; mod := m[i][2];

    EXECUTE format($f$
      CREATE POLICY %1$I_sel ON public.%1$I FOR SELECT TO authenticated
        USING (app_has_perm('%2$s.view'))$f$, tbl, mod);

    -- 'transport', 'certificates', 'dashboard' and 'analytics' are view-only
    -- modules with no create/edit/delete actions in the catalog; skip writes.
    IF mod NOT IN ('transport', 'analytics', 'certificates', 'dashboard') THEN
      EXECUTE format($f$
        CREATE POLICY %1$I_ins ON public.%1$I FOR INSERT TO authenticated
          WITH CHECK (app_has_perm('%2$s.create'))$f$, tbl, mod);
      EXECUTE format($f$
        CREATE POLICY %1$I_upd ON public.%1$I FOR UPDATE TO authenticated
          USING (app_has_perm('%2$s.edit')) WITH CHECK (app_has_perm('%2$s.edit'))$f$, tbl, mod);
      EXECUTE format($f$
        CREATE POLICY %1$I_del ON public.%1$I FOR DELETE TO authenticated
          USING (app_has_perm('%2$s.delete'))$f$, tbl, mod);
    END IF;
  END LOOP;
END $$;
-- ---------------------------------------------------------------- sites
CREATE POLICY sites_sel ON sites FOR SELECT TO authenticated USING (
  app_has_perm('clients.view') AND (
    app_role() IN ('admin','manager')
    OR (app_role() = 'area_manager' AND area_id IN (SELECT app_area_ids()))
    OR (app_role() = 'team_leader'  AND EXISTS (
          SELECT 1 FROM visits v WHERE v.site_id = sites.id
             AND v.agent_id IN (SELECT app_team_ids())))
    OR (app_role() = 'agent' AND (
          preferred_agent_id = app_uid()
          OR EXISTS (SELECT 1 FROM visits v
                      WHERE v.site_id = sites.id AND v.agent_id = app_uid())))
    OR (app_role() = 'client' AND client_id = app_client_id()
          AND (app_site_id() IS NULL OR id = app_site_id()))
  ));

CREATE POLICY sites_ins ON sites FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('clients.create'));
CREATE POLICY sites_upd ON sites FOR UPDATE TO authenticated
  USING (app_has_perm('clients.edit')) WITH CHECK (app_has_perm('clients.edit'));
CREATE POLICY sites_del ON sites FOR DELETE TO authenticated
  USING (app_has_perm('clients.delete'));

-- ---------------------------------------------------------------- clients
CREATE POLICY clients_sel ON clients FOR SELECT TO authenticated USING (
  app_has_perm('clients.view') AND (
    app_role() IN ('admin','manager','agent','area_manager','team_leader')
    OR (app_role() = 'client' AND id = app_client_id())
  ));
CREATE POLICY clients_ins ON clients FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('clients.create'));
CREATE POLICY clients_upd ON clients FOR UPDATE TO authenticated
  USING (app_has_perm('clients.edit')) WITH CHECK (app_has_perm('clients.edit'));
CREATE POLICY clients_del ON clients FOR DELETE TO authenticated
  USING (app_has_perm('clients.delete'));

-- ---------------------------------------------------------------- visits
CREATE POLICY visits_sel ON visits FOR SELECT TO authenticated USING (
  app_has_perm('visits.view') AND (
    app_role() IN ('admin','manager')
    OR (app_role() = 'area_manager' AND EXISTS (
          SELECT 1 FROM sites s WHERE s.id = visits.site_id
             AND s.area_id IN (SELECT app_area_ids())))
    OR (app_role() = 'team_leader' AND agent_id IN (SELECT app_team_ids()))
    OR (app_role() = 'agent' AND agent_id = app_uid())
    OR (app_role() = 'client' AND EXISTS (
          SELECT 1 FROM sites s WHERE s.id = visits.site_id
             AND s.client_id = app_client_id()
             AND (app_site_id() IS NULL OR s.id = app_site_id())))
  ));

CREATE POLICY visits_ins ON visits FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('visits.create'));

-- An engineer may edit their OWN visit (check in, check out, write it up);
-- everyone else needs the same row scope they can read.
CREATE POLICY visits_upd ON visits FOR UPDATE TO authenticated
  USING (app_has_perm('visits.edit') AND (
        app_role() IN ('admin','manager')
     OR (app_role() = 'agent' AND agent_id = app_uid())
     OR (app_role() = 'team_leader'  AND agent_id IN (SELECT app_team_ids()))
     OR (app_role() = 'area_manager' AND EXISTS (
           SELECT 1 FROM sites s WHERE s.id = visits.site_id
              AND s.area_id IN (SELECT app_area_ids())))))
  WITH CHECK (app_has_perm('visits.edit'));

CREATE POLICY visits_del ON visits FOR DELETE TO authenticated
  USING (app_has_perm('visits.delete'));

-- ---------------------------------------------------------------- reports
CREATE POLICY reports_sel ON reports FOR SELECT TO authenticated USING (
  app_has_perm('visits.view') AND EXISTS (
    SELECT 1 FROM visits v WHERE v.id = reports.visit_id));   -- visits' own policy cascades

CREATE POLICY reports_ins ON reports FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('visits.edit'));
CREATE POLICY reports_upd ON reports FOR UPDATE TO authenticated
  USING (app_has_perm('visits.edit')) WITH CHECK (app_has_perm('visits.edit'));
-- Deleting a report is admin + manager only, matching DELETE /api/visits/<id>/report
CREATE POLICY reports_del ON reports FOR DELETE TO authenticated
  USING (app_has_perm('visits.delete') AND app_role() IN ('admin','manager'));

-- ---------------------------------------------------------------- photos
CREATE POLICY photos_sel ON photos FOR SELECT TO authenticated
  USING (app_has_perm('visits.view'));
CREATE POLICY photos_ins ON photos FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('visits.edit'));
CREATE POLICY photos_upd ON photos FOR UPDATE TO authenticated
  USING (app_has_perm('visits.edit')) WITH CHECK (app_has_perm('visits.edit'));
CREATE POLICY photos_del ON photos FOR DELETE TO authenticated
  USING (app_has_perm('visits.delete'));
CREATE POLICY users_sel ON users FOR SELECT TO authenticated USING (
  auth_id = auth.uid()                                  -- always see yourself
  OR app_has_perm('users.view')
  OR (app_role() IN ('agent','area_manager','team_leader')   -- colleague directory
      AND role IN ('agent','area_manager','team_leader','manager'))
);
CREATE POLICY users_ins ON users FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('users.create'));
CREATE POLICY users_upd ON users FOR UPDATE TO authenticated
  USING (app_has_perm('users.edit') OR auth_id = auth.uid())
  WITH CHECK (app_has_perm('users.edit') OR auth_id = auth.uid());
CREATE POLICY users_del ON users FOR DELETE TO authenticated
  USING (app_has_perm('users.delete'));
CREATE POLICY settings_sel ON settings FOR SELECT TO authenticated USING (true);
CREATE POLICY settings_w   ON settings FOR ALL    TO authenticated
  USING (app_has_perm('settings.edit')) WITH CHECK (app_has_perm('settings.edit'));

CREATE POLICY translations_sel ON translations FOR SELECT TO authenticated USING (true);
CREATE POLICY translations_w   ON translations FOR ALL TO authenticated
  USING (app_has_perm('settings.edit')) WITH CHECK (app_has_perm('settings.edit'));

CREATE POLICY rp_sel ON role_permissions FOR SELECT TO authenticated
  USING (app_has_perm('permissions.view'));
CREATE POLICY rp_w   ON role_permissions FOR ALL TO authenticated
  USING (app_has_perm('permissions.edit')) WITH CHECK (app_has_perm('permissions.edit'));
CREATE POLICY up_sel ON user_permissions FOR SELECT TO authenticated
  USING (app_has_perm('permissions.view') OR user_id = app_uid());
CREATE POLICY up_w   ON user_permissions FOR ALL TO authenticated
  USING (app_has_perm('permissions.edit')) WITH CHECK (app_has_perm('permissions.edit'));

CREATE POLICY audit_sel ON audit_log FOR SELECT TO authenticated
  USING (app_role() = 'admin');
CREATE POLICY audit_ins ON audit_log FOR INSERT TO authenticated
  WITH CHECK (true);              -- append-only: no UPDATE or DELETE policy exists

CREATE POLICY notif_own ON notifications FOR ALL TO authenticated
  USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY notifp_own ON notification_prefs FOR ALL TO authenticated
  USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY prefs_own ON user_prefs FOR ALL TO authenticated
  USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
