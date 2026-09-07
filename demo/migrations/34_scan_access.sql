-- =====================================================================
-- THE SCAN ENDPOINTS RUN AS DEFINER, ON PURPOSE.
--
-- 33_qr_scan.sql got the access model wrong. Those functions were SECURITY
-- INVOKER, so reading `devices` went through §6.2's policy — which gates
-- that table on `devices.view`. An agent does NOT hold devices.view: the
-- permission catalogue gives them `maps.view` and `maps.edit` instead. That
-- split is deliberate in the live system — an engineer reads traps in the
-- field but does not get the device registry admin screen — and it meant
-- every scan by an engineer came back "Unknown device code". Which is the
-- one person the whole feature exists for.
--
-- So these mirror server.py exactly: SECURITY DEFINER to reach the
-- registry, with the permission and client-access checks written out.
-- =====================================================================

-- ---- the access rules, as functions ---------------------------------
-- _assert_client_access(): a portal login is pinned to its own company; a
-- supervisor to the clients their patch or crew covers; everyone else in the
-- office passes. Note an AGENT passes — the live rule does not narrow them
-- here, because an engineer may legitimately be sent anywhere.
CREATE OR REPLACE FUNCTION app_covers_client(p_client_id bigint) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$fn$
  SELECT CASE app_role()
    WHEN 'client' THEN p_client_id = app_client_id()
    WHEN 'area_manager' THEN EXISTS (
      -- the same rule the client list applies: a client sitting in one of
      -- their areas, or one their people are actually sent to
      SELECT 1 FROM clients c WHERE c.id = p_client_id
        AND (c.area_id IN (SELECT app_area_ids())
             OR EXISTS (SELECT 1 FROM sites s
                         WHERE s.client_id = c.id
                           AND s.area_id IN (SELECT app_area_ids()))
             OR EXISTS (SELECT 1 FROM visits v
                         WHERE v.client_id = c.id AND v.agent_id = app_uid())))
    WHEN 'team_leader' THEN EXISTS (
      SELECT 1 FROM visits v
       WHERE v.client_id = p_client_id AND v.agent_id IN (SELECT app_team_ids()))
    ELSE app_role() IS NOT NULL
  END
$fn$;

-- _assert_visit_access(): own company and own branch for a portal login,
-- own round for an engineer, own patch or crew for a supervisor.
CREATE OR REPLACE FUNCTION app_can_see_visit(p_visit_id bigint) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$fn$
  SELECT EXISTS (
    SELECT 1 FROM visits v WHERE v.id = p_visit_id
      AND (app_site_id() IS NULL OR v.site_id IS NULL OR v.site_id = app_site_id())
      AND CASE app_role()
            WHEN 'client'       THEN v.client_id = app_client_id()
            WHEN 'agent'        THEN v.agent_id = app_uid()
            WHEN 'team_leader'  THEN v.agent_id IN (SELECT app_team_ids())
            WHEN 'area_manager' THEN app_site_area_id(v.site_id) IN (SELECT app_area_ids())
                                     OR v.agent_id = app_uid()
            ELSE app_role() IS NOT NULL
          END)
$fn$;


-- ------------------------------------------------- GET /scan/<CODE>
CREATE OR REPLACE FUNCTION scan_lookup(p_code text) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE d record; hist jsonb;
BEGIN
  -- A portal login may read a trap without maps.view — that is how a
  -- customer checks their own bait station. Everyone else needs it.
  IF app_role() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF app_role() <> 'client' AND NOT app_has_perm('maps.view') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  SELECT dv.*, c.name_en AS client_en, c.name_ar AS client_ar, s.name AS site_name
    INTO d
    FROM devices dv
    LEFT JOIN clients c ON c.id = dv.client_id
    LEFT JOIN sites s ON s.id = dv.site_id
   WHERE upper(dv.code) = upper(btrim(p_code));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown device code';
  END IF;

  IF d.client_id IS NOT NULL AND NOT app_covers_client(d.client_id) THEN
    RAISE EXCEPTION 'No permission';
  END IF;
  -- A portal login pinned to one branch only ever sees that branch's traps.
  IF app_site_id() IS NOT NULL AND d.site_id IS NOT NULL
     AND d.site_id <> app_site_id() THEN
    RAISE EXCEPTION 'No permission';
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
CREATE OR REPLACE FUNCTION scan_record(
  p_code text, p_status text DEFAULT 'ok',
  p_findings text DEFAULT NULL, p_note text DEFAULT NULL,
  p_visit_id bigint DEFAULT NULL,
  p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL,
  p_details jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE d record; vid bigint; det text;
BEGIN
  -- maps.edit, which a portal login does not hold: a customer may look at a
  -- trap's history but never file a reading against it.
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
  IF NOT app_covers_client(d.client_id) THEN
    RAISE EXCEPTION 'No permission';
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
CREATE OR REPLACE FUNCTION device_history(p_id bigint) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE d record; hist jsonb;
BEGIN
  IF app_role() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
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
  IF d.client_id IS NOT NULL AND NOT app_covers_client(d.client_id) THEN
    RAISE EXCEPTION 'No permission';
  END IF;
  IF app_site_id() IS NOT NULL AND d.site_id IS NOT NULL
     AND d.site_id <> app_site_id() THEN
    RAISE EXCEPTION 'No permission';
  END IF;

  SELECT COALESCE(jsonb_agg(h ORDER BY h.recorded_at DESC, h.id DESC), '[]'::jsonb)
    INTO hist
    FROM (SELECT di.id, di.status, di.findings, di.note, di.source, di.lat, di.lng,
                 di.recorded_at, di.visit_id, di.details, u.full_name AS recorded_by_name
            FROM device_inspections di
            LEFT JOIN users u ON u.id = di.recorded_by
           WHERE di.device_id = p_id) h;

  RETURN to_jsonb(d) - 'created_at' || jsonb_build_object(
    'history', hist, 'scans', jsonb_array_length(hist));
END
$fn$;


-- ---------------------------------------- GET /visits/<id>/devices
-- The engineer's checklist for the visit they are on. Gated on seeing the
-- VISIT, not on devices.view — the same reason as the scan itself.
CREATE OR REPLACE FUNCTION visit_devices(p_visit_id bigint) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE v record; devs jsonb;
BEGIN
  SELECT vi.id, vi.client_id, vi.site_id INTO v FROM visits vi WHERE vi.id = p_visit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Visit not found';
  END IF;
  IF NOT app_can_see_visit(p_visit_id) THEN
    RAISE EXCEPTION 'No permission';
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
CREATE OR REPLACE FUNCTION visit_followup(p_visit_id bigint) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE v jsonb; groups jsonb;
BEGIN
  IF NOT app_has_perm('visits.view') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  IF NOT app_can_see_visit(p_visit_id) THEN
    RAISE EXCEPTION 'No permission';
  END IF;

  SELECT to_jsonb(x) INTO v FROM (
    SELECT vv.id, vv.scheduled_start, vv.visit_number, vv.client_id, vv.site_id,
           c.name_en AS client_en, c.name_ar AS client_ar,
           u.full_name AS agent_name, s.name AS site_name
      FROM visits vv
      JOIN clients c ON c.id = vv.client_id
      LEFT JOIN users u ON u.id = vv.agent_id
      LEFT JOIN sites s ON s.id = vv.site_id
     WHERE vv.id = p_visit_id) x;
  IF v IS NULL THEN
    RAISE EXCEPTION 'Visit not found';
  END IF;

  SELECT COALESCE(jsonb_object_agg(g.type, g.rows), '{}'::jsonb) INTO groups
    FROM (
      SELECT r.type,
             jsonb_agg(jsonb_build_object(
               'code', r.code, 'type', r.type, 'label', r.label,
               'status', r.status, 'findings', r.findings,
               'recorded_at', r.recorded_at,
               -- The follow-up sheet wants details as an OBJECT: the Python
               -- json.loads()ed it server-side. The scan screen is the other
               -- way round and parses the string itself.
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

-- v_visits is no longer read inside visit_followup (it is SECURITY DEFINER
-- now and would have bypassed the view's own scoping anyway); the header is
-- joined directly and the access check above is what limits it.
