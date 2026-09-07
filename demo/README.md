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

The passwords are deliberately weak and public. **This project must therefore
contain nothing real, ever** — no live customer, no live photo, no live
paperwork. See `../docs/supabase-demo/README-GUIDE.md` §10.1.

---

## What is here

```
demo/
  migrations/    01–20, applied in order. The whole database.
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
`js/config.js` (generated endpoint + column map), two `<script>` tags in
`index.html`, and a bumped cache name in `sw.js`.

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
admin               4         20        187         38          7         80         13
manager             4         20        187         38          7         80         13
area                4          8         79         16          5         32          0
leader              4         20        187         38          5          0          0
engineer            4          8         79         16          5          0          0
client              1          5         48          9          3         20          6
```

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
   node tools/sql.js tools/audit.sql   # must print []
   node tools/verify-rls.js
   node tools/smoke.js
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
- `/dispatch/grid`, `/dispatch/cell`, `/visits/:id/followup`,
  `/engineers/scorecard`, in the Edge Function

— and the rest are not: most of dispatch, `finance/*`, analytics, capacity,
service-gaps, pipeline, search, certificates, and the report PDF. The Edge
Function answers those with `501` and `{items: [], total: 0}`, so an unfinished
screen reads as **empty rather than broken**.

**The auto-roster is deliberately not ported.** `roster.py` is 2,759 lines of
six interacting rules with an explicit precedence and a bend-but-report
behaviour; §9.3 rates a TypeScript port at 3–6 weeks and high risk. For a sales
demo the right answer is option C — seed a pre-computed roster into
`roster_runs` and show the output.
