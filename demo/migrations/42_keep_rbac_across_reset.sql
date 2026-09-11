-- ===================================================================
-- The admin's RBAC decisions are CONFIGURATION, not demo data.
--
-- demo_reset() truncated all 60 public tables and restored them from
-- demo_snapshot, excluding only the three log tables. role_permissions and
-- user_permissions were in that sweep — so the owner would open Permissions,
-- grant something to the trial role, save it successfully, and then the next
-- prospect to sign out would roll the whole matrix back to the snapshot.
-- Proven before this migration was written: admin grants trial clients.delete
-- (reads back true), one trial signs in and out, reads back false.
--
-- That is almost certainly the "it doesn't save" report: the save was real
-- every time, and a trial sign-out silently undid it minutes later.
--
-- So the two permission tables now survive the reset. What a prospect DOES is
-- still wiped; how the owner has configured the portal is not.
-- ===================================================================

-- Now that these tables persist, a trial user must never be able to write to
-- them — otherwise a prospect could make a permanent change to the owner's
-- portal. The permission bit alone is no longer a sufficient gate, because the
-- owner may legitimately tick permissions.edit for the trial role to show the
-- screen off. Role beats permission here.
CREATE OR REPLACE FUNCTION update_role_permissions(p_role text, p_perms jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE n int := 0;
BEGIN
  IF app_role() = 'trial' THEN
    RAISE EXCEPTION 'The trial portal cannot change permissions';
  END IF;
  IF NOT app_has_perm('permissions.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM role_permissions WHERE role = p_role) THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;
  IF p_role = 'admin' THEN
    RAISE EXCEPTION 'The admin role always has full access and cannot be edited';
  END IF;

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

CREATE OR REPLACE FUNCTION update_user_permissions(p_user_id bigint, p_perms jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE n int := 0; u record;
BEGIN
  IF app_role() = 'trial' THEN
    RAISE EXCEPTION 'The trial portal cannot change permissions';
  END IF;
  IF NOT app_has_perm('permissions.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT id, role INTO u FROM users WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  IF u.role = 'admin' THEN
    RAISE EXCEPTION 'Admin users always have full access and cannot be restricted';
  END IF;

  -- true/false store an override; NULL clears it so the role default applies.
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
  GET DIAGNOSTICS n = ROW_COUNT;

  PERFORM app_audit('permissions.user.update', 'user', p_user_id,
                    'set ' || n || ' permission override(s)');
  RETURN get_user_permissions(p_user_id);
END
$fn$;

-- ---- the reset itself ------------------------------------------------
-- One KEEP list, used by the truncate and the restore alike, so the two can
-- never drift apart again.
CREATE OR REPLACE FUNCTION demo_reset() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE t text; r record; n int := 0; who text; last timestamptz;
        orphans int := 0;
        keep text[] := ARRAY['demo_reset_log','trial_sessions','trial_activity',
                             'role_permissions','user_permissions'];
        forced boolean := COALESCE(current_setting('app.trial_force_reset', true), '') = 'on';
BEGIN
  IF app_role() IS DISTINCT FROM 'trial' THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  SELECT u.email INTO who FROM users u WHERE u.id = app_uid();

  SELECT max(l.reset_at) INTO last FROM demo_reset_log l;
  IF NOT forced AND last IS NOT NULL AND last > now() - interval '10 seconds' THEN
    RETURN jsonb_build_object('ok', true, 'reset', false,
                              'skipped', 'just reset', 'at', now_cairo());
  END IF;

  PERFORM set_config('app.trial_suppress', 'on', true);
  SET CONSTRAINTS ALL DEFERRED;

  SELECT string_agg(format('public.%I', tablename), ', ')
    INTO t FROM pg_tables
   WHERE schemaname = 'public' AND NOT (tablename = ANY(keep));
  EXECUTE 'TRUNCATE TABLE ' || t;

  FOR t IN SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND NOT (tablename = ANY(keep))
  LOOP
    EXECUTE format('INSERT INTO public.%I SELECT * FROM demo_snapshot.%I', t, t);
    n := n + 1;
  END LOOP;

  FOR r IN SELECT seq, last_value FROM demo_snapshot._sequences WHERE seq IS NOT NULL
  LOOP
    EXECUTE format('SELECT setval(%L, %s)', r.seq, GREATEST(r.last_value, 1));
  END LOOP;

  -- user_permissions now outlives the users table it points at. If the owner
  -- (or a prospect) created a user, gave them an override and the reset then
  -- restored the original user list, that row would reference a row that no
  -- longer exists and the FK would fire at COMMIT — rolling back the entire
  -- reset and leaving the sandbox dirty. Drop the orphans before we get there.
  DELETE FROM user_permissions
   WHERE user_id NOT IN (SELECT id FROM users);
  GET DIAGNOSTICS orphans = ROW_COUNT;

  PERFORM set_config('app.trial_suppress', 'off', true);
  INSERT INTO demo_reset_log(by_email) VALUES (who);
  RETURN jsonb_build_object('ok', true, 'reset', true, 'tables', n,
                            'kept_rbac', true, 'orphan_overrides_dropped', orphans,
                            'at', now_cairo());
END
$fn$;
REVOKE ALL ON FUNCTION demo_reset() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION demo_reset() TO authenticated;
