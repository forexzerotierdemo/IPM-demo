// Put the demo data back to its intended state and re-baseline.
//
//   node tools/reseed.js
//
// tools/test-actions.js exercises real state transitions — it approves
// requests, moves stock, books visits — so running it leaves the demo
// slightly used: an extra approved issue here, a stock level a few litres
// off there. Harmless in itself, but it drifts, and one visible symptom is
// issues_balance() going negative because a test consumed product that was
// never issued.
//
// So: wipe the workflow tables, re-run the seed that fills them, and take
// the snapshot again so the trial reset restores THIS state rather than
// whatever the last test run left behind.
//
// Run it after the test suite, and before showing the demo to anyone.
const fs = require('fs');
const path = require('path');
const { ROOT, runSql } = require('./env');

const WORKFLOW_TABLES = [
  'engineer_issue_items', 'engineer_issues',
  'material_return_items', 'material_returns',
  'petty_cash', 'visit_requests', 'leads',
  'visit_ratings', 'expenses', 'notifications', 'audit_log',
];

(async () => {
  console.log('clearing the workflow tables');
  await runSql(WORKFLOW_TABLES.map(t => `DELETE FROM ${t};`).join('\n'));

  // Ledger lines the tests wrote, and the stock they moved with them.
  await runSql(`
    DELETE FROM inventory_transactions
     WHERE reference LIKE 'issue:%' OR reference LIKE 'return:%'
        OR reference LIKE 'usage-undo:%';`);

  // Approving a request BOOKS a visit, so the test suite leaves real jobs
  // in the diary behind it — the visit count crept 216 -> 221 across runs.
  // They carry the request's own note, which is how they are found again.
  await runSql(`
    DELETE FROM visits WHERE notes IN ('test request', 'test fixture');`);

  // Check-in/out and the scan tests write on real seeded visits; put those
  // columns back so the diary reads as untouched.
  await runSql(`
    UPDATE visits SET checkin_at = NULL, checkin_lat = NULL, checkin_lng = NULL,
                      checkin_acc = NULL, checkout_at = NULL, checkout_lat = NULL,
                      checkout_lng = NULL, checkout_acc = NULL,
                      status = CASE WHEN status = 'in_progress'
                                    AND left(scheduled_start, 10) > today_cairo()
                                    THEN 'scheduled' ELSE status END
     WHERE checkin_at IS NOT NULL AND left(scheduled_start, 10) >= today_cairo();
    DELETE FROM device_inspections WHERE source = 'scan';`);

  // Stock back to the seeded levels minus what the seeded USAGE consumed —
  // the same arithmetic 27_usage_and_drafts.sql does, so the shelf agrees
  // with the ledger again.
  console.log('restating stock from the usage ledger');
  await runSql(`
    UPDATE chemicals ch SET quantity_in_stock = base.qty
      FROM (VALUES (1, 50.0), (2, 2000.0), (3, 8.0), (4, 25.0), (5, 40.0))
             AS base(id, qty)
     WHERE ch.id = base.id;
    UPDATE chemicals ch
       SET quantity_in_stock = GREATEST(0, ch.quantity_in_stock - used.q)
      FROM (SELECT chemical_id, sum(quantity) q FROM chemical_usage GROUP BY 1) used
     WHERE ch.id = used.chemical_id;`);

  console.log('re-running the workflow seed');
  await runSql(fs.readFileSync(
    path.join(ROOT, 'migrations', '39_workflow_seed.sql'), 'utf8'));

  console.log('re-taking the snapshot');
  console.log(' ', JSON.stringify(await runSql('SELECT demo_snapshot_take();')));

  const check = await runSql(`
    SELECT (SELECT count(*) FROM engineer_issues WHERE status='requested') pending_issues,
           (SELECT count(*) FROM petty_cash WHERE status='pending') pending_cash,
           (SELECT count(*) FROM visit_requests WHERE status='pending') pending_requests,
           (SELECT count(*) FROM leads) leads,
           (SELECT count(*) FROM (
              SELECT 1 FROM chemicals WHERE quantity_in_stock < 0) x) negative_stock;`);
  console.log('\n', JSON.stringify(check[0]));
})().catch(e => { console.error(e.message); process.exit(1); });
