-- =====================================================================
-- THE QR SCAN CHAIN, end to end.
--
-- A trap carries a printed label — LIT0001, GLU0062 — encoding the URL
-- <host>/scan/<CODE>. An engineer points a phone at it and lands on the
-- device: who it belongs to, what was found here before, and what the LAST
-- visit promised to do about it. They file this visit's finding, and that
-- finding is what the follow-up report prints.
--
-- Four routes carry it, none of which existed here yet:
--
--   GET  /scan/<CODE>            what the engineer sees on landing
--   POST /scan/<CODE>            file this visit's inspection
--   GET  /devices/<id>/history   the whole file for one trap
--   GET  /visits/<id>/devices    coverage: scanned vs still to do
--   GET  /visits/<id>/followup   THE REPORT — every trap read on this visit
--
-- Appendix C marks the scan routes "PostgREST", which is optimistic: they
-- resolve a printed code to a device, decide which visit the scan belongs
-- to, and whitelist per-type follow-up fields. That is a function.
-- =====================================================================

-- ---- the per-type follow-up fields -----------------------------------
-- DEVICE_FIELD_KEYS from server.py, as data. The phone renders inputs from
-- its own equivalent map; anything not listed for a type is dropped here,
-- so a hand-made request cannot stuff arbitrary keys into the record.
CREATE OR REPLACE FUNCTION device_field_keys(p_type text) RETURNS text[]
  LANGUAGE sql IMMUTABLE AS
$fn$
  SELECT CASE p_type
    WHEN 'bait_station' THEN ARRAY['bait_status','bait_action','consumption_pct',
                                   'station_condition','station_action','cleaned','cleaned_action']
    WHEN 'fly_trap'     THEN ARRAY['washed','water_refilled','trap_condition',
                                   'trap_action','fly_density']
    WHEN 'glue_station' THEN ARRAY['glue_status','glue_action','insect_count','pests_found',
                                   'station_condition','station_action','cleaned']
    WHEN 'light_trap'   THEN ARRAY['trap_condition','trap_action','electricity',
                                   'electricity_action','lamp_status','lamp_action',
                                   'trans_light_status','trans_light_action',
                                   'sheet_status','sheet_action','fly_count','pests_found']
    ELSE ARRAY[]::text[] END
$fn$;

-- Keep only the whitelisted keys, coercing the numeric ones. Returns NULL
-- when nothing usable was sent, so the column stays empty rather than '{}'.
CREATE OR REPLACE FUNCTION clean_device_details(p_type text, p_raw jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE AS
$fn$
  SELECT NULLIF(COALESCE(jsonb_object_agg(k, v), '{}'::jsonb), '{}'::jsonb)::text
    FROM (
      SELECT e.key AS k,
             CASE WHEN e.key IN ('consumption_pct','fly_density','fly_count','insect_count')
                  THEN to_jsonb(NULLIF(regexp_replace(e.value #>> '{}', '[^0-9.\-]', '', 'g'), '')::numeric)
                  -- pests_found is a tick-list: keep it as the comma-joined
                  -- string the report and the analytics rollups both read.
                  WHEN e.key = 'pests_found' AND jsonb_typeof(e.value) = 'array'
                  THEN to_jsonb((SELECT string_agg(x #>> '{}', ',')
                                   FROM jsonb_array_elements(e.value) x))
                  ELSE e.value END AS v
        FROM jsonb_each(COALESCE(p_raw, '{}'::jsonb)) e
       WHERE e.key = ANY (device_field_keys(p_type))
         AND e.value IS NOT NULL
         AND e.value <> 'null'::jsonb
         AND (e.value #>> '{}') <> ''
    ) q
$fn$;

-- ---- what the last visit promised --------------------------------------
-- An engineer can defer a fix to "next visit". Only the NEWEST scan is
-- consulted: a later scan either did the work or promised it again, so it
-- is always the current word on the trap.
CREATE OR REPLACE FUNCTION promised_actions(p_details text, p_at text) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS
$fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'field', m.field, 'action', d.j ->> m.field,
           'fault', d.j ->> m.parent, 'at', p_at)), '[]'::jsonb)
    FROM (SELECT CASE WHEN COALESCE(p_details,'') = '' THEN '{}'::jsonb
                      ELSE p_details::jsonb END AS j) d,
         (VALUES ('trap_action','trap_condition'), ('lamp_action','lamp_status'),
                 ('trans_light_action','trans_light_status'), ('sheet_action','sheet_status'),
                 ('station_action','station_condition'), ('electricity_action','electricity'),
                 ('bait_action','bait_status'), ('glue_action','glue_status'),
                 ('cleaned_action','cleaned')) AS m(field, parent)
   WHERE d.j ->> m.field LIKE 'next_visit%'
$fn$;

-- The visit a scan attaches to: an in-progress visit at this client,
-- preferring one the scanning engineer owns. NULL if there isn't one.
CREATE OR REPLACE FUNCTION agent_active_visit(p_client_id bigint) RETURNS bigint
  LANGUAGE sql STABLE AS
$fn$
  SELECT v.id FROM visits v
   WHERE v.client_id = p_client_id AND v.status = 'in_progress'
   ORDER BY (v.agent_id = app_uid()) DESC, v.scheduled_start DESC
   LIMIT 1
$fn$;


-- ------------------------------------------------- GET /scan/<CODE>
-- Landing data when a printed device code is scanned: identity, the recent
-- trail, which in-progress visit this scan would file against, and what the
-- last visit left for this one.
CREATE OR REPLACE FUNCTION scan_lookup(p_code text) RETURNS jsonb
  LANGUAGE plpgsql STABLE AS
$fn$
DECLARE d record; hist jsonb;
BEGIN
  IF app_role() <> 'client' AND NOT app_has_perm('maps.view') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  -- RLS on `devices` already decides whether this caller may see it: a
  -- portal login only reaches its own traps, an area manager only their
  -- patch's. An unreachable code is simply unknown.
  SELECT dv.*, c.name_en AS client_en, c.name_ar AS client_ar, s.name AS site_name
    INTO d
    FROM devices dv
    LEFT JOIN clients c ON c.id = dv.client_id
    LEFT JOIN sites s ON s.id = dv.site_id
   WHERE upper(dv.code) = upper(btrim(p_code));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown device code';
  END IF;

  -- `details` stays a STRING: app.js does JSON.parse(h.details) itself.
  SELECT COALESCE(jsonb_agg(h ORDER BY h.recorded_at DESC, h.id DESC), '[]'::jsonb)
    INTO hist
    FROM (SELECT di.id, di.status, di.findings, di.note, di.source, di.lat, di.lng,
                 di.recorded_at, di.visit_id, di.details, u.full_name AS recorded_by_name
            FROM device_inspections di
            LEFT JOIN users u ON u.id = di.recorded_by
           WHERE di.device_id = d.id
           ORDER BY di.recorded_at DESC, di.id DESC
           LIMIT 20) h;

  RETURN jsonb_build_object(
    'id', d.id, 'code', d.code, 'type', d.type, 'label', d.label,
    'placement', d.placement, 'status', d.status, 'active', d.active,
    'client_id', d.client_id, 'site_id', d.site_id,
    'client_en', d.client_en, 'client_ar', d.client_ar, 'site_name', d.site_name,
    'history', hist,
    'active_visit_id', CASE WHEN app_role() <> 'client'
                            THEN agent_active_visit(d.client_id) END,
    'promised', promised_actions(hist -> 0 ->> 'details', hist -> 0 ->> 'recorded_at'));
END
$fn$;


-- ------------------------------------------------ POST /scan/<CODE>
-- File one trap's inspection against a visit. This is the scan-to-report
-- action: what it writes here is what the follow-up report prints.
CREATE OR REPLACE FUNCTION scan_record(
  p_code text, p_status text DEFAULT 'ok',
  p_findings text DEFAULT NULL, p_note text DEFAULT NULL,
  p_visit_id bigint DEFAULT NULL,
  p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL,
  p_details jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS
$fn$
DECLARE d record; vid bigint; det text;
BEGIN
  IF NOT app_has_perm('maps.edit') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  IF p_status NOT IN ('ok','activity','needs_service','missing') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  SELECT dv.id, dv.code, dv.type, dv.client_id INTO d
    FROM devices dv WHERE upper(dv.code) = upper(btrim(p_code));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown device code';
  END IF;
  IF d.client_id IS NULL THEN
    RAISE EXCEPTION 'Device not assigned to a client yet';
  END IF;

  vid := COALESCE(p_visit_id, agent_active_visit(d.client_id));
  -- A visit that is not this client's is ignored rather than refused: the
  -- scan is still real, it simply files without a visit.
  IF vid IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM visits v WHERE v.id = vid AND v.client_id = d.client_id) THEN
    vid := NULL;
  END IF;

  det := clean_device_details(d.type, p_details);

  UPDATE devices SET status = p_status WHERE id = d.id;
  INSERT INTO device_inspections(device_id, visit_id, client_id, status, findings,
                                 note, source, lat, lng, recorded_by, details)
  VALUES (d.id, vid, d.client_id, p_status,
          NULLIF(btrim(COALESCE(p_findings, '')), ''),
          NULLIF(btrim(COALESCE(p_note, '')), ''),
          'scan', p_lat, p_lng, app_uid(), det);

  RETURN jsonb_build_object('ok', true, 'status', p_status,
                            'code', d.code, 'visit_id', vid);
END
$fn$;


-- --------------------------------------- GET /devices/<id>/history
-- The whole file for one trap. The scan screen shows the recent few; this is
-- everything, for the visit that needs to know what happened here last spring.
CREATE OR REPLACE FUNCTION device_history(p_id bigint) RETURNS jsonb
  LANGUAGE plpgsql STABLE AS
$fn$
DECLARE d record; hist jsonb;
BEGIN
  IF app_role() <> 'client' AND NOT app_has_perm('maps.view') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  SELECT dv.*, c.name_en AS client_en, c.name_ar AS client_ar, s.name AS site_name
    INTO d FROM devices dv
    LEFT JOIN clients c ON c.id = dv.client_id
    LEFT JOIN sites s ON s.id = dv.site_id
   WHERE dv.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Device not found';
  END IF;

  SELECT COALESCE(jsonb_agg(h ORDER BY h.recorded_at DESC, h.id DESC), '[]'::jsonb)
    INTO hist
    FROM (SELECT di.id, di.status, di.findings, di.note, di.source, di.lat, di.lng,
                 di.recorded_at, di.visit_id, di.details, u.full_name AS recorded_by_name
            FROM device_inspections di
            LEFT JOIN users u ON u.id = di.recorded_by
           WHERE di.device_id = p_id) h;

  RETURN to_jsonb(d) || jsonb_build_object('history', hist,
                                           'scans', jsonb_array_length(hist));
END
$fn$;


-- ---------------------------------------- GET /visits/<id>/devices
-- Per-visit coverage: how many of this client's traps were read on this
-- visit, and which are still pending. The engineer's checklist.
CREATE OR REPLACE FUNCTION visit_devices(p_visit_id bigint) RETURNS jsonb
  LANGUAGE plpgsql STABLE AS
$fn$
DECLARE v record; devs jsonb;
BEGIN
  SELECT vi.id, vi.client_id, vi.site_id INTO v FROM visits vi WHERE vi.id = p_visit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Visit not found';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', q.id, 'code', q.code, 'type', q.type, 'label', q.label,
           'placement', q.placement, 'status', q.status, 'scanned_at', q.scanned_at)
         ORDER BY q.type, q.code), '[]'::jsonb)
    INTO devs
    FROM (SELECT d.id, d.code, d.type, d.label, d.placement, d.status,
                 (SELECT max(di.recorded_at) FROM device_inspections di
                   WHERE di.device_id = d.id AND di.visit_id = p_visit_id) AS scanned_at
            FROM devices d
           WHERE d.client_id = v.client_id AND d.active = 1
             AND (v.site_id IS NULL OR d.site_id = v.site_id OR d.site_id IS NULL)) q;

  RETURN jsonb_build_object(
    'total', jsonb_array_length(devs),
    'scanned', (SELECT count(*) FROM jsonb_array_elements(devs) e
                 WHERE e ->> 'scanned_at' IS NOT NULL),
    'devices', devs);
END
$fn$;


-- --------------------------------------- GET /visits/<id>/followup
-- THE REPORT. The printable follow-up sheet: the visit header, then every
-- trap read on THIS visit grouped by type, each with the fields the engineer
-- filled in at it. This is the proof-of-visit the customer is handed, and it
-- is the reason the scan exists at all.
CREATE OR REPLACE FUNCTION visit_followup(p_visit_id bigint) RETURNS jsonb
  LANGUAGE plpgsql STABLE AS
$fn$
DECLARE v jsonb; groups jsonb;
BEGIN
  IF NOT app_has_perm('visits.view') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  SELECT to_jsonb(x) INTO v FROM (
    SELECT vv.id, vv.scheduled_start, vv.visit_number, vv.client_id, vv.site_id,
           vv.client_en, vv.client_ar, vv.agent_name, vv.site_name
      FROM v_visits vv WHERE vv.id = p_visit_id) x;
  IF v IS NULL THEN
    RAISE EXCEPTION 'Visit not found';
  END IF;

  -- The LATEST inspection per device on this visit: an engineer who scans a
  -- trap twice has corrected themselves, and the sheet prints the correction.
  SELECT COALESCE(jsonb_object_agg(g.type, g.rows), '{}'::jsonb) INTO groups
    FROM (
      SELECT r.type,
             jsonb_agg(jsonb_build_object(
               'code', r.code, 'type', r.type, 'label', r.label,
               'status', r.status, 'findings', r.findings,
               'recorded_at', r.recorded_at,
               -- app.js json.loads()es this server-side, so the follow-up
               -- sheet wants details as an OBJECT, not the string the scan
               -- screen parses itself.
               'details', CASE WHEN COALESCE(r.details,'') = '' THEN '{}'::jsonb
                               ELSE r.details::jsonb END)
             ORDER BY r.code) AS rows
        FROM (
          SELECT DISTINCT ON (di.device_id)
                 d.code, d.type, d.label, di.status, di.findings, di.details, di.recorded_at
            FROM device_inspections di
            JOIN devices d ON d.id = di.device_id
           WHERE di.visit_id = p_visit_id
           ORDER BY di.device_id, di.id DESC) r
       GROUP BY r.type) g;

  RETURN jsonb_build_object('visit', v, 'groups', groups);
END
$fn$;
