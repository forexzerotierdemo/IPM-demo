-- ===================================================================
-- setval() IS NOT TRANSACTIONAL.
--
-- demo_reset restored every sequence from demo_snapshot._sequences, a value
-- recorded when the snapshot was taken. That is correct when the reset
-- commits. When it ABORTS — as it just did twice while this was being built —
-- the tables roll back but the sequences DO NOT: Postgres explicitly does not
-- undo setval on rollback. So a failed reset left every sequence rewound to
-- the snapshot while the tables still held newer rows, and the next insert
-- anywhere collided: "duplicate key value violates unique constraint
-- audit_log_pkey". The database was left subtly broken by a failure that
-- reported itself as a clean rollback.
--
-- Cure: stop replaying a recorded number and derive each sequence from the
-- data that is actually in the table. That is self-correcting — it gives the
-- right answer after a clean reset AND after a failed one.
-- ===================================================================
CREATE OR REPLACE FUNCTION repair_sequences() RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT c.table_name AS tbl, c.column_name AS col,
           pg_get_serial_sequence('public.' || c.table_name, c.column_name) AS seq
      FROM information_schema.columns c
      JOIN pg_tables t ON t.schemaname = 'public' AND t.tablename = c.table_name
     WHERE c.table_schema = 'public'
       AND pg_get_serial_sequence('public.' || c.table_name, c.column_name) IS NOT NULL
  LOOP
    EXECUTE format(
      'SELECT setval(%L, GREATEST(COALESCE((SELECT max(%I) FROM public.%I), 0) + 1, 1), false)',
      r.seq, r.col, r.tbl);
    n := n + 1;
  END LOOP;
  RETURN n;
END
$fn$;

-- repair the damage the two failed resets already did
SELECT repair_sequences();

CREATE OR REPLACE FUNCTION demo_reset() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE t text; n int := 0; who text; last timestamptz;
        orphans int := 0; seqs int := 0;
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

  -- the owner's RBAC is configuration, not demo data: carry it across the wipe
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

  INSERT INTO role_permissions SELECT * FROM _keep_role;
  INSERT INTO user_permissions SELECT * FROM _keep_user;
  n := n + 2;

  -- An override can outlive the user it points at; drop those before COMMIT
  -- or the deferred FK fires and rolls the whole reset back.
  DELETE FROM user_permissions WHERE user_id NOT IN (SELECT id FROM users);
  GET DIAGNOSTICS orphans = ROW_COUNT;

  seqs := repair_sequences();   -- from the data, never from a recorded number

  PERFORM set_config('app.trial_suppress', 'off', true);
  INSERT INTO demo_reset_log(by_email) VALUES (who);
  RETURN jsonb_build_object('ok', true, 'reset', true, 'tables', n,
                            'kept_rbac', true, 'orphan_overrides_dropped', orphans,
                            'sequences', seqs, 'at', now_cairo());
END
$fn$;
REVOKE ALL ON FUNCTION demo_reset() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION demo_reset() TO authenticated;
REVOKE ALL ON FUNCTION repair_sequences() FROM PUBLIC, anon, authenticated;
