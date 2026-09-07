-- =====================================================================
-- THE TRIAL ROLE JOINS THE PERMISSION MATRIX, AND THE MATRIX BECOMES
-- EDITABLE.
--
-- 32_trial_role.sql filtered `trial` OUT of permissions_catalog(), on the
-- reasoning that it is an artefact of how the demo is run rather than part
-- of the product. That was the wrong call for the person running the demo:
-- what a prospect may see is exactly the thing an owner wants to tune, and
-- tuning it meant editing SQL.
--
-- So `trial` is a role like any other now — it appears in the Permissions
-- screen's dropdown and can be ticked and unticked there. And the three
-- routes that make that screen do anything are ported, because a matrix
-- you can only read is a picture of a feature.
--
--   PUT /permissions/roles/<role>    retune a whole role
--   GET /permissions/users/<id>      what one person inherits vs. is given
--   PUT /permissions/users/<id>      give or withhold from one person
--
-- WHAT STAYS FIXED. `admin` is not editable — it is the superuser and
-- app_has_perm() short-circuits it, so a matrix that pretended otherwise
-- would be lying. Everything else, including trial, is yours.
--
-- WHAT WIDENING `trial` COSTS. Nothing is unrecoverable: every table a
-- prospect can reach is restored by demo_reset() when the last trial
-- session ends. But between resets, a trial user given (say) clients.delete
-- really can delete a customer, and the next visitor walks into the hole.
-- That is the trade being made on this screen, and it is worth knowing
-- while making it.
-- =====================================================================

-- ---- trial is a role like any other ----------------------------------
CREATE OR REPLACE FUNCTION permissions_catalog() RETURNS jsonb
  LANGUAGE sql STABLE AS
$fn$
  SELECT jsonb_build_object(
    'catalog', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('module', mod, 'actions', acts) ORDER BY mod)
        FROM (SELECT split_part(perm, '.', 1) AS mod,
                     jsonb_agg(DISTINCT split_part(perm, '.', 2)) AS acts
                FROM role_permissions GROUP BY 1) c), '[]'::jsonb),
    -- Ordered so the dropdown reads down the org chart and ends with the
    -- one that is not a job: admin, the office, the field, the customer,
    -- then the visitor.
    'roles', COALESCE((
      SELECT jsonb_agg(role ORDER BY array_position(
               ARRAY['admin','manager','area_manager','team_leader','agent','client','trial'],
               role))
        FROM (SELECT DISTINCT role FROM role_permissions) r), '[]'::jsonb),
    'defaults', COALESCE((
      SELECT jsonb_object_agg(role, perms)
        FROM (SELECT role, jsonb_object_agg(perm, allowed = 1) AS perms
                FROM role_permissions GROUP BY role) d), '{}'::jsonb),
    'roles_effective', COALESCE((
      SELECT jsonb_object_agg(role, perms)
        FROM (SELECT role, jsonb_object_agg(perm, allowed = 1) AS perms
                FROM role_permissions GROUP BY role) d), '{}'::jsonb),
    -- role_permissions IS the matrix here; there is no separate table of
    -- built-in defaults to diff against, so nothing is an "override".
    'role_overrides', COALESCE((
      SELECT jsonb_object_agg(role, '{}'::jsonb)
        FROM (SELECT DISTINCT role FROM role_permissions) r), '{}'::jsonb))
$fn$;


-- ---- retune a role ---------------------------------------------------
CREATE OR REPLACE FUNCTION update_role_permissions(p_role text, p_perms jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE n int := 0;
BEGIN
  IF NOT app_has_perm('permissions.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM role_permissions WHERE role = p_role) THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;
  IF p_role = 'admin' THEN
    RAISE EXCEPTION 'The admin role always has full access and cannot be edited';
  END IF;

  -- Only keys that are real permissions; anything else is ignored rather
  -- than stored, so a stale screen cannot invent a permission.
  UPDATE role_permissions rp
     SET allowed = CASE WHEN (e.value)::boolean THEN 1 ELSE 0 END
    FROM jsonb_each(COALESCE(p_perms, '{}'::jsonb)) e
   WHERE rp.role = p_role AND rp.perm = e.key
     AND jsonb_typeof(e.value) = 'boolean';
  GET DIAGNOSTICS n = ROW_COUNT;

  PERFORM app_audit('permissions.role.update', 'role', NULL,
                    'set ' || n || ' permission(s) for role ''' || p_role || '''');

  RETURN jsonb_build_object(
    'role', p_role,
    'effective', COALESCE((SELECT jsonb_object_agg(perm, allowed = 1)
                             FROM role_permissions WHERE role = p_role), '{}'::jsonb),
    'overrides', '{}'::jsonb);
END
$fn$;


-- ---- what ONE person inherits, and what they were given ---------------
CREATE OR REPLACE FUNCTION get_user_permissions(p_user_id bigint) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE u record;
BEGIN
  IF NOT app_has_perm('permissions.view') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT id, full_name, role INTO u FROM users WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;

  RETURN jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'full_name', u.full_name, 'role', u.role),
    -- what the role gives them
    'role_effective', COALESCE((SELECT jsonb_object_agg(perm, allowed = 1)
                                  FROM role_permissions WHERE role = u.role), '{}'::jsonb),
    -- the resolved answer: a per-user row beats the role, admin excepted
    'effective', COALESCE((
      SELECT jsonb_object_agg(rp.perm,
               COALESCE((SELECT up.allowed = 1 FROM user_permissions up
                          WHERE up.user_id = u.id AND up.perm = rp.perm),
                        CASE WHEN u.role = 'admin' THEN true ELSE rp.allowed = 1 END))
        FROM role_permissions rp
       WHERE rp.role = CASE WHEN u.role = 'admin' THEN 'admin' ELSE u.role END),
      '{}'::jsonb),
    -- and what was set on the person specifically
    'overrides', COALESCE((SELECT jsonb_object_agg(perm, allowed = 1)
                             FROM user_permissions WHERE user_id = u.id), '{}'::jsonb));
END
$fn$;


-- ---- give or withhold from one person ---------------------------------
-- true grants, false withholds, NULL clears the override so they go back to
-- inheriting the role. That third state is the point of the screen: "not
-- set" is a different answer from "denied".
CREATE OR REPLACE FUNCTION update_user_permissions(p_user_id bigint, p_perms jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE u record;
BEGIN
  IF NOT app_has_perm('permissions.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT id, role INTO u FROM users WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  IF u.role = 'admin' THEN
    RAISE EXCEPTION 'Admin users always have full access and cannot be edited';
  END IF;

  DELETE FROM user_permissions up
   USING jsonb_each(COALESCE(p_perms, '{}'::jsonb)) e
   WHERE up.user_id = p_user_id AND up.perm = e.key
     AND jsonb_typeof(e.value) = 'null';

  INSERT INTO user_permissions(user_id, perm, allowed)
  SELECT p_user_id, e.key, CASE WHEN (e.value)::boolean THEN 1 ELSE 0 END
    FROM jsonb_each(COALESCE(p_perms, '{}'::jsonb)) e
   WHERE jsonb_typeof(e.value) = 'boolean'
     AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.perm = e.key)
  ON CONFLICT (user_id, perm) DO UPDATE SET allowed = excluded.allowed;

  PERFORM app_audit('permissions.user.update', 'user', p_user_id, NULL);
  RETURN get_user_permissions(p_user_id);
END
$fn$;
