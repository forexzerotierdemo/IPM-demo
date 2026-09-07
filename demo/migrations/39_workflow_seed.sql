-- =====================================================================
-- A LITTLE WORK IN THE TRAYS.
--
-- The approval screens — materials, returns, pocket money, visit requests
-- — were empty, so the buttons ported in 37_actions.sql had nothing to act
-- on. A working Approve button on an empty list is not a demo.
--
-- Deliberately small, and each tray holds something in EVERY state so the
-- screen shows the whole shape of the workflow rather than one row:
-- something waiting, something already answered, something disputed.
-- All invented, as with everything else here.
-- =====================================================================

-- ---- materials the engineers asked for -------------------------------
INSERT INTO engineer_issues (id, agent_id, note, created_by, created_at, status,
                             handled_by, handled_at, receipt_status, receipt_at)
VALUES
  (1, 5, 'Restock for the New Cairo round', 5,
     to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '2 days', 'YYYY-MM-DD HH24:MI:SS'),
     'requested', NULL, NULL, NULL, NULL),
  (2, 6, 'Gel and bait for the Maadi branches', 6,
     to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '1 day', 'YYYY-MM-DD HH24:MI:SS'),
     'requested', NULL, NULL, NULL, NULL),
  (3, 5, 'Monthly consumables', 5,
     to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '9 days', 'YYYY-MM-DD HH24:MI:SS'),
     'approved', 2,
     to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '8 days', 'YYYY-MM-DD HH24:MI:SS'),
     'received',
     to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '8 days', 'YYYY-MM-DD HH24:MI:SS'))
ON CONFLICT (id) DO NOTHING;

INSERT INTO engineer_issue_items (issue_id, chemical_id, quantity, approved_quantity, line_status)
-- A line awaiting a decision has line_status NULL: the check constraint
-- allows only NULL, 'approved' or 'declined', because 'requested' is the
-- state of the REQUEST, not of a line the office has not answered yet.
VALUES (1, 2, 500, NULL, NULL),
       (1, 1, 2,   NULL, NULL),
       (2, 3, 1.5, NULL, NULL),
       (2, 5, 3,   NULL, NULL),
       (3, 2, 250, 250,  'approved'),
       (3, 4, 1,   1,    'approved')
ON CONFLICT DO NOTHING;

-- ---- and what came back ---------------------------------------------
INSERT INTO material_returns (id, agent_id, note, created_by, created_at, status)
VALUES
  (1, 6, 'Unused bait from the cancelled Zamalek round', 6,
     to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '3 days', 'YYYY-MM-DD HH24:MI:SS'),
     'requested'),
  (2, 5, 'Half a litre left over', 5,
     to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '12 days', 'YYYY-MM-DD HH24:MI:SS'),
     'approved')
ON CONFLICT (id) DO NOTHING;

INSERT INTO material_return_items (return_id, chemical_id, quantity, approved_quantity, line_status)
VALUES (1, 3, 0.5, NULL, NULL),
       (2, 1, 0.5, 0.5,  'approved')
ON CONFLICT DO NOTHING;

-- ---- pocket money ----------------------------------------------------
INSERT INTO petty_cash (id, agent_id, kind, amount, category, spent_on, note,
                        status, created_by, created_at, handled_by, handled_at,
                        decline_reason)
VALUES
  (1, 5, 'expense', 180, 'fuel',
     to_char((now() AT TIME ZONE 'Africa/Cairo')::date - 1, 'YYYY-MM-DD'),
     'Fuel, New Cairo round', 'pending', 5, now_cairo(), NULL, NULL, NULL),
  (2, 6, 'expense', 95, 'parking',
     to_char((now() AT TIME ZONE 'Africa/Cairo')::date - 2, 'YYYY-MM-DD'),
     'Parking at the hotel', 'pending', 6, now_cairo(), NULL, NULL, NULL),
  (3, 5, 'expense', 240, 'fuel',
     to_char((now() AT TIME ZONE 'Africa/Cairo')::date - 10, 'YYYY-MM-DD'),
     'Fuel', 'approved', 5, now_cairo(), 2, now_cairo(), NULL),
  (4, 6, 'expense', 600, 'other',
     to_char((now() AT TIME ZONE 'Africa/Cairo')::date - 14, 'YYYY-MM-DD'),
     'Replacement toolkit', 'declined', 6, now_cairo(), 2, now_cairo(),
     'Buy through the office, not out of pocket')
ON CONFLICT (id) DO NOTHING;

-- ---- what the customer asked for -------------------------------------
INSERT INTO visit_requests (id, client_id, site_id, preferred_date, note, status,
                            created_by, created_at)
VALUES
  (1, 1, 1, to_char((now() AT TIME ZONE 'Africa/Cairo')::date + 3, 'YYYY-MM-DD'),
     'Seeing ants in the prep area again', 'pending', 7, now_cairo()),
  (2, 1, 5, to_char((now() AT TIME ZONE 'Africa/Cairo')::date + 6, 'YYYY-MM-DD'),
     'Please treat the bin store before the audit', 'pending', 7, now_cairo()),
  (3, 1, 1, to_char((now() AT TIME ZONE 'Africa/Cairo')::date - 5, 'YYYY-MM-DD'),
     'Flies in the canteen', 'approved', 7, now_cairo())
ON CONFLICT (id) DO NOTHING;

-- ---- the sales pipeline ----------------------------------------------
INSERT INTO leads (id, name, company, phone, email, sector, message,
                   preferred_date, source, status, created_at)
VALUES
  (1, 'Mahmoud Fathy', 'Cairo Bakery Group', '+20 100 111 2233',
     'mahmoud@cairobakery.example', 'food', 'Six branches, want a monthly IPM contract',
     to_char((now() AT TIME ZONE 'Africa/Cairo')::date + 4, 'YYYY-MM-DD'),
     'website', 'new', now_cairo()),
  (2, 'Rana Ibrahim', 'Delta Pharma Stores', '+20 100 222 3344',
     'rana@deltapharma.example', 'pharma', 'Warehouse rodent problem',
     NULL, 'referral', 'contacted', now_cairo()),
  (3, 'Sameh Nabil', 'Zamalek Fitness Club', '+20 100 333 4455',
     'sameh@zamalekfit.example', 'leisure', 'Quote for quarterly service',
     NULL, 'manual', 'quoted', now_cairo())
ON CONFLICT (id) DO NOTHING;

-- ---- what the customers thought --------------------------------------
INSERT INTO visit_ratings (visit_id, client_id, stars, comment, created_by, created_at)
SELECT v.id, v.client_id,
       (ARRAY[5,4,5,3,4])[1 + (v.id % 5)],
       (ARRAY['Very thorough, thank you.','On time and tidy.',
              'Good — the fly units are much better.',
              'Arrived late but did the job.',
              'Happy with the service.'])[1 + (v.id % 5)],
       7, v.completed_at
FROM visits v
WHERE v.status = 'completed' AND v.client_id = 1 AND v.id % 9 = 0
ON CONFLICT DO NOTHING;

-- ---- running costs ---------------------------------------------------
INSERT INTO expenses (spent_on, category, description, amount, vendor, method, source, created_at)
SELECT to_char((now() AT TIME ZONE 'Africa/Cairo')::date - (n * 9), 'YYYY-MM-DD'),
       (ARRAY['fuel','vehicle','salaries','rent','materials'])[1 + (n % 5)],
       (ARRAY['Van fuel','Van service','Field staff salaries','Depot rent',
              'Consumables'])[1 + (n % 5)],
       (ARRAY[1800, 2400, 26000, 9000, 3200])[1 + (n % 5)],
       (ARRAY['Wataniya','AutoFix','Payroll','Landlord','SupplyCo'])[1 + (n % 5)],
       'bank', 'manual', now_cairo()
FROM generate_series(0, 9) n;

SELECT setval(pg_get_serial_sequence('engineer_issues','id'),
              GREATEST((SELECT max(id) FROM engineer_issues), 1));
SELECT setval(pg_get_serial_sequence('engineer_issue_items','id'),
              GREATEST((SELECT max(id) FROM engineer_issue_items), 1));
SELECT setval(pg_get_serial_sequence('material_returns','id'),
              GREATEST((SELECT max(id) FROM material_returns), 1));
SELECT setval(pg_get_serial_sequence('material_return_items','id'),
              GREATEST((SELECT max(id) FROM material_return_items), 1));
SELECT setval(pg_get_serial_sequence('petty_cash','id'),
              GREATEST((SELECT max(id) FROM petty_cash), 1));
SELECT setval(pg_get_serial_sequence('visit_requests','id'),
              GREATEST((SELECT max(id) FROM visit_requests), 1));
SELECT setval(pg_get_serial_sequence('leads','id'),
              GREATEST((SELECT max(id) FROM leads), 1));
SELECT setval(pg_get_serial_sequence('visit_ratings','id'),
              GREATEST((SELECT max(id) FROM visit_ratings), 1));
SELECT setval(pg_get_serial_sequence('expenses','id'),
              GREATEST((SELECT max(id) FROM expenses), 1));


-- ---- an opening issue, so the balances make sense --------------------
-- 27_usage_and_drafts.sql logged what engineers APPLIED on jobs, but
-- nothing was ever issued to them, so issues_balance() reported a negative
-- remaining — the engineer apparently owing 3.7 kg of boric acid. The
-- arithmetic was right (issued − used − returned); the story was missing
-- its first chapter. Give each engineer one approved-and-received issue
-- covering what they went on to use, plus a little still in the van.
INSERT INTO engineer_issues (agent_id, note, created_by, created_at, status,
                             handled_by, handled_at, receipt_status, receipt_at)
SELECT a.agent_id, 'Opening stock for the round', a.agent_id,
       to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '40 days', 'YYYY-MM-DD HH24:MI:SS'),
       'approved', 2,
       to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '40 days', 'YYYY-MM-DD HH24:MI:SS'),
       'received',
       to_char((now() AT TIME ZONE 'Africa/Cairo') - interval '40 days', 'YYYY-MM-DD HH24:MI:SS')
FROM (SELECT DISTINCT v.agent_id FROM visits v
        JOIN chemical_usage cu ON cu.visit_id = v.id
       WHERE v.agent_id IS NOT NULL) a
WHERE NOT EXISTS (SELECT 1 FROM engineer_issues e
                   WHERE e.agent_id = a.agent_id
                     AND e.note = 'Opening stock for the round');

INSERT INTO engineer_issue_items (issue_id, chemical_id, quantity, approved_quantity, line_status)
-- Generous on purpose: a visit reassigned between engineers takes its
-- usage with it, so a tight ratio can leave the losing engineer a few
-- millilitres short and the balance reading negative. Half again plus one
-- absorbs that without looking odd on the screen.
SELECT e.id, u.chemical_id,
       round((u.used * 1.5 + 1)::numeric, 2), round((u.used * 1.5 + 1)::numeric, 2), 'approved'
FROM engineer_issues e
JOIN (SELECT v.agent_id, cu.chemical_id, sum(cu.quantity) used
        FROM chemical_usage cu JOIN visits v ON v.id = cu.visit_id
       WHERE v.agent_id IS NOT NULL
       GROUP BY v.agent_id, cu.chemical_id) u ON u.agent_id = e.agent_id
WHERE e.note = 'Opening stock for the round'
  AND NOT EXISTS (SELECT 1 FROM engineer_issue_items ii
                   WHERE ii.issue_id = e.id AND ii.chemical_id = u.chemical_id);

SELECT setval(pg_get_serial_sequence('engineer_issues','id'),
              GREATEST((SELECT max(id) FROM engineer_issues), 1));
SELECT setval(pg_get_serial_sequence('engineer_issue_items','id'),
              GREATEST((SELECT max(id) FROM engineer_issue_items), 1));
