-- =====================================================================
-- Make the dispatch board worth looking at.
--
-- Two problems with the volume seeded in 14_seed_volume.sql, both of which
-- only show up once the board exists:
--
-- 1. The branch coordinates were laid out as 30.02 + (id%7)*0.012 by
--    31.20 + (id%5)*0.015 — a tidy little lattice about 7 km across, and
--    very nearly collinear. Nearest-neighbour on those points can save
--    almost nothing, so /dispatch/optimize honestly reported "0 km saved"
--    every time and looked broken when it was in fact correct.
--
-- 2. Roughly two visits per engineer per day. A route of two stops has
--    exactly one ordering, so again there is nothing for the optimiser to
--    find, and the month matrix is mostly empty cells.
--
-- So: spread the branches over real Cairo, and give the fortnight ahead
-- enough work that a day is a round rather than an errand. The rule the
-- board enforces most visibly — one branch, one day, one van — is honoured
-- by construction here, or every drag would be refused.
-- =====================================================================

-- ---- distinct branch names ------------------------------------------
-- 14_seed_volume.sql built the name from (id % 10) and (id % 5), which move
-- in lockstep: branch 1 and branch 11 got the same descriptor AND the same
-- locality, so twenty branches carried ten names, each twice. It reads as a
-- bug on the Locations screen, and on an optimised route it looks like the
-- planner has sent the man to the same place twice. Named outright instead.
UPDATE sites s SET name = v.name
FROM (VALUES
  ( 1,'Main Kitchen - Zamalek'),      ( 2,'Lobby Cafe - Downtown'),
  ( 3,'Storage Wing - Dokki'),        ( 4,'Roof Plant - New Cairo'),
  ( 5,'Loading Bay - Mohandessin'),   ( 6,'Staff Canteen - Garden City'),
  ( 7,'Cold Store - Dokki'),          ( 8,'Back Office - Mohandessin'),
  ( 9,'Car Park - New Cairo'),        (10,'Annex - Heliopolis'),
  (11,'Prep Kitchen - Maadi'),        (12,'Reception - Nasr City'),
  (13,'Dry Goods Store - Giza'),      (14,'Rooftop Units - Zamalek'),
  (15,'Service Yard - 6th October'),  (16,'Staff Mess - Sheikh Zayed'),
  (17,'Chiller Room - Maadi'),        (18,'Records Room - Nasr City'),
  (19,'Delivery Dock - Heliopolis'),  (20,'Waste Court - 6th October')
) AS v(id, name)
WHERE s.id = v.id;

-- ---- real coordinates, by area --------------------------------------
-- Each branch sits near the centre of the part of town it belongs to, with
-- a deterministic scatter of roughly ±2 km so no two share a point.
UPDATE sites s SET
  lat = a.lat + ((s.id * 37) % 40 - 20) * 0.0009,
  lng = a.lng + ((s.id * 53) % 40 - 20) * 0.0011
FROM (VALUES
  (1, 29.9660, 30.9450),   -- 6th of October
  (2, 30.0250, 30.9700),   -- Sheikh Zayed
  (3, 29.9600, 31.2570),   -- Maadi
  (4, 30.0590, 31.3300),   -- Nasr City
  (5, 30.0880, 31.3240)    -- Heliopolis
) AS a(area_id, lat, lng)
WHERE s.area_id = a.area_id;

-- The office's own address, so the optimiser has a real start point and the
-- first leg of the round is counted instead of being free.
INSERT INTO settings(key, value) VALUES ('company_geo', '30.0444,31.2357')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;

-- ---- a fuller fortnight ---------------------------------------------
-- Top the next two weeks up so each engineer's working days carry four to
-- six calls. Only branches in an area that engineer is permitted in, only
-- on days the branch is open and the engineer works, and never a branch
-- that already has a visit that day.
WITH candidate AS (
  -- One row per branch per day: the branch, the day, and the ONE engineer
  -- who takes it. Maadi is worked by both men, so without this a branch in
  -- it would be handed to each of them and the very rule the board enforces
  -- most visibly — one branch, one day, one van — would be broken by the
  -- seed itself. The branch's own engineer wins, exactly as the live system
  -- has it: every branch has an owner, and the customer sees the same face.
  SELECT DISTINCT ON (s.id, d.day)
         s.id AS site_id, s.client_id, s.area, d.day, aa.agent_id
    FROM generate_series(current_date + 1, current_date + 14, interval '1 day') d(day)
    CROSS JOIN sites s
    JOIN agent_areas aa ON aa.area_id = s.area_id
   WHERE s.status = 'active'
     -- the branch is open that weekday (no named days = open every day)
     AND (NOT EXISTS (SELECT 1 FROM site_service_days x WHERE x.site_id = s.id)
          OR EXISTS (SELECT 1 FROM site_service_days x
                      WHERE x.site_id = s.id AND x.weekday = app_weekday(d.day::date)))
     -- the engineer works that weekday
     AND EXISTS (SELECT 1 FROM agent_availability av
                  WHERE av.agent_id = aa.agent_id AND av.weekday = app_weekday(d.day::date))
     -- never a branch that already has a visit that day
     AND NOT EXISTS (SELECT 1 FROM visits v
                      WHERE v.site_id = s.id
                        AND left(v.scheduled_start, 10) = to_char(d.day, 'YYYY-MM-DD')
                        AND v.status <> 'cancelled')
     -- a different handful of branches each day, so the fortnight is not the
     -- same round over and over
     AND (s.id + extract(day FROM d.day)::int) % 3 = 0
   ORDER BY s.id, d.day, (aa.agent_id = s.preferred_agent_id) DESC, aa.agent_id
), slotted AS (
  SELECT c.*, row_number() OVER (PARTITION BY c.agent_id, c.day ORDER BY c.site_id) - 1 AS n
    FROM candidate c
)
INSERT INTO visits (site_id, client_id, agent_id, service_type_id,
                    scheduled_start, scheduled_end, status, location, notes)
SELECT site_id, client_id, agent_id,
       1 + (site_id % 7),
       to_char(day, 'YYYY-MM-DD') || ' ' || lpad((9 + n * 2)::text, 2, '0') || ':00:00',
       to_char(day, 'YYYY-MM-DD') || ' ' || lpad((10 + n * 2)::text, 2, '0') || ':00:00',
       'scheduled', area,
       (ARRAY['Routine IPM round','Rodent stations checked and re-baited',
              'Cockroach gel treatment - kitchen line','Fly unit service and lamp change',
              'Quarterly general treatment'])[1 + (site_id % 5)]
FROM slotted
WHERE n < 5;                         -- at most five calls a man a day

-- The visit ids just handed out have to be ahead of the sequence.
SELECT setval(pg_get_serial_sequence('visits', 'id'),
              GREATEST((SELECT max(id) FROM visits), 1));


-- ---- no man in two places at once -----------------------------------
-- The slotting above numbered only the rows IT inserted, so where a branch
-- already had work on that engineer's day the new call landed on top of an
-- existing one — eleven engineer-days ended up with two visits at the same
-- hour. "Never two calls at once" is a wall in roster.py's terms, not a
-- preference, and a board that shows one is showing a round nobody can drive.
--
-- Re-time every non-cancelled visit so each engineer's day runs 09:00,
-- 11:00, 13:00 … in the order the calls were already in. Durations are kept
-- as they were, so a 90-minute job stays a 90-minute job.
WITH ordered AS (
  SELECT v.id,
         left(v.scheduled_start, 10) AS d,
         row_number() OVER (PARTITION BY v.agent_id, left(v.scheduled_start, 10)
                            ORDER BY v.scheduled_start, v.id) - 1 AS n,
         GREATEST(15, COALESCE(
           EXTRACT(epoch FROM (v.scheduled_end::timestamp - v.scheduled_start::timestamp))::int / 60,
           60)) AS dur
    FROM visits v
   WHERE v.agent_id IS NOT NULL AND v.status <> 'cancelled'
     AND v.scheduled_start IS NOT NULL
)
UPDATE visits v SET
  scheduled_start = o.d || ' ' || lpad((9 + o.n * 2)::text, 2, '0') || ':00:00',
  scheduled_end   = to_char((o.d || ' ' || lpad((9 + o.n * 2)::text, 2, '0') || ':00:00')::timestamp
                            + make_interval(mins => o.dur), 'YYYY-MM-DD HH24:MI:SS')
FROM ordered o
WHERE v.id = o.id AND o.n < 6;      -- six calls is a full day; beyond that, leave it alone
