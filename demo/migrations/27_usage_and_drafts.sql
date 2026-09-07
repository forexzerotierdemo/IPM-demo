-- =====================================================================
-- Two panels that were correctly empty, and a little demo data so they
-- are not. Deliberately small — this is a sales demo, not a load test.
--
-- 1. chemical_usage was never seeded, so the Chemicals panel on /analytics
--    and the stock ledger had nothing in them. One product per completed
--    visit, sized to the job.
-- 2. Every seeded report was already 'complete', so the Reports > Drafts
--    queue was empty. A handful of recent visits are left written-up but
--    unfinished, which is what that screen exists to chase.
--
-- All invented. Nothing here comes from anywhere real.
-- =====================================================================

-- ---- what was applied on the job ------------------------------------
INSERT INTO chemical_usage (visit_id, chemical_id, quantity, area_treated)
SELECT v.id,
       1 + (v.id % 5),
       -- litres/grams to suit the product: the gel is dosed in grams, the
       -- sprays in litres, so the numbers are not all the same shape.
       CASE 1 + (v.id % 5)
         WHEN 2 THEN 40 + (v.id % 60)          -- Fipronil Gel, grams
         WHEN 3 THEN 0.5 + (v.id % 3)          -- Brodifacoum Bait, kg
         ELSE round((0.4 + (v.id % 7) * 0.15)::numeric, 2)
       END,
       (ARRAY['Kitchen line','Waste area','Storage racks','Perimeter',
              'Prep bench'])[1 + (v.id % 5)]
FROM visits v
WHERE v.status = 'completed'
  AND v.id % 3 = 0                       -- not every visit uses a product
  AND NOT EXISTS (SELECT 1 FROM chemical_usage cu WHERE cu.visit_id = v.id);

SELECT setval(pg_get_serial_sequence('chemical_usage', 'id'),
              GREATEST((SELECT max(id) FROM chemical_usage), 1));

-- The stock ledger has to agree with what was taken off the shelf, or the
-- Chemicals screen shows a level nobody can account for.
INSERT INTO inventory_transactions (chemical_id, change, reason, reference)
SELECT cu.chemical_id, -cu.quantity, 'usage', 'visit:' || cu.visit_id
FROM chemical_usage cu
WHERE NOT EXISTS (SELECT 1 FROM inventory_transactions it
                   WHERE it.reference = 'visit:' || cu.visit_id
                     AND it.chemical_id = cu.chemical_id);

UPDATE chemicals ch SET quantity_in_stock = GREATEST(0, ch.quantity_in_stock - used.q)
FROM (SELECT chemical_id, sum(quantity) q FROM chemical_usage GROUP BY 1) used
WHERE ch.id = used.chemical_id;

-- ---- paperwork still owed -------------------------------------------
-- The most recent few write-ups are left as drafts, so Reports > Drafts has
-- something to chase and the dashboard's "reports due" is not theoretical.
UPDATE reports r SET status = 'draft', completed_at = NULL
FROM (
  SELECT r2.id FROM reports r2
    JOIN visits v ON v.id = r2.visit_id
   WHERE r2.status = 'complete'
   ORDER BY v.scheduled_start DESC
   LIMIT 5
) pick
WHERE r.id = pick.id;
