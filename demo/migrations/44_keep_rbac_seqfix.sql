-- 43 assumed both carried tables have an `id`. role_permissions does not —
-- it is keyed on (role, perm) — so the reset raised "column id does not
-- exist" and rolled back. Find whatever column actually owns a sequence,
-- if any, instead of assuming one.
CREATE OR REPLACE FUNCTION demo_reset() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE t text; r record; n int := 0; who text; last timestamptz;
        orphans int := 0;
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

  INSERT INTO role_permissions SELECT * FROM _keep_role;
  INSERT INTO user_permissions SELECT * FROM _keep_user;
  n := n + 2;

  DELETE FROM user_permissions WHERE user_id NOT IN (SELECT id FROM users);
  GET DIAGNOSTICS orphans = ROW_COUNT;

  -- whichever column owns a sequence on the carried tables, if any at all
  FOR r IN
    SELECT c.table_name AS tbl, c.column_name AS col,
           pg_get_serial_sequence('public.' || c.table_name, c.column_name) AS seq
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = ANY(carried)
       AND pg_get_serial_sequence('public.' || c.table_name, c.column_name) IS NOT NULL
  LOOP
    EXECUTE format('SELECT setval(%L, GREATEST(COALESCE((SELECT max(%I) FROM public.%I), 1), 1))',
                   r.seq, r.col, r.tbl);
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
