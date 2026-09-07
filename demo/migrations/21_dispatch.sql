-- =====================================================================
-- The dispatch board: /dispatch/grid, /cell, /sla and /move.
--
-- All four are SQL rather than Edge Functions — §9.1's own advice, and it
-- matters more here than anywhere else: every one of them is a counting or
-- a scoping question, and SECURITY INVOKER means the caller's §6 policies
-- do the scoping for free. A supervisor's board is their patch's because
-- `visits` says so, not because this file remembers to ask.
--
-- WEEKDAY NUMBERING. app.js and roster.py both use Python's date.weekday():
-- Mon=0 … Sun=6 (see the WD table in app.js, and _WEEKDAYS in server.py).
-- Postgres extract(dow) is Sun=0 … Sat=6. Everything below converts with
-- app_weekday(); getting this wrong silently refuses every move.
-- =====================================================================

CREATE OR REPLACE FUNCTION app_weekday(d date) RETURNS int
  LANGUAGE sql IMMUTABLE AS
$fn$ SELECT ((extract(dow FROM d)::int + 6) % 7) $fn$;

-- The seeded rota was written in Postgres' numbering by mistake, so the
-- branches accepted Mon–Fri while the seeded visits fall Sun–Thu (the Cairo
-- week). Every drag onto a Sunday would have been refused with "not open on
-- a Sunday", which reads like a broken board rather than a rule. Restate
-- both rotas in the app's numbering: Sun,Mon,Tue,Wed,Thu = 6,0,1,2,3.
DELETE FROM site_service_days;
INSERT INTO site_service_days(site_id, weekday, start_time, end_time, agent_id)
SELECT s.id, w, '09:00', '17:00', s.preferred_agent_id
FROM sites s, unnest(ARRAY[6,0,1,2,3]) w
WHERE (s.id + w) % 3 <> 1;          -- most days open, a few not

DELETE FROM agent_availability;
INSERT INTO agent_availability(agent_id, weekday, start_time, end_time)
SELECT a, w, '09:00', '17:00'
FROM unnest(ARRAY[5,6]) a, unnest(ARRAY[6,0,1,2,3]) w;

-- Which parts of town each engineer is permitted in. Deliberately OVERLAPPING
-- rather than split down the middle: Maadi (3) is worked by both, so the board
-- can hand a Maadi call from one man to the other, while a 6th-of-October call
-- still refuses to go to the east-side engineer. A disjoint split would make
-- every cross-engineer drag fail and the board would read as broken rather
-- than as enforcing a rule.
DELETE FROM agent_areas;
INSERT INTO agent_areas(agent_id, area_id, weekdays) VALUES
  (5,1,''), (5,2,''), (5,3,''),          -- October, Zayed, Maadi
  (6,3,''), (6,4,''), (6,5,'');          -- Maadi, Nasr City, Heliopolis


-- ---------------------------------------------------------------- grid
-- THE BOARD FOR A WHOLE MONTH, counted on this side of the wire.
-- A month of the office's book is 823 visits; a grid needs none of the GPS,
-- the notes or the bilingual area names that a visit row carries. So the
-- counting happens here and what crosses is one small cell per engineer per
-- day: how many calls, and the first and last hour of them. Days a man is
-- not out have no cell at all.
CREATE OR REPLACE FUNCTION dispatch_grid(
  p_from text, p_to text, p_agent bigint DEFAULT NULL, p_area bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE AS
$fn$
DECLARE d_from date; d_to date;
BEGIN
  IF NOT app_has_perm('dispatch.view') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  d_from := p_from::date;
  d_to   := COALESCE(NULLIF(p_to, '')::date, d_from);
  IF d_to - d_from > 62 THEN
    RAISE EXCEPTION 'Ask for at most two months at a time';
  END IF;

  RETURN jsonb_build_object(
    'from', to_char(d_from, 'YYYY-MM-DD'),
    'to',   to_char(d_to,   'YYYY-MM-DD'),
    'days', (SELECT COALESCE(jsonb_agg(to_char(g::date, 'YYYY-MM-DD') ORDER BY g), '[]'::jsonb)
               FROM generate_series(d_from, d_to, interval '1 day') g),
    -- The board is the engineers' board: role='agent', as dispatch_grid has
    -- it. A supervisor appears on it only if they carry visits themselves.
    'engineers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'full_name', u.full_name)
                                            ORDER BY u.full_name), '[]'::jsonb)
                    FROM users u
                   WHERE u.role = 'agent' AND u.active = 1
                     AND (p_agent IS NULL OR u.id = p_agent)),
    'cells', COALESCE((
      SELECT jsonb_agg(c ORDER BY (c->>'agent_id')::bigint, c->>'date')
        FROM (
          SELECT jsonb_build_object(
                   'agent_id', v.agent_id,
                   'date',  left(v.scheduled_start, 10),
                   'count', count(*),
                   'first', min(substr(v.scheduled_start, 12, 5)),
                   'last',  max(substr(v.scheduled_start, 12, 5))) AS c
            FROM visits v
            LEFT JOIN sites s ON s.id = v.site_id
           WHERE v.agent_id IS NOT NULL
             AND left(v.scheduled_start, 10) BETWEEN to_char(d_from, 'YYYY-MM-DD')
                                                 AND to_char(d_to,   'YYYY-MM-DD')
             AND (p_agent IS NULL OR v.agent_id = p_agent)
             -- A visit whose branch has no area never matches an area filter,
             -- exactly as the Python `str(r["area_id"] or "") != str(want_area)`.
             AND (p_area IS NULL OR s.area_id = p_area)
             AND EXISTS (SELECT 1 FROM users u
                          WHERE u.id = v.agent_id AND u.role = 'agent' AND u.active = 1)
           GROUP BY v.agent_id, left(v.scheduled_start, 10)
        ) x), '[]'::jsonb)
  );
END
$fn$;


-- ---------------------------------------------------------------- cell
-- ONE ENGINEER, ONE DAY — the visits themselves, small enough to open on a
-- phone. A month cell can only carry a count and two times; this is what it
-- opens into, and what the office actually drags: one call at a time.
CREATE OR REPLACE FUNCTION dispatch_cell(p_date text, p_agent bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE AS
$fn$
BEGIN
  IF NOT app_has_perm('dispatch.view') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  IF p_agent IS NULL THEN
    RAISE EXCEPTION 'Which engineer?';
  END IF;

  RETURN jsonb_build_object(
    'date', to_char(p_date::date, 'YYYY-MM-DD'),
    'agent_id', p_agent,
    'visits', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', v.id,
               'time', substr(v.scheduled_start, 12, 5),
               'site_name', COALESCE(s.name, ''),
               'status', v.status,
               'area_id', s.area_id) ORDER BY v.scheduled_start)
        FROM visits v LEFT JOIN sites s ON s.id = v.site_id
       WHERE v.agent_id = p_agent
         AND left(v.scheduled_start, 10) = to_char(p_date::date, 'YYYY-MM-DD')), '[]'::jsonb)
  );
END
$fn$;


-- ----------------------------------------------------------------- sla
-- The strip above the board. sla_rows() (19_cockpit.sql) is SECURITY
-- INVOKER, so a portal login already sees only its own contracts and this
-- needs no role branch of its own.
CREATE OR REPLACE FUNCTION dispatch_sla() RETURNS jsonb
  LANGUAGE sql STABLE AS
$fn$
  SELECT jsonb_build_object(
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.days_since DESC)
                         FROM sla_rows() r), '[]'::jsonb),
    -- All three tiers always present: app.js reads sla.counts.overdue directly.
    'counts', jsonb_build_object('ok', 0, 'due_soon', 0, 'overdue', 0)
              || COALESCE((SELECT jsonb_object_agg(status, n)
                             FROM (SELECT status, count(*) n FROM sla_rows() GROUP BY status) x),
                          '{}'::jsonb))
$fn$;


-- ---------------------------------------------------------------- move
-- Move work to another engineer or another day, IF IT CAN BE DRIVEN.
--
-- All or nothing: a move the planner would refuse is refused here too, with
-- the reason, and the diary is left exactly as it was. The refusal is the
-- useful part — app.js alerts the message verbatim, so each one names the
-- rule that stopped it.
--
-- WHAT IS CHECKED HERE vs. WHAT IS NOT. Every rule below is a WALL in
-- roster.py's terms — area permission, the engineer's hours, the branch's
-- opening days, one-branch-one-day-one-van — and each is a plain question
-- about a row, so it ports exactly. What is NOT ported is the last pass of
-- _move_refusal: `Day._sequence`, which fits the whole round together
-- against the travel ceiling. That is the planner's own timing code and
-- §9.3 says not to reimplement it. The consequence is honest and worth
-- knowing: this board will accept a round that the real planner might still
-- refuse as undrivable. It never accepts one that breaks a wall.
CREATE OR REPLACE FUNCTION dispatch_move(
  p_visit_ids bigint[], p_agent_id bigint, p_date text)
RETURNS jsonb LANGUAGE plpgsql AS
$fn$
DECLARE
  d          date;
  wd         int;
  wd_name    text;
  person     users%ROWTYPE;
  v          visits%ROWTYPE;
  branch     sites%ROWTYPE;
  area_days  text;
  keep       text;
  dur        int;
  n          int := 0;
BEGIN
  IF NOT app_has_perm('dispatch.view') OR NOT app_has_perm('visits.edit') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  IF p_visit_ids IS NULL OR array_length(p_visit_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Nothing to move';
  END IF;
  IF array_length(p_visit_ids, 1) > 40 THEN
    RAISE EXCEPTION 'Too many visits in one move';
  END IF;
  IF p_agent_id IS NULL THEN
    RAISE EXCEPTION 'Which engineer?';
  END IF;

  d  := p_date::date;
  wd := app_weekday(d);
  wd_name := (ARRAY['Monday','Tuesday','Wednesday','Thursday',
                    'Friday','Saturday','Sunday'])[wd + 1];

  SELECT * INTO person FROM users WHERE id = p_agent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That engineer is not on the board.';
  END IF;

  -- ---- every rule, before a single row is written --------------------
  FOREACH n IN ARRAY p_visit_ids LOOP
    SELECT * INTO v FROM visits WHERE id = n;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Visit not found';
    END IF;

    SELECT * INTO branch FROM sites WHERE id = v.site_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That visit has no branch to place.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM agent_availability a
                    WHERE a.agent_id = person.id) THEN
      RAISE EXCEPTION '% has no working hours on the board.', person.full_name;
    END IF;

    SELECT aa.weekdays INTO area_days
      FROM agent_areas aa
     WHERE aa.agent_id = person.id AND aa.area_id = branch.area_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '% is not permitted in %''s area.', person.full_name, branch.name;
    END IF;
    -- agent_areas.weekdays empty means "any day he works"; otherwise the day
    -- must be named in it. This is roster.py's may_work().
    IF COALESCE(area_days, '') <> ''
       AND NOT (wd::text = ANY (string_to_array(area_days, ','))) THEN
      RAISE EXCEPTION '% does not work that area on a %.', person.full_name, wd_name;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM agent_availability a
                    WHERE a.agent_id = person.id AND a.weekday = wd) THEN
      RAISE EXCEPTION '% does not work on a %.', person.full_name, wd_name;
    END IF;

    -- opens_on(): a branch with NO named days is open every day.
    IF EXISTS (SELECT 1 FROM site_service_days sd WHERE sd.site_id = branch.id)
       AND NOT EXISTS (SELECT 1 FROM site_service_days sd
                        WHERE sd.site_id = branch.id AND sd.weekday = wd) THEN
      RAISE EXCEPTION '% is not open on a %.', branch.name, wd_name;
    END IF;

    -- ONE BRANCH, ONE DAY, ONE MAN — across every engineer, not just this one.
    IF EXISTS (SELECT 1 FROM visits x
                WHERE x.site_id = branch.id
                  AND left(x.scheduled_start, 10) = to_char(d, 'YYYY-MM-DD')
                  AND x.id <> v.id AND x.status <> 'cancelled') THEN
      RAISE EXCEPTION '% already has a visit that day — one branch, one day, one van.',
                      branch.name;
    END IF;
  END LOOP;

  -- ---- ...and only then the diary ------------------------------------
  FOREACH n IN ARRAY p_visit_ids LOOP
    SELECT * INTO v FROM visits WHERE id = n;
    keep := COALESCE(NULLIF(substr(v.scheduled_start, 12, 5), ''), '09:00');
    dur  := GREATEST(15, COALESCE(
              EXTRACT(epoch FROM (v.scheduled_end::timestamp - v.scheduled_start::timestamp))::int / 60,
              60));
    UPDATE visits SET
      agent_id = p_agent_id,
      scheduled_start = to_char(d, 'YYYY-MM-DD') || ' ' || keep || ':00',
      scheduled_end = to_char((to_char(d, 'YYYY-MM-DD') || ' ' || keep || ':00')::timestamp
                              + make_interval(mins => dur), 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = n;
  END LOOP;

  RETURN jsonb_build_object('moved', array_length(p_visit_ids, 1),
                            'agent_id', p_agent_id,
                            'date', to_char(d, 'YYYY-MM-DD'));
END
$fn$;
