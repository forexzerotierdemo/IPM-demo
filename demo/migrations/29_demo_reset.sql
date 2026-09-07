-- =====================================================================
-- THE TRIAL ACCOUNT: a login to hand a prospect, where nothing they do
-- survives them.
--
-- The prospect gets a full admin view and can click, edit, create and
-- delete freely — that is the point, they are deciding whether this is
-- their company's system. But the demo has to be pristine for the next
-- person, so the whole dataset is snapshotted once and restored:
--
--   * when the trial user signs OUT      (they finished)
--   * when the trial user signs IN       (the last one just closed the tab
--                                         without signing out, which is what
--                                         actually happens)
--
-- Resetting on sign-IN is the important half. Sign-out is a courtesy; an
-- abandoned session is the normal case, and without the login-side reset
-- the second prospect would inherit the first one's mess.
--
-- HONEST LIMIT: this is ONE shared sandbox, not a private copy each. Two
-- prospects clicking at the same time will see each other's edits, and
-- whoever signs in second wipes the first one's work mid-session. For a
-- link sent to one prospect at a time that is fine. It is not a
-- multi-tenant trial, and should not be sold as one.
--
-- The snapshot lives in its own schema, is owned by the definer, and is
-- NOT exposed to PostgREST — a trial user can wreck `public` all they
-- like and never touch the master copy.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS demo_snapshot;
REVOKE ALL ON SCHEMA demo_snapshot FROM PUBLIC, anon, authenticated;

-- ---- take the snapshot ----------------------------------------------
-- Every public table copied as-is. Run once now, and again by hand after
-- any deliberate change to the seed that should become the new baseline.
CREATE OR REPLACE FUNCTION demo_snapshot_take() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE t text; n int := 0;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS demo_snapshot.%I', t);
    EXECUTE format('CREATE TABLE demo_snapshot.%I AS TABLE public.%I', t, t);
    n := n + 1;
  END LOOP;
  -- Remember where every identity sequence stood, so a restore does not
  -- hand out an id the snapshot already uses.
  DROP TABLE IF EXISTS demo_snapshot._sequences;
  CREATE TABLE demo_snapshot._sequences AS
    SELECT c.table_name, c.column_name,
           pg_get_serial_sequence(c.table_name, c.column_name) AS seq,
           COALESCE(( SELECT last_value FROM pg_sequences s
                       WHERE s.schemaname = 'public'
                         AND s.sequencename = split_part(pg_get_serial_sequence(c.table_name, c.column_name), '.', 2)), 1) AS last_value
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.is_identity = 'YES';
  RETURN n || ' tables snapshotted';
END
$fn$;

-- ---- put it back -----------------------------------------------------
-- SECURITY DEFINER because the caller is a trial user whose own RLS
-- policies would stop them deleting half of this. It takes no arguments
-- and can only ever restore the snapshot, so there is nothing to abuse:
-- the worst a caller can do is undo their own edits.
CREATE OR REPLACE FUNCTION demo_reset() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE
  t   text;
  r   record;
  n   int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'demo_snapshot' AND table_name = 'clients') THEN
    RAISE EXCEPTION 'No snapshot has been taken yet';
  END IF;

  -- One transaction, constraints deferred to the end of it, so the order the
  -- tables are emptied and refilled in does not matter — including the
  -- circular contracts.quote_id -> invoices.id pair.
  --
  -- Deferring is the only route available: DISABLE TRIGGER ALL would also
  -- silence the FK triggers, but those are SYSTEM triggers and Supabase does
  -- not hand out the superuser rights that needs. Every FK was made
  -- DEFERRABLE below for exactly this.
  SET CONSTRAINTS ALL DEFERRED;

  -- ONE truncate naming every table, not sixty deletes. Two reasons: a
  -- TRUNCATE that lists all the referencing tables together does not trip
  -- over foreign keys at all, and Supabase enables pg_safeupdate for this
  -- role, which rejects a DELETE with no WHERE clause outright.
  SELECT string_agg(format('public.%I', tablename), ', ')
    INTO t FROM pg_tables WHERE schemaname = 'public';
  EXECUTE 'TRUNCATE TABLE ' || t;

  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('INSERT INTO public.%I SELECT * FROM demo_snapshot.%I', t, t);
    n := n + 1;
  END LOOP;

  -- Sequences back to where they stood, or the next insert collides.
  FOR r IN SELECT seq, last_value FROM demo_snapshot._sequences WHERE seq IS NOT NULL
  LOOP
    EXECUTE format('SELECT setval(%L, %s)', r.seq, GREATEST(r.last_value, 1));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'tables', n, 'at', now_cairo());
END
$fn$;

-- Only a signed-in user may call it, and only the trial account has any
-- reason to. It is idempotent and destroys nothing but demo edits.
REVOKE ALL ON FUNCTION demo_reset() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_reset() TO authenticated;
REVOKE ALL ON FUNCTION demo_snapshot_take() FROM PUBLIC, anon, authenticated;


-- ---- every foreign key deferrable ------------------------------------
-- INITIALLY IMMEDIATE, so nothing about ordinary operation changes: a bad
-- write still fails on the statement that made it. It only means demo_reset
-- is ALLOWED to defer them for the length of its own transaction, which is
-- what lets it empty and refill 60 tables without a dependency order.
DO $mk$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname, rel.relname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public' AND con.contype = 'f' AND NOT con.condeferrable
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
                   r.relname, r.conname);
  END LOOP;
END
$mk$;
