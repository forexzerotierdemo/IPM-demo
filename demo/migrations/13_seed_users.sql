-- =====================================================================
-- §10.3 — link each GoTrue account to its public.users profile.
-- password_hash is '' because Supabase Auth owns credentials now.
-- =====================================================================
INSERT INTO users (id, full_name, email, password_hash, role, phone, lang, active,
                   specialization, hire_date, client_id, auth_id) VALUES
  (1,'Demo Admin','admin@demo.foxcrm.app','','admin','+20 100 000 0010','en',1,
     NULL,'2021-01-04',NULL,(SELECT id FROM auth.users WHERE email='admin@demo.foxcrm.app')),
  (2,'Mona Adel','manager@demo.foxcrm.app','','manager','+20 100 000 0011','ar',1,
     NULL,'2021-03-15',NULL,(SELECT id FROM auth.users WHERE email='manager@demo.foxcrm.app')),
  (3,'Tarek Hassan','area@demo.foxcrm.app','','area_manager','+20 100 000 0012','en',1,
     'Area Manager — West Cairo','2021-05-10',NULL,
     (SELECT id FROM auth.users WHERE email='area@demo.foxcrm.app')),
  (4,'Hoda Kamal','leader@demo.foxcrm.app','','team_leader','+20 100 000 0013','en',1,
     'Team Leader — Field','2021-08-01',NULL,
     (SELECT id FROM auth.users WHERE email='leader@demo.foxcrm.app')),
  (5,'Yousef Ali','engineer@demo.foxcrm.app','','agent','+20 100 000 0014','ar',1,
     'Termite & Fumigation','2023-02-01',NULL,
     (SELECT id FROM auth.users WHERE email='engineer@demo.foxcrm.app')),
  (6,'Omar Saeed','engineer2@demo.foxcrm.app','','agent','+20 100 000 0015','en',1,
     'General & Rodent','2022-09-15',NULL,
     (SELECT id FROM auth.users WHERE email='engineer2@demo.foxcrm.app')),
  (7,'Al Noor Portal','client@demo.foxcrm.app','','client','+20 100 000 0016','ar',1,
     NULL,NULL,1,(SELECT id FROM auth.users WHERE email='client@demo.foxcrm.app'))
ON CONFLICT (id) DO NOTHING;

-- The area manager holds West Cairo — October and Zayed. Maadi is deliberately
-- somebody else's, so the demo shows a manager covering part of the book.
INSERT INTO area_manager_areas(manager_id, area_id) VALUES (3,1), (3,2)
ON CONFLICT DO NOTHING;

-- Both engineers report to the team leader.
UPDATE users SET team_leader_id = 4 WHERE id IN (5, 6);

-- Which parts of town each engineer is allowed to work.
INSERT INTO agent_areas(agent_id, area_id) VALUES (5,1),(5,2),(5,4),(6,3),(6,4),(6,5)
ON CONFLICT DO NOTHING;

INSERT INTO shift_types(id, code, name_en, name_ar, start_time, end_time, color, is_off, sort_order) VALUES
  (1,'D','Day','نهاري','09:00','17:00','#2563eb',0,1),
  (2,'E','Evening','مسائي','14:00','22:00','#7c3aed',0,2),
  (3,'N','Night','ليلي','22:00','06:00','#0f172a',0,3),
  (4,'OFF','Day off','إجازة',NULL,NULL,'#94a3b8',1,4)
ON CONFLICT (id) DO NOTHING;

-- Working hours: both engineers on days, Sunday-Thursday (the Cairo week).
INSERT INTO agent_availability(agent_id, weekday, start_time, end_time)
SELECT a, w, '09:00', '17:00' FROM unnest(ARRAY[5,6]) a, unnest(ARRAY[0,1,2,3,4]) w
ON CONFLICT DO NOTHING;
