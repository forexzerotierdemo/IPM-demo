-- =====================================================================
-- §10.4 — enough volume to look real. Four clients and three visits looks
-- like a prototype; this is three months of a working book.
-- =====================================================================

-- ---- 20 branches across the 4 clients and 5 areas -------------------
INSERT INTO sites (id, client_id, name, address, area, area_id, visits_per_month,
                   visit_minutes, service_from, service_to, status,
                   preferred_agent_id, lat, lng)
SELECT g,
       1 + (g % 4),
       (ARRAY['Main Kitchen','Annex','Storage Wing','Lobby & Cafe','Roof Plant',
              'Loading Bay','Staff Canteen','Cold Store','Back Office','Car Park'])[1 + (g % 10)]
         || ' - ' || (ARRAY['Downtown','Zamalek','Dokki','Mohandessin','New Cairo'])[1 + (g % 5)],
       'Demo Street ' || g || ', Cairo',
       (ARRAY['Kitchen','Storage','Public area','Service yard'])[1 + (g % 4)],
       a.id,
       (ARRAY[1,2,4,4,8])[1 + (g % 5)],
       (ARRAY[30,45,60,90])[1 + (g % 4)],
       '09:00', '17:00', 'active',
       CASE WHEN a.id IN (1,2) THEN 5 ELSE 6 END,
       30.02 + (g % 7) * 0.012,
       31.20 + (g % 5) * 0.015
FROM generate_series(1, 20) g
JOIN areas a ON a.id = 1 + (g % 5)
ON CONFLICT (id) DO NOTHING;

-- Which weekdays each branch will accept a visit on (Cairo week, Sun-Thu).
INSERT INTO site_service_days(site_id, weekday, start_time, end_time, agent_id)
SELECT s.id, w, '09:00', '17:00', s.preferred_agent_id
FROM sites s, unnest(ARRAY[0,1,2,3,4]) w
WHERE (s.id + w) % 3 = 0;

-- ---- three months of visits ----------------------------------------
-- Last month completed, this month part-done, next month booked. The branch's
-- own preferred engineer carries it, so the area manager's patch and the team
-- leader's people both resolve to real rows.
INSERT INTO visits (site_id, client_id, agent_id, service_type_id,
                    scheduled_start, scheduled_end, status, location, notes,
                    completed_at)
SELECT s.id, s.client_id, s.preferred_agent_id,
       1 + (s.id % 7),
       to_char(d, 'YYYY-MM-DD') || ' ' || lpad((9 + (s.id % 4) * 2)::text, 2, '0') || ':00:00',
       to_char(d, 'YYYY-MM-DD') || ' ' || lpad((10 + (s.id % 4) * 2)::text, 2, '0') || ':30:00',
       CASE WHEN d::date <  current_date THEN 'completed'
            WHEN d::date =  current_date THEN 'in_progress'
            ELSE 'scheduled' END,
       s.area,
       (ARRAY['Routine IPM round','Rodent stations checked and re-baited',
              'Cockroach gel treatment - kitchen line','Fly unit service and lamp change',
              'Quarterly general treatment'])[1 + (s.id % 5)],
       CASE WHEN d::date < current_date
            THEN to_char(d, 'YYYY-MM-DD') || ' ' || lpad((10 + (s.id % 4) * 2)::text, 2, '0') || ':25:00'
       END
FROM sites s
CROSS JOIN generate_series(date_trunc('month', current_date) - interval '1 month',
                           date_trunc('month', current_date) + interval '2 month' - interval '1 day',
                           interval '1 day') d
WHERE extract(dow FROM d) BETWEEN 0 AND 4          -- Cairo week: Sun-Thu
  AND s.id % 7 = extract(day FROM d)::int % 7;     -- a spread, not every branch every day

-- ---- a report on every second completed visit ------------------------
INSERT INTO reports (visit_id, summary, pests_found, findings, recommendations,
                     severity, status, completed_at, condition)
SELECT v.id,
       (ARRAY['Activity down on last round; stations holding.',
              'No live activity seen. Housekeeping good.',
              'Cockroach activity by the sink line - gel applied.',
              'Rodent droppings in the store; two stations moved.',
              'Fly pressure normal for the season; lamps changed.'])[1 + (v.id % 5)],
       (ARRAY['None','German cockroach','House mouse','Housefly','Pharaoh ant'])[1 + (v.id % 5)],
       (ARRAY['Perimeter clear. Bait take nil at all points.',
              'Minor take at station 4 only.',
              'Heavy activity behind the fridge and under the prep bench.',
              'Gaps under the delivery door letting activity in.',
              'Waste area needs a tighter lid rotation.'])[1 + (v.id % 5)],
       (ARRAY['Continue the monthly round.',
              'Seal the gap under the delivery door.',
              'Schedule a follow-up in two weeks.',
              'Move the bins away from the back wall.',
              'Increase to fortnightly for one cycle.'])[1 + (v.id % 5)],
       (ARRAY['low','low','medium','high','medium'])[1 + (v.id % 5)],
       'complete', v.completed_at,
       (ARRAY['good','good','fair','poor','fair'])[1 + (v.id % 5)]
FROM visits v
WHERE v.status = 'completed' AND v.id % 2 = 0;

-- ---- QR devices standing at the branches ----------------------------
INSERT INTO devices (code, type, client_id, site_id, label, status, active)
SELECT (ARRAY['LIT','GLU','BAI','FLY'])[1 + (n % 4)] || lpad(((s.id - 1) * 4 + n + 1)::text, 4, '0'),
       (ARRAY['light_trap','glue_station','bait_station','fly_trap'])[1 + (n % 4)],
       s.client_id, s.id,
       (ARRAY['Kitchen','Back door','Store room','Prep line'])[1 + (n % 4)],
       (ARRAY['ok','ok','ok','activity','needs_service'])[1 + ((s.id + n) % 5)],
       1
FROM sites s, generate_series(0, 3) n;

-- ---- money -----------------------------------------------------------
-- Invoices against completed visits at the two biggest customers, so the
-- finance screens and the client portal both have something to show.
INSERT INTO invoices (client_id, visit_id, site_id, doc_type, number, issue_date,
                      due_date, amount, tax, total, status)
SELECT v.client_id, v.id, v.site_id, 'invoice',
       'INV-' || lpad(v.id::text, 5, '0'),
       left(v.completed_at, 10),
       to_char(left(v.completed_at, 10)::date + 15, 'YYYY-MM-DD'),
       x.amt, round((x.amt * 0.14)::numeric, 2)::double precision,
       round((x.amt * 1.14)::numeric, 2)::double precision,
       CASE WHEN v.id % 4 = 0 THEN 'paid'
            WHEN left(v.completed_at, 10)::date + 15 < current_date THEN 'overdue'
            ELSE 'sent' END
FROM visits v, LATERAL (SELECT (350 + (v.id % 6) * 75)::double precision AS amt) x
WHERE v.status = 'completed' AND v.client_id IN (1, 2) AND v.id % 3 = 0;

INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
SELECT i.id, 'Pest control service - ' || i.number, 1, i.amount, i.amount FROM invoices i;

INSERT INTO payments (invoice_id, amount, method)
SELECT i.id, i.total, 'bank_transfer' FROM invoices i WHERE i.status = 'paid';

-- A recurring contract per client, so the billing run has something to chew on.
INSERT INTO contracts (client_id, service_type_id, agent_id, frequency, start_date,
                       next_run_date, price, status, notes, bill_every, auto_invoice)
SELECT c.id, 1 + (c.id % 7), CASE WHEN c.id % 2 = 0 THEN 5 ELSE 6 END, 'monthly',
       to_char(current_date - 200, 'YYYY-MM-DD'),
       to_char(date_trunc('month', current_date) + interval '1 month', 'YYYY-MM-DD'),
       (2000 + c.id * 500)::double precision, 'active',
       'Annual IPM programme - monthly rounds', 'monthly', 1
FROM clients c;

INSERT INTO contract_sites (contract_id, site_id)
SELECT ct.id, s.id FROM contracts ct JOIN sites s ON s.client_id = ct.client_id;

-- ---- the sequences, or the next insert from the UI collides ----------
DO $seq$
DECLARE t text; c text;
BEGIN
  FOR t, c IN
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND is_identity = 'YES'
  LOOP
    EXECUTE format(
      'SELECT setval(pg_get_serial_sequence(%L, %L), GREATEST(COALESCE((SELECT max(%I) FROM %I), 1), 1))',
      t, c, c, t);
  END LOOP;
END $seq$;
