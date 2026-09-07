-- =====================================================================
-- QR device scans, so the fleet half of the system has a history.
--
-- device_inspections was never seeded. Everything built on it read as an
-- honest zero: the dashboard said "0% coverage / 80 overdue", the SLA
-- device tile said every trap was stale, and the whole fleet section of
-- /analytics and /clients/:id/pest-trends would be blank. None of that is
-- a bug — there simply were no scans — but it makes the QR story, which is
-- one of the more distinctive things this system does, look broken.
--
-- One scan per device per month for the last six months, on the day of the
-- visit that was nearest it. `details` is the JSON blob the engineer fills
-- in on the trap; the shapes below are exactly the keys the analytics
-- rollups read (fly_count, consumption_pct, lamp_status, sheet_status,
-- glue_status, bait_status, station_condition, electricity …).
-- =====================================================================

INSERT INTO device_inspections
  (device_id, visit_id, client_id, status, findings, note, source,
   recorded_by, recorded_at, details)
SELECT d.id,
       v.id,
       d.client_id,
       -- Most scans are clear. Activity clusters on bait and glue stations,
       -- which is where it actually shows up first.
       CASE
         WHEN (d.id * 7 + m.n) % 11 = 0 AND d.type IN ('bait_station','glue_station')
           THEN 'activity'
         WHEN (d.id * 5 + m.n) % 17 = 0 THEN 'needs_service'
         ELSE 'ok'
       END,
       CASE WHEN (d.id * 7 + m.n) % 11 = 0
            THEN 'Activity found at this point' END,
       NULL,
       'qr',
       COALESCE(s.preferred_agent_id, 5),
       to_char(scan.day, 'YYYY-MM-DD') || ' ' ||
         lpad((9 + (d.id % 7))::text, 2, '0') || ':' ||
         lpad(((d.id * 13) % 60)::text, 2, '0') || ':00',
       -- The per-type follow-up blob, mirroring the printed follow-up sheet.
       CASE d.type
         WHEN 'light_trap' THEN jsonb_build_object(
           'fly_count', ((d.id * 3 + m.n * 5) % 40),
           'lamp_status', (ARRAY['ok','ok','ok','replaced','damaged'])[1 + ((d.id + m.n) % 5)],
           'lamp_action', CASE WHEN (d.id + m.n) % 5 = 3 THEN 'replaced' END,
           'sheet_status', (ARRAY['ok','ok','full','expired'])[1 + ((d.id + m.n) % 4)],
           'sheet_action', CASE WHEN (d.id + m.n) % 4 = 2 THEN 'changed' END,
           'electricity', (ARRAY['ok','ok','ok','disconnected'])[1 + ((d.id * 2 + m.n) % 4)],
           'trans_light_status', 'ok')
         WHEN 'fly_trap' THEN jsonb_build_object(
           'fly_density', ((d.id * 2 + m.n * 3) % 25),
           'trap_condition', (ARRAY['ok','ok','ok','damaged'])[1 + ((d.id + m.n) % 4)],
           'trap_action', CASE WHEN (d.id + m.n) % 4 = 3 THEN 'replaced' END)
         WHEN 'bait_station' THEN jsonb_build_object(
           'consumption_pct', ((d.id * 11 + m.n * 7) % 100),
           'bait_status', (ARRAY['ok','ok','activity_eating','changed'])[1 + ((d.id + m.n) % 4)],
           'bait_action', CASE WHEN (d.id + m.n) % 4 = 3 THEN 'changed' END,
           'station_condition', (ARRAY['ok','ok','ok','damaged'])[1 + ((d.id * 3 + m.n) % 4)])
         ELSE jsonb_build_object(
           'glue_status', (ARRAY['ok','ok','caught','changed'])[1 + ((d.id + m.n) % 4)],
           'glue_action', CASE WHEN (d.id + m.n) % 4 = 3 THEN 'changed' END,
           'station_condition', 'ok')
       END::text
FROM devices d
JOIN sites s ON s.id = d.site_id
CROSS JOIN generate_series(0, 5) m(n)
CROSS JOIN LATERAL (
  SELECT (date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo')::date)
          - make_interval(months => m.n::int)
          + make_interval(days => (d.id % 20)::int))::date AS day
) scan
-- The scan belongs to the visit that was at that branch nearest the day, if
-- there was one. A scan with no visit is still a scan — the engineer can be
-- sent to read the traps without a job on the book.
LEFT JOIN LATERAL (
  SELECT x.id FROM visits x
   WHERE x.site_id = d.site_id AND x.status = 'completed'
   ORDER BY abs(x.scheduled_start::date - scan.day)
   LIMIT 1
) v ON true
WHERE d.client_id IS NOT NULL
  AND scan.day <= (now() AT TIME ZONE 'Africa/Cairo')::date
  -- not every trap every month, or the coverage line is a flat 100%
  AND (d.id + m.n) % 6 <> 0;

SELECT setval(pg_get_serial_sequence('device_inspections', 'id'),
              GREATEST((SELECT max(id) FROM device_inspections), 1));

-- The registry's last-known status should agree with the last scan, or the
-- Devices screen and the scan history contradict each other.
UPDATE devices d SET status = last.status
FROM (
  SELECT DISTINCT ON (di.device_id) di.device_id, di.status
    FROM device_inspections di
   ORDER BY di.device_id, di.recorded_at DESC
) last
WHERE d.id = last.device_id;
