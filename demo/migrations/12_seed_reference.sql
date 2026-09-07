-- =====================================================================
-- §10.2 — reference data. Structure, not customer data.
-- =====================================================================
INSERT INTO service_types(id, name_en, name_ar) VALUES
  (1,'IPM','الإدارة المتكاملة للآفات'),
  (2,'Rodent Control','مكافحة القوارض'),
  (3,'Termite Treatment','مكافحة النمل الأبيض'),
  (4,'Cockroach Treatment','مكافحة الصراصير'),
  (5,'Bed Bugs Treatment','مكافحة بق الفراش'),
  (6,'Fumigation','التبخير'),
  (7,'Mosquito Control','مكافحة البعوض')
ON CONFLICT (id) DO NOTHING;

INSERT INTO zones(id, name_en, name_ar, sort_order) VALUES
  (1,'West Cairo','غرب القاهرة',1),
  (2,'Central Cairo','وسط القاهرة',2),
  (3,'East Cairo','شرق القاهرة',3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO areas(id, name_en, name_ar, sort_order, zone_id) VALUES
  (1,'6th of October','السادس من أكتوبر',1,1),
  (2,'Sheikh Zayed','الشيخ زايد',2,1),
  (3,'Maadi','المعادي',3,2),
  (4,'Nasr City','مدينة نصر',4,3),
  (5,'Heliopolis','مصر الجديدة',5,3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO settings(key, value) VALUES
  ('company_name_en','Fox Systems Pest Control (DEMO)'),
  ('company_name_ar','فوكس سيستمز لمكافحة الآفات (تجريبي)'),
  ('currency','EGP'), ('tax_rate','14'),
  ('phone','+20 100 000 0000'), ('email','demo@example.com'),
  ('address_en','Demo Address, Cairo'), ('address_ar','عنوان تجريبي، القاهرة'),
  ('vat_no','100-200-300')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;

-- The five demo chemicals from seed.py, verbatim.
INSERT INTO chemicals(id, name_en, name_ar, active_ingredient, unit, quantity_in_stock,
                      reorder_level, hazard_class, reg_no, cost_per_unit) VALUES
  (1,'Cypermethrin 10%','سايبرمثرين ١٠٪','Cypermethrin','L',50,10,'Class II','EPA-1001',45.0),
  (2,'Fipronil Gel','جل الفيبرونيل','Fipronil','g',2000,500,'Class III','EPA-2002',0.12),
  (3,'Brodifacoum Bait','طعم البروديفاكوم','Brodifacoum','kg',8,10,'Class I','EPA-3003',30.0),
  (4,'Imidacloprid 20%','إيميداكلوبريد ٢٠٪','Imidacloprid','L',25,5,'Class II','EPA-4004',60.0),
  (5,'Boric Acid Powder','مسحوق حمض البوريك','Boric Acid','kg',40,10,'Class IV','EPA-5005',8.0)
ON CONFLICT (id) DO NOTHING;

-- The four invented companies from seed.py, spread across the areas so the
-- area manager's scoping is visible: they must see some and NOT others.
INSERT INTO clients(id, name_en, name_ar, contact_person, phone, email,
                    address_en, address_ar, city, area_id, status) VALUES
  (1,'Al Noor Restaurant','مطعم النور','Khaled Mostafa','+201000000001','info@alnoor.com',
     'Tahrir Square, Cairo','ميدان التحرير، القاهرة','Cairo',1,'active'),
  (2,'Nile View Hotel','فندق إطلالة النيل','Sara Mansour','+201000000002','contact@nileview.com',
     'Corniche El Nil, Cairo','كورنيش النيل، القاهرة','Cairo',3,'active'),
  (3,'Green Valley School','مدرسة الوادي الأخضر','Ahmed Fares','+201000000003','admin@greenvalley.edu',
     'Smouha, Alexandria','سموحة، الإسكندرية','Alexandria',2,'active'),
  (4,'Fresh Mart Supermarket','سوبرماركت فريش مارت','Laila Hassan','+201000000004','ops@freshmart.com',
     '6th of October City, Giza','مدينة السادس من أكتوبر، الجيزة','Giza',1,'active')
ON CONFLICT (id) DO NOTHING;
