# Fox CRM — Supabase demo

The live pest-control CRM, running with **no VPS**: Supabase for the database,
auth, storage and the computed routes; Vercel for the static front end.

**Live:** https://ipm-crm-demo.vercel.app

| Login | Password | What it shows |
|---|---|---|
| `admin@demo.foxcrm.app` | `demo1234` | Everything, including the finance cockpit |
| `manager@demo.foxcrm.app` | `demo1234` | The office — 68 of 75 permissions, no finance |
| `area@demo.foxcrm.app` | `demo1234` | One patch: 8 of 20 branches. Proves the RLS |
| `leader@demo.foxcrm.app` | `demo1234` | Scoped to their engineers |
| `engineer@demo.foxcrm.app` | `demo1234` | The phone view — his own round only |
| `engineer2@demo.foxcrm.app` | `demo1234` | A second engineer, so the roster has two people |
| `client@demo.foxcrm.app` | `demo1234` | The customer portal, in Arabic — one company |
| `trial@demo.foxcrm.app` | `trial1234` | **The ones to hand prospects.** Its own `trial` role — see below |
| `trial2@` `trial3@` `trial4@` | `trial1234` | Three more, so several people can test at once |

The passwords are deliberately weak and public. **This project must therefore
contain nothing real, ever** — no live customer, no live photo, no live
paperwork. See `../docs/supabase-demo/README-GUIDE.md` §10.1.

Every row in it is invented: four made-up companies (Al Noor Restaurant, Nile
View Hotel, Green Valley School, Fresh Mart Supermarket), made-up staff and
phone numbers, twenty branches, a couple of hundred visits. Nothing was ever
copied from the live system — only its *source code* was read, to match
response shapes.

## The trial account

`trial@demo.foxcrm.app` / `trial1234` is the login to send to someone deciding
whether to buy. It has a **role of its own — `trial`** — not a borrowed admin
or manager account, so what a prospect may do is one row set in
`role_permissions` rather than a role plus a list of exceptions.

| | |
|---|---|
| **sees, creates and edits** | clients, branches, the diary, dispatch, requests, reports, contracts, invoices, chemicals, devices, issues, petty cash, transport, shifts, leads, targets, the IPM library, analytics |
| **sees, cannot change** | the staff list, the permission matrix, company settings |
| **cannot do at all** | delete anything · create or edit staff · edit permissions or settings · clear the schedule · the finance ledger · the audit log · backups |

52 of the 75 permissions, and the UI reflects it: there is no Delete control on
the Clients screen, and no Backup or Finance in the menu.

**You can change any of it from the Permissions screen.** `trial` is a role in
the matrix like any other — pick it from the dropdown, tick what a prospect
should see, save. It takes effect on their next sign-in, and it is the database
that enforces it, not the menu: a permission you withdraw is refused even by a
direct API call. `tools/test-rbac.js` proves exactly that, by granting
`clients.delete`, deleting a row, withdrawing it, and watching the next delete
fail.

> Widening `trial` costs nothing permanent — `demo_reset()` restores everything
> when the last trial session ends. But *between* resets, a prospect given
> `clients.delete` really can delete a customer, and the next visitor walks into
> the hole. That is the trade this screen is making.

**Deleting is the deliberate omission.** Nobody needs to delete a record to
decide whether they want the software, and between resets a deleted branch is a
hole in the demo that the next visitor walks into.

Whatever they *do* change is then restored from a snapshot:

* when the **last** live trial session signs out; and
* when a trial user signs **in and nobody else is working** — because the
  previous visitor almost never signs out, they just close the tab.

The snapshot lives in a `demo_snapshot` schema that is not exposed to
PostgREST, so a trial user can wreck `public` all they like and never reach the
master copy. A reset takes about half a second, is refused for every other
login (admin included), and is throttled to one per 10 seconds.

`demo_reset()` is keyed on the **role**, not on an email address, so a second
trial account needs no code change — and no address is hardcoded into the
front end.

> **Re-take the snapshot after any change to seeded data.** It is the state
> every trial login restores, so a stale snapshot silently undoes later work —
> that is exactly how the hardening's permission denials got wiped on the first
> attempt.

### Several prospects at once

There are four trial logins, and the reset now runs **only when the last live
trial session ends** — not on every sign-in. So a second prospect arriving no
longer wipes the first one's work out from under them, which is exactly what
used to happen. A session with no activity for 20 minutes counts as gone.

> **They still share one dataset.** Two people testing at the same time will
> see each other's clients and visits. Nothing is lost and nothing persists,
> but it is a shared room, not a private copy each.
>
> True isolation would mean a copy of every row per session, with every table's
> primary key and foreign keys reworked to carry a session id — a schema change
> to all 60 tables, not a demo feature. **If a prospect must not see another's
> work, give them their own Supabase project**, or send the link to one at a
> time.

### What each prospect did

**https://ipm-crm-demo.vercel.app/trial-history.html** — sign in as `admin`.

Every trial session is listed with when it started, how long it ran, how many
changes it made and whether it is live now. Click one to see every row that
session added, changed or deleted, in order, with the time.

It is a separate page on purpose: `app.js` is not ours to edit, and a prospect
should never see a list of other prospects. The capture is a database trigger
on all 59 operational tables, so it records what actually happened rather than
what the front end chose to report — and the log survives the reset, which is
the whole point of keeping it.

To re-baseline after deliberately changing the seed:
`node tools/sql.js "select demo_snapshot_take()"`.

---

## What is here

```
demo/
  migrations/    01–41, applied in order. The whole database.
  web/           what Vercel serves. The live static/ tree with ONE file changed.
  supabase/functions/api/   the catch-all Edge Function for the computed routes.
  tools/         scripts to apply, verify and deploy. No CLI needed for any of it.
```

## The one decision the port rests on

`app.js` is 14,898 lines and it *is* the demo. It was not rewritten and it did
not change by one character.

Every call it makes goes through `static/js/api.js` — 157 lines — and every one
ends at `fetch("/api" + path)`. So the port is one file:

> Keep `app.js`, `index.html`, `styles.css`, `i18n.js` exactly as they are.
> Replace `api.js` with a shim that recognises the path and answers it from
> Supabase instead of from the server.

`web/js/api.js` is that shim. It keeps the same public surface — `API.get/post/
put/del`, `API.token`, `API.user`, `uploadPhoto`, the offline queue and the
read-cache hooks — so `app.js` is unaware anything moved.

The 161 plain CRUD routes are covered by **one generic resource table**, not
161 handlers. Anything the table does not recognise falls through to the Edge
Function, so the computed routes can be ported one at a time and the app keeps
working throughout.

Everything else in `web/` that is new: `js/supabase.js` (vendored client),
`js/config.js` (generated endpoint + column map), `js/i18n-extra.js` (labels
for demo-only things, added by extending the table i18n.js defines rather than
editing it), three `<script>` tags in `index.html`, and a bumped cache name in
`sw.js`.

## The QR scan chain

A trap carries a printed label — `LIT0001`, `GLU0062` — encoding
`<host>/scan/<CODE>`. The whole loop works:

1. **Print** the label from the trap's page (`qrcode.js` renders it as SVG,
   crisp at any size).
2. **Scan it** with a phone camera. `/scan/<CODE>` is rewritten to the app in
   `vercel.json`; without that rewrite a scanned label lands on a 404, which is
   exactly what it did before this was wired up.
3. **The engineer sees** whose trap it is, which in-progress visit the reading
   will file against, the recent history, and — the useful part — **what the
   last visit promised to do here** and never did.
4. **They file the reading**: a status, the per-type follow-up fields (lamp,
   sheet, bait consumption, catch tick-list…), optionally geo-stamped.
5. **It appears in the report.** `/visits/:id/followup` is the printable
   proof-of-visit: every trap read on that visit, grouped by type, with the
   fields as filled in. `/visits/:id/devices` is the engineer's checklist —
   scanned versus still to do.

Two details worth knowing, both faithful to `server.py`:

- **The scan functions are SECURITY DEFINER**, and that is deliberate. An
  agent holds `maps.view`/`maps.edit` but **not** `devices.view` — the
  engineer reads traps in the field without getting the device registry admin
  screen. Reading `devices` through RLS therefore told the one person the
  feature exists for that the code was unknown. The functions reach the
  registry directly and re-implement the original's own checks
  (`_assert_client_access`, the branch pin, the permission).
- **A reading is whitelisted per device type.** `clean_device_details()`
  mirrors `DEVICE_FIELD_KEYS`: a bait-station field sent for a light trap is
  dropped, numbers are coerced, and the catch tick-list is stored comma-joined
  the way the reports and analytics read it. A hand-made request cannot stuff
  arbitrary keys into the record.

`node tools/test-scan.js` walks the whole chain as the engineer, the customer
portal and a stranger — 22 checks.

## Security model

Read this before pointing anything at it.

- **RLS is on and forced for all 60 tables**, and every table has a policy.
  An unauthenticated visitor reads nothing anywhere — that is the first thing
  `tools/audit.sql` checks.
- **Every view carries `security_invoker = true`.** Without it a view runs as
  its owner and silently bypasses every policy. This is the single most likely
  way to build a demo that leaks, so `audit.sql` fails the build on it.
- **The service-role key is in `.env` and nowhere else.** Not in `web/`, not in
  the Edge Function. The function builds its client from the *caller's* JWT, so
  the policies stay in force inside it.
- The anon key in `web/js/config.js` is public by design. RLS is what protects
  the data, not the key.

`tools/verify-rls.js` is the proof: it signs in as each account and prints what
PostgREST actually hands that JWT.

```
account     v_clients    v_sites   v_visits  v_reports    v_users  v_devices   invoices
admin               4         20        216         38          8         80         13
manager             4         20        216         38          8         80         13
area                4          8         90         16          6         32          0
leader              4         20        216         38          6          0          0
engineer            4          8         90         16          6          0          0
client              1          5         55          9          3         20          6
```

## Hardening

The demo is a login handed to strangers, so it was attacked rather than
reviewed. `node tools/sql.js tools/audit.sql` must print `[]`. It checks that
RLS is on and forced, that every view is `security_invoker`, that no SECURITY
DEFINER function has a mutable `search_path`, that no credential column is
selectable by a client role, that no client role holds TRUNCATE (which RLS
does not govern), and that `anon` holds no grant at all.

- **`anon` holds nothing.** Every screen is behind a login, so an
  unauthenticated caller gets no privilege — rather than a policy that
  happens to return no rows.
- **`authenticated` keeps only the four verbs PostgREST uses.** No TRUNCATE,
  TRIGGER or REFERENCES, and `ALTER DEFAULT PRIVILEGES` stops newly created
  objects regaining them.
- **Credentials are not a column anyone can select.** `password_hash`,
  `token_version` and `auth_id` are off the wire entirely; `my_profile()`
  resolves the caller through `app_uid()`.
- **An explicit per-user permission beats the role default**, including for
  admin. That is what lets a powerful-looking account have specific powers
  withheld.
- **Self-signup is off**, so the public anon key cannot mint accounts.
- **The trial account has its own `trial` role**, never `admin`. `app.js`'s own
  `can()` short-circuits `role === "admin"` to true, so an admin-shaped account
  is offered every menu item however the server is configured — and `app.js`
  does not change. A distinct role is also the honest description: a prospect
  evaluating the system is not an administrator of it.
- **`demo_reset()` belongs to the `trial` role alone**, throttled to one call
  per 10 seconds. Any other login, admin included, is refused.
- **Headers**: a CSP whose `connect-src` is pinned to this one Supabase
  project, `frame-ancestors 'none'` and `X-Frame-Options: DENY` so the CRM
  cannot be embedded in another page, plus HSTS, nosniff, a referrer policy
  and noindex.

Re-apply the project-level settings (PostgREST row cap, signup off) with
`node tools/harden.js`.

> **What is NOT protected: the front-end code.** `app.js` is 863 KB of the
> real application and is served to every visitor's browser. Anyone who opens
> devtools can read and save it. That is true of every web app, and no amount
> of obfuscation changes it. If the front-end source matters commercially, do
> not make the demo public — issue a login per prospect, or screen-share it
> instead. The Python backend (`server.py`, `roster.py`) is never deployed
> here and is not exposed at all.

## Building it from nothing

```sh
cp .env.example .env       # then fill it in
```

1. **Migrations, in order.** They depend on each other.
   ```sh
   for f in migrations/*.sql; do echo "$f"; node tools/sql.js "$f"; done
   ```
2. **The demo auth accounts** (service-role — from your machine, never a browser):
   ```sh
   for e in admin manager area leader engineer engineer2 client; do
     curl -s -X POST "$SUPABASE_URL/auth/v1/admin/users" \
       -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" \
       -H "Content-Type: application/json" \
       -d "{\"email\":\"$e@demo.foxcrm.app\",\"password\":\"demo1234\",\"email_confirm\":true}"
   done
   ```
   `migrations/13_seed_users.sql` links each one to its `public.users` profile,
   so run the accounts **before** that migration (or re-run it after).
3. **The front-end config**, generated from the live schema:
   ```sh
   node tools/tools-columns.js
   ```
4. **Deploy.**
   ```sh
   node tools/deploy-fn.js     # the Edge Function
   node tools/deploy-web.js    # web/ to Vercel, production
   ```
5. **Prove it.**
   ```sh
   node tools/harden.js                # project settings: row cap, signup off
   node tools/sql.js tools/audit.sql   # must print []
   node tools/verify-rls.js
   node tools/smoke.js
   node tools/test-dispatch.js         # the board, shape by shape
   node tools/test-scan.js             # the QR chain, scan to report
   node tools/test-actions.js          # the buttons on the screens
   node tools/test-rbac.js             # the matrix really controls access
   node tools/reseed.js                # put the demo data back after testing
   ```

## Corrections to the build guide

`docs/supabase-demo/README-GUIDE.md` is the design document this was built
from, and it is largely right. These parts are not — each cost real debugging:

1. **§4.3's `fixed_assignments` is truncated** in both markdown files; a `--`
   comment swallowed the rest of the statement. The real definition is in
   `database.py` (it adds `end_date`, `active`, `created_at`).
2. **`contracts.quote_id → invoices.id` is a third circular FK.** §4.3 says two
   were lifted to `ALTER TABLE`; this one must be too, or the schema will not
   apply at all.
3. **`area_manager_areas` keys on `manager_id`, not `user_id`.** §5.3's
   `app_area_ids()` and §10.3's insert both use the wrong column name.
4. **§6.3's `sites_sel` reads `visits` and `visits_sel` reads `sites`**, so each
   evaluates the other's policy and Postgres raises `42P17`, *infinite
   recursion detected in policy*. §6.4 warns about this trap for `users` only —
   it is live between these two tables. The cure is §6.4's own: do the
   cross-table lookup in a `SECURITY DEFINER` function. See
   `migrations/16_rls_fixes.sql`.
5. **§6.2 leaks the whole book to a client portal login.** The `client` role
   holds `invoices.view`, `contracts.view` and `requests.view`, and §6.2 gates
   those tables on the permission *alone* — so a portal account could read
   every other customer's invoices. This is exactly the incident §10.1 warns
   about. Fixed with `AS RESTRICTIVE` policies that AND a row scope on top of
   the generated ones.
6. **`server.py` lets a client account read its own company, branches and
   devices *without* `clients.view`/`devices.view`** (`if role != "client":
   require_perm(...)`). The policies demanded the permission, so the portal saw
   nothing at all.
7. **§10.2's `zones` insert uses `name`**; the columns are `name_en`/`name_ar`.
8. **The guide's draft shim gets `/auth/me` wrong.** It returns `{user}`, but
   `app.js` does `API.setAuth(API.token, await API.get("/auth/me"))` — it must
   return the profile itself.
9. **§9.2's path strip assumes `/functions/v1/api/...`.** The Supabase edge
   runtime hands the function `/api/...`, so every ported route 404s until both
   prefixes are stripped.

## What is still unported

Of the 250 routes: the 161 CRUD ones and the 6 uploads are done. Of the **83
computed** routes, these are ported —

- `/dashboard`, the owner cockpit and the SLA tiering, as **RPCs** rather than
  Edge Functions (§9.1's own advice: the easy aggregates belong in SQL)
- **Analytics**, the **permission catalogue**, the **report-drafts queue**,
  **minting and assigning QR devices**, and one client's **analytics**,
  **statement** and **pest-trends** pages — all SQL functions
- **the whole dispatch board** — `/dispatch/grid`, `/cell`, `/sla` and `/move`
  as SQL functions, and `/shifts/week` with it, because app.js only shows the
  day/week/month selector once that call succeeds
- `/dispatch/optimize` in the Edge Function: nearest-neighbour routing is the
  one part of the board that genuinely needs a procedural language
- **the whole QR scan chain** — `/scan/<CODE>` both ways, `/devices/:id/history`,
  `/visits/:id/devices` and `/visits/:id/followup` (the printable proof-of-visit)
- `/engineers/scorecard`, in the Edge Function

— and the rest are not: `finance/*`, capacity, service-gaps, cost-to-serve,
pipeline, search, backup/restore, branch-schedule, the CSV/XLSX exports, and
the report PDF. The Edge Function answers
those with `501` and `{"error": "Not available in this demo"}`, which app.js
renders in its own empty-state style — an unfinished screen says **"⚠️ Not
available in this demo"** rather than blanking or throwing.

`node tools/coverage.js` prints exactly which of the 83 are live and which are
not, by probing the deployed demo rather than by trusting this list.

**One honest gap inside the dispatch board.** `dispatch_move` enforces every
rule that is a WALL in roster.py's terms — area permission, the engineer's
hours, the branch's opening days, one branch one day one van — because each
is a plain question about a row. What it does not do is `Day._sequence`, the
last pass that fits the whole round against the travel ceiling. So the board
will accept a round the real planner might still refuse as undrivable. It
never accepts one that breaks a wall.

**The auto-roster is deliberately not ported.** `roster.py` is 2,759 lines of
six interacting rules with an explicit precedence and a bend-but-report
behaviour; §9.3 rates a TypeScript port at 3–6 weeks and high risk. For a sales
demo the right answer is option C — seed a pre-computed roster into
`roster_runs` and show the output.
