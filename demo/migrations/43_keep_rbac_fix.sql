-- ===================================================================
-- 42 tried to keep role_permissions/user_permissions by leaving them out of
-- the TRUNCATE. Postgres refuses that: TRUNCATE of `users` requires every
-- table with an FK to it to be truncated in the same statement, and being
-- DEFERRABLE does not change that — it is a TRUNCATE rule, not a constraint
-- check. The reset died with "cannot truncate a table referenced in a foreign
-- key constraint" and the sandbox stopped resetting at all.
--
-- So: truncate exactly as before, but CARRY the two permission tables across
-- the wipe in temp copies and put them back afterwards, instead of restoring
-- them from the snapshot. Same outcome (the owner's RBAC survives), without
-- fighting TRUNCATE.
-- ===================================================================
CREATE OR REPLACE FUNCTION demo_reset() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE t text; r record; n int := 0; who text; last timestamptz;
        orphans int := 0;
        -- restored from the snapshot? no. wiped? also no. carried across.
        carried text[] := ARRAY['role_permissions','user_permissions'];
        logs    text[] := ARRAY['demo_reset_log','trial_sessions','trial_activity'];
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

  CREATE TEMP TABLE _keep_role ON COMMIT DROP AS SELECT * FROM role_permissions;
  CREATE TEMP TABLE _keep_user ON COMMIT DROP AS SELECT * FROM user_permissions;

  SELECT string_agg(format('public.%I', tablename), ', ')
    INTO t FROM pg_tables
   WHERE schemaname = 'public' AND NOT (tablename = ANY(logs));
  EXECUTE 'TRUNCATE TABLE ' || t;

  FOR t IN SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
              AND NOT (tablename = ANY(logs))
              AND NOT (tablename = ANY(carried))
  LOOP
    EXECUTE format('INSERT INTO public.%I SELECT * FROM demo_snapshot.%I', t, t);
    n := n + 1;
  END LOOP;

  FOR r IN SELECT seq, last_value FROM demo_snapshot._sequences WHERE seq IS NOT NULL
  LOOP
    EXECUTE format('SELECT setval(%L, %s)', r.seq, GREATEST(r.last_value, 1));
  END LOOP;

  -- put the owner's RBAC back exactly as it was a moment ago
  INSERT INTO role_permissions SELECT * FROM _keep_role;
  INSERT INTO user_permissions SELECT * FROM _keep_user;
  n := n + 2;

  -- An override can outlive the user it points at: the owner (or a prospect)
  -- creates a user, gives them an override, and the restore then brings back
  -- the original user list without that person. Drop those before COMMIT, or
  -- the deferred FK fires and rolls the whole reset back.
  DELETE FROM user_permissions WHERE user_id NOT IN (SELECT id FROM users);
  GET DIAGNOSTICS orphans = ROW_COUNT;

  -- the carried tables were not restored from the snapshot, so their own
  -- sequences were not covered by the setval loop above
  FOREACH t IN ARRAY carried LOOP
    EXECUTE format(
      'SELECT setval(s, GREATEST(COALESCE((SELECT max(id) FROM public.%I), 1), 1))
         FROM pg_get_serial_sequence(%L, %L) s WHERE s IS NOT NULL', t, 'public.' || t, 'id');
  END LOOP;

  PERFORM set_config('app.trial_suppress', 'off', true);
  INSERT INTO demo_reset_log(by_email) VALUES (who);
  RETURN jsonb_build_object('ok', true, 'reset', true, 'tables', n,
                            'kept_rbac', true, 'orphan_overrides_dropped', orphans,
                            'at', now_cairo());
END
$fn$;
REVOKE ALL ON FUNCTION demo_reset() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION demo_reset() TO authenticated;
