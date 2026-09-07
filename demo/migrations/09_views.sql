-- =====================================================================
-- §7.1 — one view per list endpoint, reproducing the exact column names
-- the Python handlers returned. EVERY view carries security_invoker so the
-- §6 policies apply to the caller, not to the view's owner.
-- =====================================================================

-- ------------------------------------------------------------- clients
-- GET /api/clients was a plain `SELECT * FROM clients`.
CREATE OR REPLACE VIEW v_clients WITH (security_invoker = true) AS
SELECT * FROM clients;

-- ------------------------------------------------------------- users
-- _public_user() plus active/hire_date/site_name, and the supervisor
-- attachments (area_ids/areas, member_ids/members) the edit form reads.
-- password_hash is deliberately not projected.
CREATE OR REPLACE VIEW v_users WITH (security_invoker = true) AS
SELECT u.id, u.full_name, u.email, u.role, u.phone, u.client_id, u.site_id,
       u.specialization, u.license_no, u.license_expiry, u.lang,
       u.active, u.hire_date, u.team_leader_id, u.auth_id, u.created_at,
       s.name AS site_name,
       CASE WHEN u.role = 'area_manager' THEN
         COALESCE((SELECT jsonb_agg(a.id ORDER BY a.sort_order, a.id)
                     FROM area_manager_areas la JOIN areas a ON a.id = la.area_id
                    WHERE la.manager_id = u.id), '[]'::jsonb) END AS area_ids,
       CASE WHEN u.role = 'area_manager' THEN
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name_en', a.name_en,
                                                       'name_ar', a.name_ar)
                                    ORDER BY a.sort_order, a.id)
                     FROM area_manager_areas la JOIN areas a ON a.id = la.area_id
                    WHERE la.manager_id = u.id), '[]'::jsonb) END AS areas,
       CASE WHEN u.role = 'team_leader' THEN
         COALESCE((SELECT jsonb_agg(m.id ORDER BY m.full_name)
                     FROM users m WHERE m.team_leader_id = u.id AND m.active = 1),
                  '[]'::jsonb) END AS member_ids,
       CASE WHEN u.role = 'team_leader' THEN
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'full_name', m.full_name,
                                                       'role', m.role) ORDER BY m.full_name)
                     FROM users m WHERE m.team_leader_id = u.id AND m.active = 1),
                  '[]'::jsonb) END AS members
FROM users u
LEFT JOIN sites s ON s.id = u.site_id;

-- ------------------------------------------------------------- sites
-- §7.1's view, plus the two things _attach_service_days() hung on the rows.
CREATE OR REPLACE VIEW v_sites WITH (security_invoker = true) AS
SELECT s.id, s.client_id, s.name, s.address, s.area, s.area_id, s.map_image,
       s.lat, s.lng, s.service_from, s.service_to, s.visits_per_month,
       s.visit_minutes, s.status, s.map_url, s.preferred_agent_id,
       c.status  AS client_status,
       (SELECT count(*) FROM visits v
          WHERE v.site_id = s.id AND v.status = 'scheduled'
            AND left(v.scheduled_start, 10) >= today_cairo()) AS upcoming_visits,
       s.created_at,
       c.name_en AS client_en, c.name_ar AS client_ar,
       ar.name_en AS area_en, ar.name_ar AS area_ar,
       pa.full_name AS preferred_agent_name,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
                          'weekday', d.weekday, 'start_time', d.start_time,
                          'end_time', d.end_time, 'agent_id', d.agent_id,
                          'agent_name', da.full_name) ORDER BY d.weekday)
                   FROM site_service_days d
                   LEFT JOIN users da ON da.id = d.agent_id
                  WHERE d.site_id = s.id), '[]'::jsonb) AS service_days
FROM sites s
JOIN clients c ON c.id = s.client_id
LEFT JOIN areas ar ON ar.id = s.area_id
LEFT JOIN users pa ON pa.id = s.preferred_agent_id;

-- ------------------------------------------------------------- visits
-- VISIT_AREA_SQL + VISIT_NO_SQL, translated. The month key is left(x,7)
-- rather than strftime('%Y-%m',x) because the column stayed text (§4.1),
-- and _apply_visit_no() moved the derived number onto visit_number, so the
-- view publishes it under that name directly.
CREATE OR REPLACE VIEW v_visits WITH (security_invoker = true) AS
SELECT v.id, v.client_id, v.site_id, v.agent_id, v.service_type_id,
       v.scheduled_start, v.scheduled_end, v.status, v.location, v.notes,
       v.created_at, v.completed_at, v.contract_id,
       v.checkin_at, v.checkin_lat, v.checkin_lng, v.checkin_acc,
       v.checkout_at, v.checkout_lat, v.checkout_lng, v.checkout_acc,
       c.name_en AS client_en, c.name_ar AS client_ar,
       sv.name_en AS service_en, sv.name_ar AS service_ar,
       u.full_name AS agent_name,
       st.name AS site_name, st.lat AS site_lat, st.lng AS site_lng,
       st.map_image AS site_map_image,
       COALESCE(st.area_id, c.area_id)     AS area_id,
       COALESCE(va.name_en, ca.name_en)    AS area_en,
       COALESCE(va.name_ar, ca.name_ar)    AS area_ar,
       CASE WHEN v.scheduled_start IS NULL OR v.status = 'cancelled' THEN NULL ELSE (
         SELECT count(*) FROM visits x
          WHERE x.client_id = v.client_id
            AND COALESCE(x.site_id, -1) = COALESCE(v.site_id, -1)
            AND x.status <> 'cancelled' AND x.scheduled_start IS NOT NULL
            AND left(x.scheduled_start, 7) = left(v.scheduled_start, 7)
            AND (x.scheduled_start < v.scheduled_start
                 OR (x.scheduled_start = v.scheduled_start AND x.id <= v.id))
       ) END AS visit_number,
       EXISTS (SELECT 1 FROM reports r
                WHERE r.visit_id = v.id AND r.status = 'complete') AS has_report
FROM visits v
JOIN clients c ON c.id = v.client_id
LEFT JOIN service_types sv ON sv.id = v.service_type_id
LEFT JOIN sites st ON st.id = v.site_id
LEFT JOIN users u ON u.id = v.agent_id
LEFT JOIN areas va ON va.id = st.area_id
LEFT JOIN areas ca ON ca.id = c.area_id;

-- ------------------------------------------------------------- reports
-- visit_date is exposed as well as scheduled_start: the shim filters the
-- list on a date and the handler sorted on v.scheduled_start.
CREATE OR REPLACE VIEW v_reports WITH (security_invoker = true) AS
SELECT r.id, r.visit_id, r.severity, r.status, r.summary, r.pests_found,
       r.recommendations, r.created_at, r.completed_at,
       v.scheduled_start, left(v.scheduled_start, 10) AS visit_date,
       v.agent_id, v.client_id, v.site_id,
       c.name_en AS client_en, c.name_ar AS client_ar,
       st.name AS site_name, u.full_name AS agent_name
FROM reports r
JOIN visits v ON v.id = r.visit_id
JOIN clients c ON c.id = v.client_id
LEFT JOIN sites st ON st.id = v.site_id
LEFT JOIN users u ON u.id = v.agent_id;

-- ------------------------------------------------------------- devices
CREATE OR REPLACE VIEW v_devices WITH (security_invoker = true) AS
SELECT d.*, c.name_en AS client_en, c.name_ar AS client_ar, s.name AS site_name,
       (SELECT max(di.recorded_at) FROM device_inspections di
         WHERE di.device_id = d.id) AS last_seen
FROM devices d
LEFT JOIN clients c ON c.id = d.client_id
LEFT JOIN sites s ON s.id = d.site_id;
