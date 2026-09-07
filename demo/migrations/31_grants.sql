-- =====================================================================
-- TABLE GRANTS. RLS decides which ROWS you see; grants decide whether you
-- may touch the table at all, and which COLUMNS. The demo had Supabase's
-- default blanket grant — SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
-- TRIGGER, REFERENCES to both `anon` and `authenticated` on all 60 tables.
--
-- Two things wrong with that:
--
--   1. The column REVOKE in 30_harden.sql did nothing. A table-level SELECT
--      grant covers every column, so revoking one column while the table
--      grant stands changes nothing — password_hash stayed readable.
--      Column privileges only bite once the table-level grant is gone.
--
--   2. `authenticated` held TRUNCATE, and **TRUNCATE is not subject to RLS**.
--      PostgREST never issues one, so it was not reachable through the API
--      and nothing was actually exposed — but a grant that would erase a
--      table regardless of every policy in §6 has no business existing.
--
--   3. `anon` — an unauthenticated visitor holding the public key — had the
--      same set. RLS returned nothing to them, which is why the audit came
--      back clean, but the grant was the only thing between a policy
--      mistake and an open database.
-- =====================================================================

-- ---- anon needs nothing ---------------------------------------------
-- Every screen in this app is behind a login. An unauthenticated caller has
-- no legitimate read, so it gets no privilege rather than a policy that
-- happens to return zero rows.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- ---- authenticated: the four verbs PostgREST actually uses ----------
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM authenticated;

-- ---- users: credentials are not a column anyone may select ----------
-- The table grant has to go before the column grants mean anything.
REVOKE ALL ON public.users FROM authenticated;

GRANT SELECT (id, full_name, email, role, phone, client_id, site_id,
              team_leader_id, specialization, hire_date, license_no,
              license_expiry, lang, active, created_at)
  ON public.users TO authenticated;

GRANT INSERT (full_name, email, role, phone, client_id, site_id,
              team_leader_id, specialization, hire_date, license_no,
              license_expiry, lang, active)
  ON public.users TO authenticated;

GRANT UPDATE (full_name, email, role, phone, client_id, site_id,
              team_leader_id, specialization, hire_date, license_no,
              license_expiry, lang, active)
  ON public.users TO authenticated;

GRANT DELETE ON public.users TO authenticated;   -- still row-gated by §6.4

-- v_users referenced auth_id, which is the GoTrue id tying a profile to a
-- login. Nothing needs it on the wire any more — my_profile() resolves the
-- caller through app_uid() — and dropping it means `authenticated` needs no
-- grant on that column at all.
DROP VIEW IF EXISTS v_users CASCADE;
CREATE VIEW v_users WITH (security_invoker = true) AS
SELECT u.id, u.full_name, u.email, u.role, u.phone, u.client_id, u.site_id,
       u.specialization, u.license_no, u.license_expiry, u.lang,
       u.active, u.hire_date, u.team_leader_id, u.created_at,
       s.name AS site_name,
       CASE WHEN u.role = 'area_manager' THEN
         COALESCE((SELECT jsonb_agg(a.id ORDER BY a.sort_order, a.id)
                     FROM area_manager_areas la JOIN areas a ON a.id = la.area_id
                    WHERE la.manager_id = u.id), '[]'::jsonb) END AS area_ids,
       CASE WHEN u.role = 'area_manager' THEN
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name_en', a.name_en,
                                                       'name_ar', a.name_ar)
                                    ORDER BY a.sort_order, a.id)
                     FROM area_manager_areas la JOIN areas a ON a.id = la.area_id
                    WHERE la.manager_id = u.id), '[]'::jsonb) END AS areas,
       CASE WHEN u.role = 'team_leader' THEN
         COALESCE((SELECT jsonb_agg(m.id ORDER BY m.full_name)
                     FROM users m WHERE m.team_leader_id = u.id AND m.active = 1),
                  '[]'::jsonb) END AS member_ids,
       CASE WHEN u.role = 'team_leader' THEN
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'full_name', m.full_name,
                                                       'role', m.role) ORDER BY m.full_name)
                     FROM users m WHERE m.team_leader_id = u.id AND m.active = 1),
                  '[]'::jsonb) END AS members
FROM users u
LEFT JOIN sites s ON s.id = u.site_id;

GRANT SELECT ON public.v_users TO authenticated;

-- my_profile() reads v_users, which no longer carries auth_id, so the
-- subtraction it used to do is gone too.
CREATE OR REPLACE FUNCTION my_profile() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$fn$
  SELECT to_jsonb(v) || jsonb_build_object('permissions', my_permissions())
    FROM v_users v
   WHERE v.id = app_uid()
$fn$;

-- The other views were dropped by the CASCADE only if they depended on
-- v_users; none do, but re-grant defensively so nothing is left unreadable.
GRANT SELECT ON public.v_clients, public.v_sites, public.v_visits,
                public.v_reports, public.v_devices TO authenticated;

-- ---- the reset log is nobody's business ------------------------------
-- RLS with no policy already denies everyone, but leaving the grant in
-- place means one careless policy away from readable. Take the grant too,
-- so the table is unreachable by construction rather than by rule.
REVOKE ALL ON public.demo_reset_log FROM anon, authenticated;

-- ---- and again, AFTER the view was recreated -------------------------
-- Supabase grants anon+authenticated a full set on every newly created
-- object in `public`, so recreating v_users above handed anon SELECT,
-- INSERT, UPDATE, DELETE and TRUNCATE on it. Re-revoke, and change the
-- DEFAULT so the next object created does not repeat the trick.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM authenticated;

-- A view is read-only here; writes go to the base tables through the shim.
REVOKE INSERT, UPDATE, DELETE ON
  public.v_users, public.v_clients, public.v_sites,
  public.v_visits, public.v_reports, public.v_devices FROM authenticated;
