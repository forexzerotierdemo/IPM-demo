-- =====================================================================
-- GET /api/shifts/week — everything the weekly roster grid needs in one
-- call: the seven days, the people to roster, the shift catalogue, the
-- assignments already made, and each engineer's visit count per day so a
-- manager rosters against the real load.
--
-- Ported because the DISPATCH board depends on it, not for its own sake:
-- app.js only renders the day/week/month selector when this call succeeds
-- (`_dp.roster` gates the whole `dp-scope` <select>), so while it 501'd the
-- month matrix — the one view that reads dispatch_grid — was unreachable
-- from the UI no matter how well the grid itself worked.
--
-- A view of the roster, so SECURITY INVOKER again: which people come back
-- is already decided by §6's policy on `users`, and the visit counts by the
-- policy on `visits`.
-- =====================================================================

-- The roster week runs Saturday–Friday. In the app's Mon=0 numbering
-- Saturday is 5, so this steps back to the Saturday on or before the day.
CREATE OR REPLACE FUNCTION roster_week_start(d date) RETURNS date
  LANGUAGE sql IMMUTABLE AS
$fn$ SELECT d - (((app_weekday(d) - 5) % 7 + 7) % 7) $fn$;

CREATE OR REPLACE FUNCTION shift_week(p_start text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE AS
$fn$
DECLARE
  day   date := COALESCE(NULLIF(p_start, '')::date, (now() AT TIME ZONE 'Africa/Cairo')::date);
  first date;
  last  date;
  editable boolean := app_has_perm('shifts.edit');
BEGIN
  IF NOT app_has_perm('shifts.view') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  first := roster_week_start(day);
  last  := first + 6;

  RETURN jsonb_build_object(
    'start', to_char(first, 'YYYY-MM-DD'),
    'end',   to_char(last,  'YYYY-MM-DD'),
    'days',  (SELECT jsonb_agg(to_char(g::date, 'YYYY-MM-DD') ORDER BY g)
                FROM generate_series(first, last, interval '1 day') g),
    'editable', editable,

    -- Who is rostered. A team leader's roster is their team's and their own
    -- line; everyone else who may see the board gets the field staff. An
    -- engineer who may not edit sees only themselves.
    'agents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', u.id, 'full_name', u.full_name,
                                          'role', u.role, 'specialization', u.specialization)
                       ORDER BY (u.role = 'manager'), u.full_name)
        FROM users u
       WHERE u.active = 1
         AND CASE
               WHEN app_role() = 'team_leader'
                 THEN u.id = app_uid() OR u.team_leader_id = app_uid()
               WHEN app_role() = 'agent' AND NOT editable
                 THEN u.id = app_uid()
               ELSE u.role IN ('agent','manager','area_manager','team_leader')
             END), '[]'::jsonb),

    'types', COALESCE((SELECT jsonb_agg(to_jsonb(st) ORDER BY st.sort_order, st.id)
                         FROM shift_types st WHERE st.active = 1), '[]'::jsonb),
    'areas', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.sort_order, a.name_en)
                         FROM areas a WHERE a.active = 1), '[]'::jsonb),

    -- _SHIFT_SELECT, column for column: the shift's own start/end wins over
    -- its type's, which is what from_time/to_time mean on this grid.
    'shifts', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.shift_date, x.from_time)
        FROM (
          SELECT s.*, u.full_name AS agent_name,
                 st.code AS shift_code, st.name_en AS shift_name_en,
                 st.name_ar AS shift_name_ar, st.color AS shift_color, st.is_off AS is_off,
                 ar.name_en AS area_en, ar.name_ar AS area_ar,
                 COALESCE(s.start_time, st.start_time) AS from_time,
                 COALESCE(s.end_time,   st.end_time)   AS to_time
            FROM agent_shifts s
            JOIN users u ON u.id = s.agent_id
            JOIN shift_types st ON st.id = s.shift_type_id
            LEFT JOIN areas ar ON ar.id = s.area_id
           WHERE s.shift_date BETWEEN to_char(first, 'YYYY-MM-DD') AND to_char(last, 'YYYY-MM-DD')
        ) x), '[]'::jsonb),

    -- "agent|date" -> count, so the grid can show the real load per cell.
    -- Only if the caller may see visits at all.
    'visit_load', CASE WHEN app_has_perm('visits.view') THEN COALESCE((
      SELECT jsonb_object_agg(v.agent_id || '|' || v.d, v.n)
        FROM (SELECT agent_id, left(scheduled_start, 10) AS d, count(*) AS n
                FROM visits
               WHERE agent_id IS NOT NULL AND status <> 'cancelled'
                 AND left(scheduled_start, 10)
                     BETWEEN to_char(first, 'YYYY-MM-DD') AND to_char(last, 'YYYY-MM-DD')
               GROUP BY agent_id, left(scheduled_start, 10)) v), '{}'::jsonb)
      ELSE '{}'::jsonb END
  );
END
$fn$;


-- ---- a roster to look at --------------------------------------------
-- agent_shifts was never seeded, so the week grid came back with an empty
-- `shifts` array and the dispatch board's shift filter had nothing in it.
-- Put both engineers on the day shift across the Cairo working week, for
-- the month either side of today.
INSERT INTO agent_shifts (agent_id, shift_date, shift_type_id, area_id, start_time, end_time)
SELECT a.agent_id,
       to_char(d, 'YYYY-MM-DD'),
       1,                                   -- Day
       -- The patch he is on that day: his own areas, taken in turn, so the
       -- board shows a man moving round his ground rather than parked.
       (SELECT aa.area_id FROM agent_areas aa
         WHERE aa.agent_id = a.agent_id
         ORDER BY aa.area_id
         OFFSET (extract(day FROM d)::int % GREATEST(1,
                 (SELECT count(*) FROM agent_areas x WHERE x.agent_id = a.agent_id)))
         LIMIT 1),
       '09:00', '17:00'
FROM generate_series(current_date - 21, current_date + 21, interval '1 day') d
CROSS JOIN (SELECT unnest(ARRAY[5,6]) AS agent_id) a
WHERE EXISTS (SELECT 1 FROM agent_availability av
               WHERE av.agent_id = a.agent_id AND av.weekday = app_weekday(d::date))
  AND NOT EXISTS (SELECT 1 FROM agent_shifts s
                   WHERE s.agent_id = a.agent_id
                     AND s.shift_date = to_char(d, 'YYYY-MM-DD'));

SELECT setval(pg_get_serial_sequence('agent_shifts', 'id'),
              GREATEST((SELECT max(id) FROM agent_shifts), 1));
