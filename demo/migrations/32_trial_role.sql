-- =====================================================================
-- A `trial` ROLE OF ITS OWN.
--
-- Until now the trial account borrowed `manager` and had six per-user
-- denials bolted on. That worked, but it was a manager pretending: anyone
-- reading role_permissions saw a manager, the denials lived somewhere else,
-- and every future question ("can a prospect do X?") meant checking two
-- places. A prospect evaluating the system is not a manager — they are a
-- distinct kind of user and deserve a distinct role.
--
-- WHAT A TRIAL USER IS FOR: seeing whether this is the right system for
-- their company. So they get the whole product to look at and enough write
-- access to feel it work — but nothing that damages the demo for the next
-- visitor, and nothing that reaches the machinery underneath.
--
--   sees + creates + edits   clients, branches, the diary, dispatch,
--                            requests, reports, contracts, invoices,
--                            chemicals, devices, issues, cash, transport,
--                            shifts, leads, targets, IPM library, analytics
--   sees, cannot change      the staff list, the permission matrix,
--                            company settings
--   cannot do at all         DELETE anything, create or edit staff, edit
--                            permissions or settings, clear the schedule,
--                            the finance ledger, the audit log, backups
--
-- Deleting is the deliberate omission. Nobody needs to delete a record to
-- decide whether they want the software, and between resets a deleted
-- branch is a hole in the demo the next visitor walks into.
-- =====================================================================

-- ---- the constraints have to know the role exists --------------------
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check
  CHECK (role IN ('admin','manager','agent','area_manager','team_leader','client','trial'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','manager','agent','area_manager','team_leader','client','trial'));

-- ---- the matrix row for `trial` --------------------------------------
-- Built from the catalogue rather than typed out, so a permission added
-- later lands here with a sensible default instead of being silently absent.
INSERT INTO role_permissions (role, perm, allowed)
SELECT 'trial', p.perm,
       CASE
         -- nothing is deleted by a visitor
         WHEN p.perm LIKE '%.delete'          THEN 0
         -- the machinery: readable, never writable
         WHEN p.perm IN ('users.create','users.edit',
                         'permissions.edit','settings.edit')  THEN 0
         -- "clear the entire diary" is not an evaluation feature
         WHEN p.perm = 'schedule.clear_all'   THEN 0
         -- the finance ledger is not ported and is not a demo surface
         WHEN p.perm LIKE 'finance.%'         THEN 0
         ELSE 1
       END
FROM (SELECT DISTINCT perm FROM role_permissions) p
ON CONFLICT (role, perm) DO UPDATE SET allowed = excluded.allowed;

-- ---- move the account onto it ----------------------------------------
UPDATE users SET role = 'trial' WHERE email = 'trial@demo.foxcrm.app';

-- The per-user denials were scaffolding for the borrowed manager role and
-- are now said properly by the role itself. Removing them keeps one answer
-- to "what may a prospect do", in one table.
DELETE FROM user_permissions
 WHERE user_id IN (SELECT id FROM users WHERE role = 'trial');

-- ---- let the office-level policies recognise it ----------------------
-- §6.3's policies name 'admin' and 'manager' as the roles that see the
-- whole book. A trial user is an office-level viewer too, so without this
-- they would sign in to an empty CRM — every list scoped to nothing.
DROP POLICY IF EXISTS sites_sel ON sites;
CREATE POLICY sites_sel ON sites FOR SELECT TO authenticated USING (
  (app_role() = 'client' AND client_id = app_client_id()
     AND (app_site_id() IS NULL OR id = app_site_id()))
  OR (app_has_perm('clients.view') AND (
        app_role() IN ('admin','manager','trial')
        OR (app_role() = 'area_manager' AND (area_id IN (SELECT app_area_ids())
                                             OR id IN (SELECT app_visited_site_ids())))
        OR (app_role() = 'team_leader' AND id IN (SELECT app_visited_site_ids()))
        OR (app_role() = 'agent' AND (preferred_agent_id = app_uid()
                                      OR id IN (SELECT app_visited_site_ids())))
  )));

DROP POLICY IF EXISTS visits_sel ON visits;
CREATE POLICY visits_sel ON visits FOR SELECT TO authenticated USING (
  app_has_perm('visits.view') AND (
    app_role() IN ('admin','manager','trial')
    OR (app_role() = 'area_manager' AND app_site_area_id(site_id) IN (SELECT app_area_ids()))
    OR (app_role() = 'team_leader' AND agent_id IN (SELECT app_team_ids()))
    OR (app_role() = 'agent' AND agent_id = app_uid())
    OR (app_role() = 'client' AND client_id = app_client_id()
          AND (app_site_id() IS NULL OR site_id IS NULL OR site_id = app_site_id()))
  ));

DROP POLICY IF EXISTS visits_upd ON visits;
CREATE POLICY visits_upd ON visits FOR UPDATE TO authenticated
  USING (app_has_perm('visits.edit') AND (
        app_role() IN ('admin','manager','trial')
     OR (app_role() = 'agent' AND agent_id = app_uid())
     OR (app_role() = 'team_leader'  AND agent_id IN (SELECT app_team_ids()))
     OR (app_role() = 'area_manager' AND app_site_area_id(site_id) IN (SELECT app_area_ids()))))
  WITH CHECK (app_has_perm('visits.edit'));

DROP POLICY IF EXISTS clients_sel ON clients;
CREATE POLICY clients_sel ON clients FOR SELECT TO authenticated USING (
  (app_role() = 'client' AND id = app_client_id())
  OR (app_has_perm('clients.view')
      AND app_role() IN ('admin','manager','agent','area_manager','team_leader','trial'))
);

-- ---- the reset belongs to the ROLE, not to one address ---------------
CREATE OR REPLACE FUNCTION demo_reset() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE
  t     text;
  r     record;
  n     int := 0;
  who   text;
  last  timestamptz;
BEGIN
  -- Any trial-role account may reset its own sandbox; no other login can,
  -- admin included. Keyed on the role rather than one email address, so a
  -- second trial account needs no change here.
  IF app_role() IS DISTINCT FROM 'trial' THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  SELECT u.email INTO who FROM users u WHERE u.id = app_uid();

  SELECT max(l.reset_at) INTO last FROM demo_reset_log l;
  IF last IS NOT NULL AND last > now() - interval '10 seconds' THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'just reset', 'at', now_cairo());
  END IF;

  SET CONSTRAINTS ALL DEFERRED;

  SELECT string_agg(format('public.%I', tablename), ', ')
    INTO t FROM pg_tables
   WHERE schemaname = 'public' AND tablename <> 'demo_reset_log';
  EXECUTE 'TRUNCATE TABLE ' || t;

  FOR t IN SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND tablename <> 'demo_reset_log'
  LOOP
    EXECUTE format('INSERT INTO public.%I SELECT * FROM demo_snapshot.%I', t, t);
    n := n + 1;
  END LOOP;

  FOR r IN SELECT seq, last_value FROM demo_snapshot._sequences WHERE seq IS NOT NULL
  LOOP
    EXECUTE format('SELECT setval(%L, %s)', r.seq, GREATEST(r.last_value, 1));
  END LOOP;

  INSERT INTO demo_reset_log(by_email) VALUES (who);
  RETURN jsonb_build_object('ok', true, 'tables', n, 'at', now_cairo());
END
$fn$;

REVOKE ALL ON FUNCTION demo_reset() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION demo_reset() TO authenticated;

-- ---- keep `trial` out of the customer-facing permission matrix -------
-- The matrix screen is a selling point; a "trial" column in it is an
-- artefact of how the demo is run, not part of the product.
CREATE OR REPLACE FUNCTION permissions_catalog() RETURNS jsonb
  LANGUAGE sql STABLE AS
$fn$
  SELECT jsonb_build_object(
    'catalog', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('module', mod, 'actions', acts) ORDER BY mod)
        FROM (SELECT split_part(perm, '.', 1) AS mod,
                     jsonb_agg(DISTINCT split_part(perm, '.', 2)) AS acts
                FROM role_permissions WHERE role <> 'trial' GROUP BY 1) c), '[]'::jsonb),
    'roles', COALESCE((SELECT jsonb_agg(DISTINCT role ORDER BY role)
                         FROM role_permissions WHERE role <> 'trial'), '[]'::jsonb),
    'defaults', COALESCE((
      SELECT jsonb_object_agg(role, perms)
        FROM (SELECT role, jsonb_object_agg(perm, allowed = 1) AS perms
                FROM role_permissions WHERE role <> 'trial' GROUP BY role) d), '{}'::jsonb),
    'roles_effective', COALESCE((
      SELECT jsonb_object_agg(role, perms)
        FROM (SELECT role, jsonb_object_agg(perm, allowed = 1) AS perms
                FROM role_permissions WHERE role <> 'trial' GROUP BY role) d), '{}'::jsonb),
    'role_overrides', '{}'::jsonb)
$fn$;
