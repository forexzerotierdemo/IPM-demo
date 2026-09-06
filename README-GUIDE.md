# Fox CRM — Demo Edition on Supabase
### A complete build book: schema, security, code, and steps
#### Guide edition — the full edition additionally embeds all 63,000 lines of source

**Generated:** 2026-09-06
**Source:** the live Fox CRM at `drudge.foxsystemstech.com` (read-only copy — the live system was not modified in any way to produce this file)
**Target:** a public demo other clients can log into and click around, running entirely on Supabase with **no VPS**.

---

## ⚠️ Read this first — two warnings

**1. Revoke the GitHub token.** A token beginning `ghp_A7iR…` was pasted into chat to produce this file. Anyone who has seen that message has write access to your repositories. Revoke it now at **https://github.com/settings/tokens** → find it → *Delete*. It was not needed (the source was read from this machine) and it was not stored anywhere.

**2. This demo must never point at live data.** Every instruction below creates a *new, separate* Supabase project seeded with *fake* data. Nothing here reads, writes, or connects to the live CRM's database, its `data/` folder, or its uploads. Keep it that way: the fastest way to turn a sales demo into an incident is a demo login that reaches a real customer's branch list.

---

## Contents

| § | Section | What it gives you |
|---|---|---|
| 1 | What you actually have today | The real measurements: 60 tables, 250 routes, 75 permissions |
| 2 | The one decision that makes this affordable | Why `app.js` (14,898 lines) does not change |
| 3 | Architecture: what moves where | Live piece → demo piece, side by side |
| 4 | The database | The **complete converted Postgres schema**, and the 3 conversion traps |
| 5 | Authentication | Supabase Auth, without renumbering 30 tables of foreign keys |
| 6 | Row Level Security | **The part with no equivalent today.** Policies for all 60 tables |
| 7 | The front end | **The `api.js` shim** — the routing table that replaces the server |
| 8 | Storage | Four buckets, private, with policies |
| 9 | Edge Functions | The 83 computed routes, and an honest read on the auto-roster |
| 10 | Demo data | Fake accounts and a believable month. Never live data |
| 11 | Build order | The 13 steps, in dependency order |
| 12 | What this will actually take | Timings, the 5 likely failures, and the free win |
| A | Permission matrix | 450 rows, generated from `ROLE_DEFAULTS` |
| B | Report wording | The 100 bilingual condition/recommendation rows |
| C | All 250 routes | Every route with its demo target |
| D–F | Full source | *In the full edition — see the note at the end of this file* |

**If you read only two sections, read §2 and §6.** §2 is why this is affordable; §6 is what makes it safe to put on the internet.

---

## 1. What you actually have today

Measured from the live tree, not estimated:

| Piece | Size | What it is |
|---|---|---|
| `server.py` | 15,410 lines | The whole API — 250 routes, permissions, reports, finance |
| `static/js/app.js` | 14,898 lines | The entire front end (single-page app, no framework) |
| `roster.py` | 2,759 lines | The auto-roster planner — the hardest and most valuable part |
| `check_ui.py` | 2,482 lines | UI test suite (522 checks) |
| `test_api.py` | 10,892 lines | API test suite (1,967 checks) |
| `database.py` | 1,954 lines | Schema + migrations |
| `static/js/i18n.js` | 2,274 lines | English/Arabic translation table |
| `static/css/styles.css` | 1,823 lines | All styling, including the print/PDF sheets |
| **Database** | **60 tables, 48 indexes** | SQLite, WAL mode, Africa/Cairo clock |
| **API** | **250 routes** | 161 plain CRUD · 83 computed · 6 file upload |
| **Permissions** | **64 permissions**, 6 roles | Role defaults + per-role overrides + per-user overrides |

### The stack today

```
Android APK (WebView)  ─┐
Browser ────────────────┴─→ Cloudflare ─→ VPS :8000
                                            │
                                    server.py (stdlib http.server)
                                            ├── auth.py      PBKDF2 + HMAC tokens
                                            ├── database.py  SQLite (data/crm.db)
                                            ├── roster.py    the planner
                                            └── uploads/     photos, maps, PDFs
```

### The stack for the demo

```
Browser ─→ Static hosting (Netlify/Vercel/Cloudflare Pages)
             │   index.html + app.js (UNCHANGED) + api.js (REPLACED)
             │
             ├─→ Supabase Auth        login, sessions, JWT
             ├─→ PostgREST + RLS      161 of the 250 routes, direct from the browser
             ├─→ Edge Functions       the 83 computed routes (Deno/TypeScript)
             └─→ Supabase Storage     photos, site maps, IPM PDFs, report images
```

---

## 2. The one decision that makes this affordable

`app.js` is 14,898 lines and it is the demo. Rewriting it is out of the question. You do not have to.

**Every single call it makes goes through one 157-line file, `static/js/api.js`**, and every one of them ends up at `fetch("/api" + path)`. `app.js` never calls `fetch` directly for data.

So the port is:

> **Keep `app.js`, `index.html`, `styles.css`, `i18n.js` exactly as they are. Replace `api.js` with a shim that recognises the path and answers it from Supabase instead of from your server.**

That single swap converts a 15,000-line rewrite into a routing table. Section 7 contains the shim.

---

## 3. Architecture: what moves where

| Live | Demo | Note |
|---|---|---|
| SQLite `data/crm.db` | Supabase Postgres | Schema in §4, converted and dependency-ordered |
| `auth.py` PBKDF2 + HMAC token | Supabase Auth (GoTrue) | Passwords **cannot** be migrated — see §5 |
| `users` table is the identity | `auth.users` + `public.users` profile | Linked by UUID, §5 |
| `require_perm()` in Python | `has_perm()` in SQL + RLS policies | §6 |
| `uploads/` on disk | Supabase Storage buckets | §8 |
| 161 CRUD routes | PostgREST (`supabase-js`) | §7 |
| 83 computed routes | Edge Functions (Deno) | §9 |
| `roster.py` (2,759 lines) | One Edge Function | §9.3 — **the main risk, read it** |
| Africa/Cairo `datetime('now','localtime')` | `now_cairo()` SQL function | §4.2 — keeps the text format |
| Service worker offline cache | Keep as-is | Works unchanged against any origin |

---

## 4. The database

### 4.1 How the conversion was done

The schema below is not hand-copied from `database.py`. `database.py` creates 60 tables and then applies **66 `ALTER TABLE` migrations**, so its `CREATE TABLE` blocks alone are missing columns. The schema here was read from the **actual live schema** (via a nightly backup copy, `crm-20260906-023001.db`, opened read-only), then mechanically converted:

| SQLite | Postgres | Why |
|---|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `bigint GENERATED BY DEFAULT AS IDENTITY` | `BY DEFAULT`, not `ALWAYS`, so the seed can insert explicit ids and keep foreign keys lined up |
| `INTEGER` | `bigint` | |
| `REAL` | `double precision` | Matches SQLite's float semantics exactly. Do **not** use `numeric` — PostgREST serialises `numeric` as a JSON *string* and `app.js` does arithmetic on these |
| `TEXT` | `text` | |
| `(datetime('now','localtime'))` | `now_cairo()` | §4.2 |
| Booleans stored as `INTEGER` 0/1 | **left as `bigint`** | `app.js` tests `=== 1` and `? 1 : 0` in hundreds of places. Converting to `boolean` breaks it silently |
| Circular foreign keys | 2 lifted to `ALTER TABLE` | SQLite doesn't care about creation order, Postgres does |

**Three traps that will bite you if you re-do this conversion yourself:**

1. **Do not convert 0/1 integers to `boolean`.** It looks like an improvement. `app.js` will start rendering blank toggles and the failures are silent.
2. **Do not convert the date/time `text` columns to `timestamptz`.** The app writes and compares `'YYYY-MM-DD HH:MM:SS'` strings, and sorts them as strings. PostgREST would hand back `2026-09-06T10:00:00+03:00`, and every string comparison and `.slice(0,10)` in `app.js` breaks.
3. **`REAL` → `double precision`, never `numeric`.** See the table above.

### 4.2 The clock — run this FIRST

The live system runs on Africa/Cairo and stores timestamps as text in the local zone. Create these before the tables (the schema's `DEFAULT`s call them):

```sql
-- Cairo wall-clock, in the exact text format the app reads and writes.
CREATE OR REPLACE FUNCTION now_cairo() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT to_char(now() AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI:SS') $$;

CREATE OR REPLACE FUNCTION today_cairo() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT to_char(now() AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') $$;
```

Also set the project's default timezone so anything that *does* use a real timestamp agrees:

```sql
ALTER DATABASE postgres SET timezone TO 'Africa/Cairo';
```

### 4.3 The full schema

Run this as one migration, in this order. Tables are dependency-sorted; the two circular foreign keys (`chemical_usage.visit_id`, `contract_sites.contract_id`) are added at the end.

```sql
CREATE TABLE areas (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name_en    text NOT NULL,
    name_ar    text,
    sort_order bigint NOT NULL DEFAULT 0,
    active     bigint NOT NULL DEFAULT 1,
    created_at text NOT NULL DEFAULT now_cairo()
, zone_id bigint);

CREATE TABLE chemicals (
    id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name_en           text NOT NULL,
    name_ar           text,
    active_ingredient text,
    unit              text NOT NULL DEFAULT 'L',
    quantity_in_stock double precision NOT NULL DEFAULT 0,
    reorder_level     double precision NOT NULL DEFAULT 0,
    hazard_class      text,
    reg_no            text,
    cost_per_unit     double precision NOT NULL DEFAULT 0,
    created_at        text NOT NULL DEFAULT now_cairo()
, material_key text, expiry_date text);

CREATE TABLE clients (
    id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name_en        text NOT NULL,
    name_ar        text,
    contact_person text,
    phone          text,
    email          text,
    address_en     text,
    address_ar     text,
    city           text,
    notes          text,
    status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    created_at     text NOT NULL DEFAULT now_cairo()
, dunning bigint NOT NULL DEFAULT 1, area_id bigint);

CREATE TABLE price_book (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name_en     text NOT NULL,
    name_ar     text,
    description text,
    unit_price  double precision NOT NULL DEFAULT 0,
    active      bigint NOT NULL DEFAULT 1,
    created_at  text NOT NULL DEFAULT now_cairo()
);

CREATE TABLE report_options (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    kind       text NOT NULL CHECK (kind IN ('condition','recommendation')),
    name_en    text NOT NULL,
    name_ar    text,
    sort_order bigint NOT NULL DEFAULT 0,
    active     bigint NOT NULL DEFAULT 1,
    created_at text NOT NULL DEFAULT now_cairo()
);

CREATE TABLE role_permissions (
    role    text NOT NULL CHECK (role IN ('admin','manager','agent','client')),
    perm    text NOT NULL,
    allowed bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (role, perm)
);

CREATE TABLE service_types (
    id      bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name_en text NOT NULL,
    name_ar text
);

CREATE TABLE settings (
    key   text PRIMARY KEY,
    value text
);

CREATE TABLE shift_types (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    code       text NOT NULL UNIQUE,
    name_en    text NOT NULL,
    name_ar    text,
    start_time text,                              -- 'HH:MM' (NULL for off/leave)
    end_time   text,
    color      text NOT NULL DEFAULT '#1f74d6',
    is_off     bigint NOT NULL DEFAULT 0,
    active     bigint NOT NULL DEFAULT 1,
    sort_order bigint NOT NULL DEFAULT 0
, open_ended bigint NOT NULL DEFAULT 0);

CREATE TABLE translations (
    src_hash   text NOT NULL,
    target     text NOT NULL,
    src_lang   text,
    text       text NOT NULL,
    created_at text NOT NULL DEFAULT now_cairo(),
    PRIMARY KEY (src_hash, target)
);

CREATE TABLE zones (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name_en    text NOT NULL,
    name_ar    text,
    sort_order bigint NOT NULL DEFAULT 0,
    active     bigint NOT NULL DEFAULT 1,
    created_at text NOT NULL DEFAULT now_cairo()
, own_day bigint NOT NULL DEFAULT 0);

CREATE TABLE "inventory_transactions" (
                id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                chemical_id bigint NOT NULL REFERENCES chemicals(id) ON DELETE CASCADE,
                change double precision NOT NULL,
                reason text NOT NULL CHECK (reason IN ('purchase','usage','adjustment','issue')),
                reference text, note text,
                created_at text NOT NULL DEFAULT now_cairo());

CREATE TABLE sites (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    client_id  bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name       text NOT NULL,
    address    text,
    area       text,
    created_at text NOT NULL DEFAULT now_cairo()
, map_image text, lat double precision, lng double precision, area_id bigint, service_from text, service_to text, visits_per_month double precision NOT NULL DEFAULT 0, visit_minutes bigint, freq_unit text NOT NULL DEFAULT 'week', visits_per_week double precision NOT NULL DEFAULT 0, preferred_agent_id bigint, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')), map_url text);

CREATE TABLE devices (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    code       text NOT NULL UNIQUE,           -- e.g. LIT0001 (printed as the QR)
    type       text NOT NULL,                  -- light_trap|glue_station|bait_station|fly_trap
    client_id  bigint REFERENCES clients(id) ON DELETE SET NULL,
    site_id    bigint REFERENCES sites(id) ON DELETE SET NULL,
    label      text,                           -- optional friendly location ("Kitchen")
    status     text NOT NULL DEFAULT 'ok',     -- last-known: ok|activity|needs_service|missing
    active     bigint NOT NULL DEFAULT 1,
    created_at text NOT NULL DEFAULT now_cairo()
, placement text);

CREATE TABLE site_service_days (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    site_id    bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    weekday    bigint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    start_time text,                              -- NULL = the branch's usual window
    end_time   text, agent_id bigint,
    UNIQUE (site_id, weekday)
);

CREATE TABLE "users" (
                id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                full_name text NOT NULL,
                email text NOT NULL UNIQUE,
                password_hash text NOT NULL,
                role text NOT NULL
                    CHECK (role IN ('admin','manager','agent','area_manager','team_leader','client')),
                phone text,
                client_id bigint REFERENCES clients(id) ON DELETE SET NULL,
                site_id bigint REFERENCES sites(id) ON DELETE SET NULL,
                team_leader_id bigint REFERENCES users(id) ON DELETE SET NULL,
                specialization text, hire_date text,
                license_no text, license_expiry text,
                lang text NOT NULL DEFAULT 'en',
                active bigint NOT NULL DEFAULT 1,
                token_version bigint NOT NULL DEFAULT 0,
                created_at text NOT NULL DEFAULT now_cairo());

CREATE TABLE agent_areas (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    agent_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    area_id    bigint NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    created_at text NOT NULL DEFAULT now_cairo(), weekdays text,
    UNIQUE (agent_id, area_id)
);

CREATE TABLE "agent_availability" (
            id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            agent_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            weekday    bigint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
            start_time text,
            end_time   text
        );

CREATE TABLE agent_shifts (
    id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    agent_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shift_date    text NOT NULL,                  -- 'YYYY-MM-DD'
    shift_type_id bigint NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
    start_time    text,
    end_time      text,
    note          text,
    assigned_by   bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at    text NOT NULL DEFAULT now_cairo()
, area_id bigint);

CREATE TABLE area_manager_areas (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    manager_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    area_id    bigint NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    created_at text NOT NULL DEFAULT now_cairo(),
    UNIQUE (manager_id, area_id)
);

CREATE TABLE audit_log (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id     bigint REFERENCES users(id) ON DELETE SET NULL,
    user_name   text,                          -- denormalized for history
    action      text NOT NULL,                 -- e.g. invoice.create
    entity      text,                          -- e.g. invoice
    entity_id   text,
    detail      text,                          -- short human-readable note
    ip          text,
    created_at  text NOT NULL DEFAULT now_cairo()
);

CREATE TABLE company_files (
    id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    title         text NOT NULL,
    description   text,
    filename      text NOT NULL,
    original_name text,
    size_bytes    bigint NOT NULL DEFAULT 0,
    visible_to_clients bigint NOT NULL DEFAULT 1,
    uploaded_by   bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at    text NOT NULL DEFAULT now_cairo(),
    updated_at    text
);

CREATE TABLE cost_budgets (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    category   text NOT NULL,
    year       text NOT NULL,                 -- 'YYYY'
    period     text NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly','annual')),
    amount     double precision NOT NULL DEFAULT 0,
    note       text,
    created_by bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at text NOT NULL DEFAULT now_cairo(),
    updated_at text,
    UNIQUE (category, year)
);

CREATE TABLE cost_recurring (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name       text NOT NULL,
    category   text NOT NULL DEFAULT 'other',
    amount     double precision NOT NULL DEFAULT 0,
    frequency  text NOT NULL DEFAULT 'monthly',
    start_date text NOT NULL,
    next_due   text,                        -- NULL = nothing more to post
    end_date   text,
    user_id    bigint REFERENCES users(id) ON DELETE SET NULL,  -- whose salary
    vendor     text,
    note       text,
    auto_post  bigint NOT NULL DEFAULT 1,  -- 0 = remind me, I will post it
    active     bigint NOT NULL DEFAULT 1,
    created_by bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at text NOT NULL DEFAULT now_cairo(),
    updated_at text
);

CREATE TABLE engineer_issues (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    agent_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note        text,
    created_by  bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at  text NOT NULL DEFAULT now_cairo()
, status text NOT NULL DEFAULT 'approved' CHECK (status IN ('requested','approved','declined')), handled_by bigint, handled_at text, decline_reason text, receipt_status text, receipt_at text, receipt_note text);

CREATE TABLE fixed_assignments (
        id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        site_id          bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        primary_agent_id bigint NOT NULL REFERENCES users(id),
        relief_agent_id  bigint REFERENCES users(id),
        primary_weekdays text NOT NULL DEFAULT '',
        relief_weekdays  text NOT NULL DEFAULT '',
        from_time        text NOT NULL,
        to_time          text NOT NULL,
        start_date       text,                    -- the contract's own period;

CREATE TABLE leads (
    id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name           text NOT NULL,
    company        text,
    phone          text,
    email          text,
    sector         text,
    message        text,
    preferred_date text,
    source         text NOT NULL DEFAULT 'manual',
    status         text NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','contacted','quoted','won','lost')),
    note           text,
    client_id      bigint REFERENCES clients(id) ON DELETE SET NULL,
    handled_by     bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at     text NOT NULL DEFAULT now_cairo(),
    updated_at     text
);

CREATE TABLE maps (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    client_id   bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    site_id     bigint REFERENCES sites(id) ON DELETE SET NULL,
    name        text NOT NULL,
    filename    text NOT NULL,
    uploaded_by bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at  text NOT NULL DEFAULT now_cairo()
);

CREATE TABLE marketing_targets (
    id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period           text NOT NULL,               -- 'YYYY-MM'
    target_amount    double precision NOT NULL DEFAULT 0,     -- contract value per month
    target_contracts bigint NOT NULL DEFAULT 0,  -- 0 = not counted
    note             text,
    created_by       bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at       text NOT NULL DEFAULT now_cairo(),
    updated_at       text
);

CREATE TABLE material_returns (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    agent_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note        text,
    created_by  bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at  text NOT NULL DEFAULT now_cairo(),
    status      text NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested','approved','declined')),
    handled_by  bigint REFERENCES users(id) ON DELETE SET NULL,
    handled_at  text,
    decline_reason text,
    receipt_status text,          -- NULL | 'received' | 'disputed'
    receipt_at     text,
    receipt_by     bigint REFERENCES users(id) ON DELETE SET NULL,
    receipt_note   text
);

CREATE TABLE notification_prefs (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    grp     text NOT NULL,
    enabled bigint NOT NULL DEFAULT 1,
    UNIQUE (user_id, grp)
);

CREATE TABLE notifications (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id     bigint REFERENCES users(id) ON DELETE CASCADE,
    type        text NOT NULL,
    title       text NOT NULL,
    body        text,
    link_view   text,
    link_id     bigint,
    is_read     bigint NOT NULL DEFAULT 0,
    dedup_key   text,
    created_at  text NOT NULL DEFAULT now_cairo()
);

CREATE TABLE "photos" (
                id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                entity_type text NOT NULL
                    CHECK (entity_type IN ('client','report','visit','chemical','expense','cash')),
                entity_id bigint NOT NULL,
                filename text NOT NULL, original_name text, caption text,
                is_business_plan bigint NOT NULL DEFAULT 0,
                uploaded_by bigint REFERENCES users(id) ON DELETE SET NULL,
                uploaded_at text NOT NULL DEFAULT now_cairo());

CREATE TABLE purchase_orders (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    supplier    text,
    reference   text,
    note        text,
    total_cost  double precision NOT NULL DEFAULT 0,
    created_by  bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at  text NOT NULL DEFAULT now_cairo()
);

CREATE TABLE roster_runs (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    from_date  text NOT NULL,
    to_date    text NOT NULL,
    created_by bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at text NOT NULL DEFAULT now_cairo(),
    visits     bigint NOT NULL DEFAULT 0,   -- booked outright
    assigned   bigint NOT NULL DEFAULT 0,   -- existing visits given an engineer
    shifts     bigint NOT NULL DEFAULT 0,
    undone_at  text,
    undone_by  bigint REFERENCES users(id) ON DELETE SET NULL,
    kept       bigint NOT NULL DEFAULT 0    -- rows an undo refused to touch
, cleared_at text, cleared_by bigint, cleared_visits bigint NOT NULL DEFAULT 0, cleared_shifts bigint NOT NULL DEFAULT 0);

CREATE TABLE user_permissions (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    perm    text NOT NULL,
    allowed bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, perm)
);

CREATE TABLE user_prefs (
        user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key     text NOT NULL,
        value   text,
        PRIMARY KEY (user_id, key)
    );

CREATE TABLE engineer_issue_items (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    issue_id    bigint NOT NULL REFERENCES engineer_issues(id) ON DELETE CASCADE,
    chemical_id bigint NOT NULL REFERENCES chemicals(id) ON DELETE CASCADE,
    quantity    double precision NOT NULL
, approved_quantity double precision, line_status text);

CREATE TABLE expenses (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    spent_on     text NOT NULL,             -- 'YYYY-MM-DD'
    category     text NOT NULL DEFAULT 'other',
    description  text,
    amount       double precision NOT NULL DEFAULT 0,
    vendor       text,
    method       text,                      -- cash / bank / card …
    reference    text,
    user_id      bigint REFERENCES users(id) ON DELETE SET NULL,
    recurring_id bigint REFERENCES cost_recurring(id) ON DELETE SET NULL,
    source       text NOT NULL DEFAULT 'manual',   -- manual | recurring
    note         text,
    created_by   bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at   text NOT NULL DEFAULT now_cairo(),
    updated_at   text
);

CREATE TABLE map_markers (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    map_id     bigint NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    type       text NOT NULL DEFAULT 'other',
    label      text,
    x          double precision NOT NULL,
    y          double precision NOT NULL,
    status     text NOT NULL DEFAULT 'ok',
    notes      text,
    created_at text NOT NULL DEFAULT now_cairo()
, qr_token text);

CREATE TABLE material_return_items (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    return_id   bigint NOT NULL REFERENCES material_returns(id) ON DELETE CASCADE,
    chemical_id bigint NOT NULL REFERENCES chemicals(id) ON DELETE CASCADE,
    quantity    double precision NOT NULL,
    -- What the office agreed to take back, line by line — same shape as an
    -- issue's approved_quantity, so a line can be cut or refused on its own.
    approved_quantity double precision,
    line_status text CHECK (line_status IS NULL OR line_status IN ('approved','declined'))
);

CREATE TABLE purchase_order_items (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    po_id       bigint NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    chemical_id bigint NOT NULL REFERENCES chemicals(id) ON DELETE CASCADE,
    quantity    double precision NOT NULL,
    unit_cost   double precision NOT NULL DEFAULT 0
);

CREATE TABLE roster_run_items (
    run_id   bigint NOT NULL REFERENCES roster_runs(id) ON DELETE CASCADE,
    kind     text NOT NULL CHECK (kind IN ('visit_created','visit_assigned','shift_created')),
    ref_id   bigint NOT NULL,
    agent_id bigint
);

CREATE TABLE roster_run_unplaced (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    run_id     bigint NOT NULL REFERENCES roster_runs(id) ON DELETE CASCADE,
    visit_date text NOT NULL,
    site_id    bigint REFERENCES sites(id) ON DELETE CASCADE,
    area_id    bigint REFERENCES areas(id) ON DELETE SET NULL,
    minutes    bigint,
    reason     text NOT NULL,
    dismissed_at text,                     -- "dealt with another way", by hand
    dismissed_by bigint REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE marker_events (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    marker_id   bigint NOT NULL REFERENCES map_markers(id) ON DELETE CASCADE,
    map_id      bigint NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    client_id   bigint REFERENCES clients(id) ON DELETE CASCADE,
    type        text,                       -- device type at time of record
    status      text NOT NULL,              -- ok / needs_service / activity / missing
    note        text,
    recorded_by bigint REFERENCES users(id) ON DELETE SET NULL,
    recorded_at text NOT NULL DEFAULT now_cairo()
, source text NOT NULL DEFAULT 'manual', lat double precision, lng double precision);

CREATE TABLE vat_returns (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    period       text NOT NULL UNIQUE,          -- '2026-06' or '2026-Q2'
    period_start text NOT NULL,
    period_end   text NOT NULL,
    due_date     text NOT NULL,
    output_vat   double precision NOT NULL DEFAULT 0,       -- charged on invoices issued
    input_vat    double precision NOT NULL DEFAULT 0,       -- reclaimable, entered by the owner
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
    expense_id   bigint REFERENCES expenses(id) ON DELETE SET NULL,
    note         text,
    created_at   text NOT NULL DEFAULT now_cairo(),
    updated_at   text
);

CREATE TABLE chemical_usage (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    visit_id bigint NOT NULL,
    chemical_id  bigint NOT NULL REFERENCES chemicals(id) ON DELETE CASCADE,
    quantity     double precision NOT NULL,
    area_treated text,
    created_at   text NOT NULL DEFAULT now_cairo()
, method text, equipment text);

CREATE TABLE contract_sites (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    contract_id bigint NOT NULL,
    site_id      bigint REFERENCES sites(id) ON DELETE SET NULL,
    map_location text,
    price        double precision NOT NULL DEFAULT 0
);

CREATE TABLE contracts (
    id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    client_id       bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    site_id         bigint REFERENCES sites(id) ON DELETE SET NULL,
    service_type_id bigint REFERENCES service_types(id) ON DELETE SET NULL,
    agent_id        bigint REFERENCES users(id) ON DELETE SET NULL,
    frequency       text NOT NULL DEFAULT 'monthly'
                    CHECK (frequency IN ('weekly','biweekly','monthly','quarterly','semiannual','annual')),
    start_date      text NOT NULL,
    end_date        text,
    next_run_date   text NOT NULL,
    price           double precision NOT NULL DEFAULT 0,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused','ended')),
    notes           text,
    created_at      text NOT NULL DEFAULT now_cairo()
, bill_every text, next_bill_date text, auto_invoice bigint NOT NULL DEFAULT 0, quote_id bigint REFERENCES invoices(id) ON DELETE SET NULL, sold_by bigint REFERENCES users(id) ON DELETE SET NULL, commission_rate double precision);

CREATE TABLE visits (
    id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    client_id       bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    site_id         bigint REFERENCES sites(id) ON DELETE SET NULL,
    agent_id        bigint REFERENCES users(id) ON DELETE SET NULL,
    service_type_id bigint REFERENCES service_types(id) ON DELETE SET NULL,
    scheduled_start text NOT NULL,
    scheduled_end   text,
    status          text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
    location        text,
    notes           text,
    created_at      text NOT NULL DEFAULT now_cairo(),
    completed_at    text
, visit_number bigint, checkin_at text, checkin_lat double precision, checkin_lng double precision, checkin_acc double precision, checkout_at text, checkout_lat double precision, checkout_lng double precision, checkout_acc double precision, contract_id bigint REFERENCES contracts(id) ON DELETE SET NULL);

CREATE TABLE device_inspections (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    device_id   bigint NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    visit_id    bigint REFERENCES visits(id) ON DELETE SET NULL,
    client_id   bigint REFERENCES clients(id) ON DELETE CASCADE,
    status      text NOT NULL,                 -- ok|activity|needs_service|missing
    findings    text,                          -- what the agent recorded for this device
    note        text,
    source      text NOT NULL DEFAULT 'scan',
    lat         double precision,
    lng         double precision,
    recorded_by bigint REFERENCES users(id) ON DELETE SET NULL,
    recorded_at text NOT NULL DEFAULT now_cairo()
, details text);

CREATE TABLE invoices (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    client_id   bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    visit_id    bigint REFERENCES visits(id) ON DELETE SET NULL,
    contract_id bigint REFERENCES contracts(id) ON DELETE SET NULL,
    doc_type    text NOT NULL DEFAULT 'invoice',   -- 'invoice' | 'quote'
    number      text NOT NULL,
    issue_date  text NOT NULL,
    due_date    text,
    valid_until text,                               -- quotes
    amount      double precision NOT NULL DEFAULT 0,
    tax         double precision NOT NULL DEFAULT 0,
    total       double precision NOT NULL DEFAULT 0,
    status      text NOT NULL DEFAULT 'draft',
    notes       text,
    created_at  text NOT NULL DEFAULT now_cairo()
, site_id bigint);

CREATE TABLE petty_cash (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    agent_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('advance','expense','return')),
    amount      double precision NOT NULL,
    -- expenses only: transport | purchase | repair | other
    category    text,
    spent_on    text NOT NULL DEFAULT today_cairo(),
    note        text,
    visit_id    bigint REFERENCES visits(id) ON DELETE SET NULL,
    -- An engineer's claim starts pending; anything the office records itself is
    -- approved as it is written.
    status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','declined')),
    created_by  bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at  text NOT NULL DEFAULT now_cairo(),
    handled_by  bigint REFERENCES users(id) ON DELETE SET NULL,
    handled_at  text,
    decline_reason text
);

CREATE TABLE reports (
    id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    visit_id        bigint NOT NULL UNIQUE REFERENCES visits(id) ON DELETE CASCADE,
    summary         text,
    pests_found     text,
    findings        text,
    recommendations text,
    severity        text DEFAULT 'low' CHECK (severity IN ('low','medium','high','critical')),
    next_visit_due  text,
    customer_name        text,
    customer_signature   text,   -- filename of captured signature image
    technician_signature text,
    created_at      text NOT NULL DEFAULT now_cairo()
, spare_parts_changed text, lamps_used double precision NOT NULL DEFAULT 0, cables_used double precision NOT NULL DEFAULT 0, transformers_used double precision NOT NULL DEFAULT 0, light_sheets_used double precision NOT NULL DEFAULT 0, fipronil_ml double precision NOT NULL DEFAULT 0, imidacloprid_gm double precision NOT NULL DEFAULT 0, baits_count double precision NOT NULL DEFAULT 0, glo_pieces double precision NOT NULL DEFAULT 0, flybase_bags double precision NOT NULL DEFAULT 0, branch_issue text, status text NOT NULL DEFAULT 'draft', completed_at text, transport_vehicle text, transport_cost double precision NOT NULL DEFAULT 0, condition text);

CREATE TABLE transport_entries (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    visit_id   bigint NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
    vehicle    text,
    cost       double precision NOT NULL DEFAULT 0,
    created_by bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at text NOT NULL DEFAULT now_cairo()
, from_place text, to_place text);

CREATE TABLE visit_ratings (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    visit_id    bigint NOT NULL UNIQUE REFERENCES visits(id) ON DELETE CASCADE,
    client_id   bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    stars       bigint NOT NULL CHECK (stars BETWEEN 1 AND 5),
    comment     text,
    created_by  bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at  text NOT NULL DEFAULT now_cairo()
);

CREATE TABLE visit_requests (
    id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    client_id      bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    site_id        bigint REFERENCES sites(id) ON DELETE SET NULL,
    preferred_date text,
    note           text,
    status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','declined')),
    visit_id       bigint REFERENCES visits(id) ON DELETE SET NULL,
    created_by     bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at     text NOT NULL DEFAULT now_cairo(),
    handled_by     bigint REFERENCES users(id) ON DELETE SET NULL,
    handled_at     text
);

CREATE TABLE invoice_items (
    id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    invoice_id  bigint NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description text NOT NULL,
    quantity    double precision NOT NULL DEFAULT 1,
    unit_price  double precision NOT NULL DEFAULT 0,
    amount      double precision NOT NULL DEFAULT 0
);

CREATE TABLE payments (
    id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    invoice_id bigint NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    amount     double precision NOT NULL,
    method     text NOT NULL DEFAULT 'cash',
    paid_at    text NOT NULL DEFAULT now_cairo(),
    note       text
);

CREATE TABLE payment_intents (
    id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    invoice_id   bigint NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    client_id    bigint REFERENCES clients(id) ON DELETE SET NULL,
    provider     text NOT NULL,
    provider_ref text,
    token        text NOT NULL UNIQUE,
    amount       double precision NOT NULL,
    currency     text NOT NULL DEFAULT 'EGP',
    status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','paid','failed','cancelled')),
    payment_id   bigint REFERENCES payments(id) ON DELETE SET NULL,
    created_at   text NOT NULL DEFAULT now_cairo(),
    updated_at   text
);

-- Circular foreign keys, added after every table exists
ALTER TABLE chemical_usage ADD CONSTRAINT chemical_usage_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;

ALTER TABLE contract_sites ADD CONSTRAINT contract_sites_contract_id_fkey
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE;

CREATE INDEX idx_agent_areas_agent ON agent_areas(agent_id);
CREATE INDEX idx_agent_avail_agent ON agent_availability(agent_id);
CREATE INDEX idx_agent_shifts_agent_day ON agent_shifts(agent_id, shift_date);
CREATE INDEX idx_agent_shifts_date ON agent_shifts(shift_date);
CREATE INDEX idx_am_areas_area ON area_manager_areas(area_id);
CREATE INDEX idx_am_areas_manager ON area_manager_areas(manager_id);
CREATE INDEX idx_areas_order ON areas(sort_order, id);
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_avail_agent ON agent_availability(agent_id, weekday);
CREATE INDEX idx_cash_agent ON petty_cash(agent_id, status);
CREATE INDEX idx_company_files_filename ON company_files(filename);
CREATE INDEX idx_contract_sites_contract ON contract_sites(contract_id);
CREATE INDEX idx_contracts_client ON contracts(client_id);
CREATE INDEX idx_contracts_sold_by ON contracts(sold_by);
CREATE INDEX idx_cost_recurring_due ON cost_recurring(next_due);
CREATE INDEX idx_devices_client ON devices(client_id);
CREATE INDEX idx_devices_type ON devices(type);
CREATE INDEX idx_dinsp_device ON device_inspections(device_id);
CREATE INDEX idx_dinsp_visit ON device_inspections(visit_id);
CREATE INDEX idx_expenses_cycle ON expenses(recurring_id, spent_on);
CREATE INDEX idx_expenses_date ON expenses(spent_on);
CREATE INDEX idx_fixed_site ON fixed_assignments(site_id, active);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_issue_items ON engineer_issue_items(issue_id);
CREATE INDEX idx_issues_agent ON engineer_issues(agent_id);
CREATE INDEX idx_items_invoice ON invoice_items(invoice_id);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_maps_client ON maps(client_id);
CREATE INDEX idx_marker_events_client ON marker_events(client_id, recorded_at);
CREATE INDEX idx_marker_events_marker ON marker_events(marker_id);
CREATE INDEX idx_markers_map ON map_markers(map_id);
CREATE INDEX idx_notif_user ON notifications(user_id, is_read);
CREATE INDEX idx_payment_intents_invoice ON payment_intents(invoice_id);
CREATE INDEX idx_photos_entity ON photos(entity_type, entity_id);
CREATE INDEX idx_photos_filename ON photos(filename);
CREATE INDEX idx_report_options_kind ON report_options(kind, sort_order);
CREATE INDEX idx_return_items ON material_return_items(return_id);
CREATE INDEX idx_returns_agent ON material_returns(agent_id);
CREATE INDEX idx_roster_run_items_run ON roster_run_items(run_id);
CREATE INDEX idx_roster_run_unplaced_run ON roster_run_unplaced(run_id);
CREATE INDEX idx_site_service_days_site ON site_service_days(site_id);
CREATE INDEX idx_visit_requests_client ON visit_requests(client_id);
CREATE INDEX idx_visits_agent ON visits(agent_id);
CREATE INDEX idx_visits_client ON visits(client_id);
CREATE INDEX idx_visits_contract ON visits(contract_id);;
```

### 4.4 One fix the demo needs (and a bug it reveals in the live system)

The live `role_permissions` table carries this constraint:

```sql
role text NOT NULL CHECK (role IN ('admin','manager','agent','client'))
```

But the system has **six** roles — `area_manager` and `team_leader` were added later and the constraint was never widened. In the live CRM this is dormant: role defaults live in Python (`ROLE_DEFAULTS`), and the table only stores the 9 *override* rows that exist, all for allowed roles. But `update_role_permissions()` accepts any of the six roles and then inserts — so **saving a permission override for an area manager or a team leader on the live system would fail on that constraint.** Nobody has tried.

*(Left alone on the live system as instructed — flagging it, not fixing it.)*

For the demo, SQL is the source of truth for permissions, so the constraint must be widened. Run this after the schema:

```sql
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check
  CHECK (role IN ('admin','manager','agent','area_manager','team_leader','client'));
```

---

## 5. Authentication

### 5.1 What changes

The live system is self-contained: `users.password_hash` holds PBKDF2-HMAC-SHA256 (120,000 rounds), and `auth.py` issues its own HMAC-signed token with a `token_version` so the server can invalidate sessions. Supabase Auth replaces all of it with GoTrue and real JWTs.

**Passwords cannot be migrated.** PBKDF2 hashes cannot be handed to GoTrue, and you should not want to — this is a demo, so every account gets a fresh, publishable password. Section 10 seeds them.

### 5.2 Keep `users.id` as `bigint`

Roughly thirty tables have `REFERENCES users(id)`. Do **not** convert the primary key to a UUID — that ripples through the entire schema and every join in `app.js`. Instead, link sideways:

```sql
ALTER TABLE users ADD COLUMN auth_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX idx_users_auth_id ON users(auth_id);
```

`auth.users` owns the credential; `public.users` stays the profile row everything else points at.

### 5.3 The identity helpers

Every RLS policy is built on these. Mark them `STABLE` and `SECURITY DEFINER` so they can read `users` without recursing into that table's own policies.

```sql
-- The public.users row for whoever is holding this JWT.
CREATE OR REPLACE FUNCTION app_uid() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT id FROM users WHERE auth_id = auth.uid() AND active = 1 $$;

CREATE OR REPLACE FUNCTION app_role() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT role FROM users WHERE auth_id = auth.uid() AND active = 1 $$;

-- For a client-portal login: the company, and optionally the single branch.
CREATE OR REPLACE FUNCTION app_client_id() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT client_id FROM users WHERE auth_id = auth.uid() AND role = 'client' $$;

CREATE OR REPLACE FUNCTION app_site_id() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT site_id FROM users WHERE auth_id = auth.uid() AND role = 'client' $$;

-- An area manager answers for PLACES.
CREATE OR REPLACE FUNCTION app_area_ids() RETURNS SETOF bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT area_id FROM area_manager_areas WHERE user_id = app_uid() $$;

-- A team leader answers for PEOPLE: their own id plus everyone reporting to them.
CREATE OR REPLACE FUNCTION app_team_ids() RETURNS SETOF bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT app_uid()
   UNION
   SELECT id FROM users WHERE team_leader_id = app_uid() $$;
```

### 5.4 `has_perm()` in SQL

This reproduces `has_perm()` from `server.py` exactly: admin is a hard bypass, then per-user overrides win over role, and role comes from the materialised matrix.

```sql
CREATE OR REPLACE FUNCTION app_has_perm(p text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  SELECT CASE
    WHEN app_role() = 'admin' THEN true
    ELSE COALESCE(
      (SELECT allowed = 1 FROM user_permissions WHERE user_id = app_uid() AND perm = p),
      (SELECT allowed = 1 FROM role_permissions WHERE role = app_role()  AND perm = p),
      false)
  END
$$;
```

### 5.5 Seed the permission matrix

In the live system the defaults live in Python and the table holds only overrides. In the demo, SQL is the only reader, so the whole matrix must exist as rows. This was generated directly from `ROLE_DEFAULTS` in `server.py` — **75 permissions × 6 roles = 450 rows**:

| Role | Permissions granted |
|---|---|
| `admin` | 75 of 75 |
| `manager` | 68 of 75 |
| `area_manager` | 22 of 75 |
| `team_leader` | 21 of 75 |
| `agent` | 17 of 75 |
| `client` | 8 of 75 |

The full 450-row `INSERT` is in **Appendix A**.

---

## 6. Row Level Security

This is the part with no equivalent in the live system, and the part you must not rush. Today, `server.py` is the only thing that touches the database — every request passes `require_perm()` and hand-written `WHERE` clauses before a row is read. In the demo the **browser talks to Postgres directly**, so the database itself has to enforce all of it. A missing policy is not a bug that shows up as an error; it is a demo that quietly serves every client's data to every visitor.

### 6.1 Turn it on everywhere, first

Default-deny across all 60 tables, before writing a single policy:

```sql
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
```

With RLS on and no policies, every table returns zero rows to everyone. That is the correct starting point: you now add back exactly what each role should see.

### 6.2 The bulk of the tables: permission-gated, not row-scoped

Most tables are office records with no per-row ownership — a chemical, a price, a shift type. For these, the rule is simply "do you hold the module permission". This generates all four policies for each, from a table→module map:

```sql
DO $$
DECLARE
  m text[][] := ARRAY[
    -- table                    module
    ['chemicals',               'chemicals'],
    ['chemical_usage',          'chemicals'],
    ['inventory_transactions',  'chemicals'],
    ['engineer_issues',         'issues'],
    ['engineer_issue_items',    'issues'],
    ['material_returns',        'issues'],
    ['material_return_items',   'issues'],
    ['invoices',                'invoices'],
    ['invoice_items',           'invoices'],
    ['payments',                'payments'],
    ['payment_intents',         'payments'],
    ['contracts',               'contracts'],
    ['contract_sites',          'contracts'],
    ['price_book',              'invoices'],
    ['leads',                   'leads'],
    ['marketing_targets',       'targets'],
    ['expenses',                'finance'],
    ['cost_recurring',          'finance'],
    ['cost_budgets',            'finance'],
    ['petty_cash',              'cash'],
    ['vat_returns',             'finance'],
    ['purchase_orders',         'finance'],
    ['purchase_order_items',    'finance'],
    ['devices',                 'devices'],
    ['device_inspections',      'devices'],
    ['maps',                    'maps'],
    ['map_markers',             'maps'],
    ['marker_events',           'maps'],
    ['company_files',           'ipm'],
    ['zones',                   'shifts'],
    ['areas',                   'shifts'],
    ['agent_areas',             'shifts'],
    ['agent_availability',      'shifts'],
    ['agent_shifts',            'shifts'],
    ['shift_types',             'shifts'],
    ['area_manager_areas',      'shifts'],
    ['fixed_assignments',       'shifts'],
    ['site_service_days',       'visits'],
    ['service_types',           'visits'],
    ['visit_requests',          'requests'],
    ['visit_ratings',           'visits'],
    ['transport_entries',       'transport'],
    ['report_options',          'visits'],
    ['roster_runs',             'dispatch'],
    ['roster_run_items',        'dispatch'],
    ['roster_run_unplaced',     'dispatch']
  ];
  i int;
  tbl text; mod text;
BEGIN
  FOR i IN 1 .. array_length(m, 1) LOOP
    tbl := m[i][1]; mod := m[i][2];

    EXECUTE format($f$
      CREATE POLICY %1$I_sel ON public.%1$I FOR SELECT TO authenticated
        USING (app_has_perm('%2$s.view'))$f$, tbl, mod);

    -- 'transport', 'certificates', 'dashboard' and 'analytics' are view-only
    -- modules with no create/edit/delete actions in the catalog; skip writes.
    IF mod NOT IN ('transport', 'analytics', 'certificates', 'dashboard') THEN
      EXECUTE format($f$
        CREATE POLICY %1$I_ins ON public.%1$I FOR INSERT TO authenticated
          WITH CHECK (app_has_perm('%2$s.create'))$f$, tbl, mod);
      EXECUTE format($f$
        CREATE POLICY %1$I_upd ON public.%1$I FOR UPDATE TO authenticated
          USING (app_has_perm('%2$s.edit')) WITH CHECK (app_has_perm('%2$s.edit'))$f$, tbl, mod);
      EXECUTE format($f$
        CREATE POLICY %1$I_del ON public.%1$I FOR DELETE TO authenticated
          USING (app_has_perm('%2$s.delete'))$f$, tbl, mod);
    END IF;
  END LOOP;
END $$;
```

> **Two modules need hand-editing after this runs.** `issues` has `approve` instead of `edit`, and `cash` has `approve` too — the generated `*_upd` policy will reference `issues.edit`/`cash.edit`, which do not exist in the catalog and therefore resolve to `false`. That is fail-*closed*, so it is safe, but approving a materials request or a petty-cash claim will not work until you replace those two update policies with ones testing `issues.approve` / `cash.approve`.

### 6.3 The tables that are row-scoped

These five carry the actual confidentiality rules, and they are where the live system's hand-written `WHERE` clauses have to be reproduced. The shape is always the same:

* **admin / manager** — everything
* **area_manager** — rows whose site sits in one of *their* areas
* **team_leader** — rows belonging to *their* engineers
* **agent** — their own rows only
* **client** — their own company (and their one branch, if pinned)

```sql
-- ---------------------------------------------------------------- sites
CREATE POLICY sites_sel ON sites FOR SELECT TO authenticated USING (
  app_has_perm('clients.view') AND (
    app_role() IN ('admin','manager')
    OR (app_role() = 'area_manager' AND area_id IN (SELECT app_area_ids()))
    OR (app_role() = 'team_leader'  AND EXISTS (
          SELECT 1 FROM visits v WHERE v.site_id = sites.id
             AND v.agent_id IN (SELECT app_team_ids())))
    OR (app_role() = 'agent' AND (
          preferred_agent_id = app_uid()
          OR EXISTS (SELECT 1 FROM visits v
                      WHERE v.site_id = sites.id AND v.agent_id = app_uid())))
    OR (app_role() = 'client' AND client_id = app_client_id()
          AND (app_site_id() IS NULL OR id = app_site_id()))
  ));

CREATE POLICY sites_ins ON sites FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('clients.create'));
CREATE POLICY sites_upd ON sites FOR UPDATE TO authenticated
  USING (app_has_perm('clients.edit')) WITH CHECK (app_has_perm('clients.edit'));
CREATE POLICY sites_del ON sites FOR DELETE TO authenticated
  USING (app_has_perm('clients.delete'));

-- ---------------------------------------------------------------- clients
CREATE POLICY clients_sel ON clients FOR SELECT TO authenticated USING (
  app_has_perm('clients.view') AND (
    app_role() IN ('admin','manager','agent','area_manager','team_leader')
    OR (app_role() = 'client' AND id = app_client_id())
  ));
CREATE POLICY clients_ins ON clients FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('clients.create'));
CREATE POLICY clients_upd ON clients FOR UPDATE TO authenticated
  USING (app_has_perm('clients.edit')) WITH CHECK (app_has_perm('clients.edit'));
CREATE POLICY clients_del ON clients FOR DELETE TO authenticated
  USING (app_has_perm('clients.delete'));

-- ---------------------------------------------------------------- visits
CREATE POLICY visits_sel ON visits FOR SELECT TO authenticated USING (
  app_has_perm('visits.view') AND (
    app_role() IN ('admin','manager')
    OR (app_role() = 'area_manager' AND EXISTS (
          SELECT 1 FROM sites s WHERE s.id = visits.site_id
             AND s.area_id IN (SELECT app_area_ids())))
    OR (app_role() = 'team_leader' AND agent_id IN (SELECT app_team_ids()))
    OR (app_role() = 'agent' AND agent_id = app_uid())
    OR (app_role() = 'client' AND EXISTS (
          SELECT 1 FROM sites s WHERE s.id = visits.site_id
             AND s.client_id = app_client_id()
             AND (app_site_id() IS NULL OR s.id = app_site_id())))
  ));

CREATE POLICY visits_ins ON visits FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('visits.create'));

-- An engineer may edit their OWN visit (check in, check out, write it up);
-- everyone else needs the same row scope they can read.
CREATE POLICY visits_upd ON visits FOR UPDATE TO authenticated
  USING (app_has_perm('visits.edit') AND (
        app_role() IN ('admin','manager')
     OR (app_role() = 'agent' AND agent_id = app_uid())
     OR (app_role() = 'team_leader'  AND agent_id IN (SELECT app_team_ids()))
     OR (app_role() = 'area_manager' AND EXISTS (
           SELECT 1 FROM sites s WHERE s.id = visits.site_id
              AND s.area_id IN (SELECT app_area_ids())))))
  WITH CHECK (app_has_perm('visits.edit'));

CREATE POLICY visits_del ON visits FOR DELETE TO authenticated
  USING (app_has_perm('visits.delete'));

-- ---------------------------------------------------------------- reports
CREATE POLICY reports_sel ON reports FOR SELECT TO authenticated USING (
  app_has_perm('visits.view') AND EXISTS (
    SELECT 1 FROM visits v WHERE v.id = reports.visit_id));   -- visits' own policy cascades

CREATE POLICY reports_ins ON reports FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('visits.edit'));
CREATE POLICY reports_upd ON reports FOR UPDATE TO authenticated
  USING (app_has_perm('visits.edit')) WITH CHECK (app_has_perm('visits.edit'));
-- Deleting a report is admin + manager only, matching DELETE /api/visits/<id>/report
CREATE POLICY reports_del ON reports FOR DELETE TO authenticated
  USING (app_has_perm('visits.delete') AND app_role() IN ('admin','manager'));

-- ---------------------------------------------------------------- photos
CREATE POLICY photos_sel ON photos FOR SELECT TO authenticated
  USING (app_has_perm('visits.view'));
CREATE POLICY photos_ins ON photos FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('visits.edit'));
CREATE POLICY photos_upd ON photos FOR UPDATE TO authenticated
  USING (app_has_perm('visits.edit')) WITH CHECK (app_has_perm('visits.edit'));
CREATE POLICY photos_del ON photos FOR DELETE TO authenticated
  USING (app_has_perm('visits.delete'));
```

> **The `reports_sel` policy leans on a subtlety worth understanding.** A subquery inside a policy *does* have the referenced table's own RLS applied to it. So `EXISTS (SELECT 1 FROM visits …)` returns true only for visits this user is already allowed to see — the visit scoping cascades to reports for free. This is the one place where Postgres does you a large favour; verify it holds with the test in §6.6 rather than trusting it.

### 6.4 `users`, and the recursion trap

`users` needs a policy, but every helper function reads `users` — so a naive policy calls `app_role()`, which selects from `users`, which invokes the policy, which calls `app_role()`. Postgres detects this and errors with `infinite recursion detected in policy for relation "users"`.

**The helpers avoid it because they are `SECURITY DEFINER`**, which bypasses RLS on the tables they read. Keep them that way and this policy is safe:

```sql
CREATE POLICY users_sel ON users FOR SELECT TO authenticated USING (
  auth_id = auth.uid()                                  -- always see yourself
  OR app_has_perm('users.view')
  OR (app_role() IN ('agent','area_manager','team_leader')   -- colleague directory
      AND role IN ('agent','area_manager','team_leader','manager'))
);
CREATE POLICY users_ins ON users FOR INSERT TO authenticated
  WITH CHECK (app_has_perm('users.create'));
CREATE POLICY users_upd ON users FOR UPDATE TO authenticated
  USING (app_has_perm('users.edit') OR auth_id = auth.uid())
  WITH CHECK (app_has_perm('users.edit') OR auth_id = auth.uid());
CREATE POLICY users_del ON users FOR DELETE TO authenticated
  USING (app_has_perm('users.delete'));
```

> ⚠️ The `users` table holds `password_hash`. Even though the demo's real credentials live in `auth.users`, **do not leave that column readable.** Either drop it in the demo (`ALTER TABLE users DROP COLUMN password_hash;`) or expose the app through a view that omits it. `app.js` never reads it.

### 6.5 The remaining tables

| Table | Policy |
|---|---|
| `settings` | `SELECT` for all authenticated (the app reads company name, logo, currency on every page); write requires `settings.edit` |
| `translations` | `SELECT` for all authenticated; write requires `settings.edit` |
| `role_permissions`, `user_permissions` | `SELECT` requires `permissions.view`; write requires `permissions.edit` |
| `audit_log` | `SELECT` admin only; **`INSERT` for all authenticated**, no `UPDATE`/`DELETE` policy at all — append-only, exactly as the live system treats it |
| `notifications`, `notification_prefs` | `user_id = app_uid()` only — each person sees their own |
| `user_prefs` | `user_id = app_uid()` only |

```sql
CREATE POLICY settings_sel ON settings FOR SELECT TO authenticated USING (true);
CREATE POLICY settings_w   ON settings FOR ALL    TO authenticated
  USING (app_has_perm('settings.edit')) WITH CHECK (app_has_perm('settings.edit'));

CREATE POLICY translations_sel ON translations FOR SELECT TO authenticated USING (true);
CREATE POLICY translations_w   ON translations FOR ALL TO authenticated
  USING (app_has_perm('settings.edit')) WITH CHECK (app_has_perm('settings.edit'));

CREATE POLICY rp_sel ON role_permissions FOR SELECT TO authenticated
  USING (app_has_perm('permissions.view'));
CREATE POLICY rp_w   ON role_permissions FOR ALL TO authenticated
  USING (app_has_perm('permissions.edit')) WITH CHECK (app_has_perm('permissions.edit'));
CREATE POLICY up_sel ON user_permissions FOR SELECT TO authenticated
  USING (app_has_perm('permissions.view') OR user_id = app_uid());
CREATE POLICY up_w   ON user_permissions FOR ALL TO authenticated
  USING (app_has_perm('permissions.edit')) WITH CHECK (app_has_perm('permissions.edit'));

CREATE POLICY audit_sel ON audit_log FOR SELECT TO authenticated
  USING (app_role() = 'admin');
CREATE POLICY audit_ins ON audit_log FOR INSERT TO authenticated
  WITH CHECK (true);              -- append-only: no UPDATE or DELETE policy exists

CREATE POLICY notif_own ON notifications FOR ALL TO authenticated
  USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY notifp_own ON notification_prefs FOR ALL TO authenticated
  USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY prefs_own ON user_prefs FOR ALL TO authenticated
  USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
```

### 6.6 Prove it before you show anyone

Do not take the policies on trust. Log in as each demo role and confirm the counts are what you expect:

```sql
-- Run as the demo agent's JWT (Supabase SQL editor: "Run as" → authenticated, or
-- from the browser console after logging in as that user).
SELECT app_role(), app_uid();
SELECT count(*) FROM visits;   -- must equal only THAT engineer's visits
SELECT count(*) FROM sites;    -- must not be the full 214
SELECT count(*) FROM users;    -- colleagues, not the whole company
SELECT count(*) FROM invoices; -- must be 0 — an agent holds no invoices.* permission
```

Then run Supabase's own linter, which catches tables you forgot:

```
mcp: get_advisors(type='security')     -- or the Advisors tab in the dashboard
```

It flags every table with RLS disabled or with a policy that lets `anon` read. **Fix every finding before the demo has a public URL.**

---

## 7. The front end: keep everything, replace one file

### 7.1 Why views, not raw table selects

`app.js` does not read tables. It reads the *response shapes* the Python handlers build. `GET /api/sites`, for example, returns flat rows like this:

```sql
SELECT s.id, s.client_id, s.name, s.address, s.area, s.area_id, s.map_image,
       s.lat, s.lng, s.service_from, s.service_to, s.visits_per_month,
       s.visit_minutes, s.status, s.map_url,
       c.status client_status,
       (SELECT COUNT(*) FROM visits v WHERE v.site_id = s.id
          AND v.status='scheduled'
          AND date(v.scheduled_start) >= date('now','localtime')) upcoming_visits,
       s.created_at, c.name_en client_en, c.name_ar client_ar,
       ar.name_en area_en, ar.name_ar area_ar
FROM sites s JOIN clients c ON c.id = s.client_id
LEFT JOIN areas ar ON ar.id = s.area_id
```

PostgREST's embedded resources would return `{ "clients": { "name_en": … } }` — a *nested object*, not `client_en`. Every template in `app.js` that prints `s.client_en` would render blank.

**So: build a view per list endpoint that reproduces the exact column names, and point the shim at the view.** The rewrite then stays inside SQL, where you can diff it against the original query.

```sql
-- security_invoker makes the view run as the CALLER, so the RLS policies from
-- §6 apply. Without it the view runs as its owner and leaks every row.
-- (Requires Postgres 15+, which Supabase is.)
CREATE VIEW v_sites WITH (security_invoker = true) AS
SELECT s.id, s.client_id, s.name, s.address, s.area, s.area_id, s.map_image,
       s.lat, s.lng, s.service_from, s.service_to, s.visits_per_month,
       s.visit_minutes, s.status, s.map_url,
       c.status  AS client_status,
       (SELECT count(*) FROM visits v
          WHERE v.site_id = s.id AND v.status = 'scheduled'
            AND left(v.scheduled_start, 10) >= today_cairo()) AS upcoming_visits,
       s.created_at,
       c.name_en AS client_en, c.name_ar AS client_ar,
       ar.name_en AS area_en, ar.name_ar AS area_ar
FROM sites s
JOIN clients c ON c.id = s.client_id
LEFT JOIN areas ar ON ar.id = s.area_id;
```

Note `left(v.scheduled_start, 10) >= today_cairo()` replacing `date(v.scheduled_start) >= date('now','localtime')`. Because the columns stayed `text` (§4.1), string slicing is the direct translation and it stays index-friendly.

> **`security_invoker = true` is not optional.** A view without it runs with its creator's privileges and bypasses every policy you wrote in §6. This is the single most likely way to build a demo that leaks. Grep your migration for `CREATE VIEW` and confirm every one has it.

### 7.2 The shim

Replace `static/js/api.js` with this. It keeps the exact same public surface — `API.get/post/put/del`, `API.token`, `API.user`, `API.uploadPhoto`, and the offline queue and read-cache hooks — so **`app.js` does not change by one character**.

The design is a routing table. Paths it knows become PostgREST calls; **everything it does not know falls through to a catch-all Edge Function**, so you can port the 83 computed routes one at a time and the app keeps working throughout.

```html
<!-- index.html: add before /js/api.js -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

```js
// static/js/api.js — Supabase edition.
// Same interface as the original: app.js is unaware this file changed.

const SUPABASE_URL  = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON = "YOUR-PUBLISHABLE-KEY";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ---------------------------------------------------------------- routing
// [method, regex, handler]. First match wins, so put specific paths above
// generic ones. `m` holds the regex capture groups.
const ROUTES = [
  // ---- auth -------------------------------------------------------------
  ["POST", /^\/auth\/login$/, async (m, body) => {
    const { data, error } = await sb.auth.signInWithPassword({
      email: body.email, password: body.password,
    });
    if (error) throw new Error("Invalid email or password");
    const me = await profile();
    return { token: data.session.access_token, user: me };
  }],
  ["POST", /^\/auth\/logout$/, async () => { await sb.auth.signOut(); return { ok: true }; }],
  ["GET",  /^\/auth\/me$/,     async () => ({ user: await profile() })],

  // ---- plain lists, straight off a view or table -------------------------
  ["GET", /^\/clients$/,  () => rows("v_clients", "name_en")],
  ["GET", /^\/sites$/,    () => rows("v_sites",   "client_en,name")],
  ["GET", /^\/users$/,    () => rows("v_users",   "full_name")],
  ["GET", /^\/agents$/,   () => sb.from("v_users").select("*")
                                  .in("role", ["agent","area_manager","team_leader"])
                                  .eq("active", 1).order("full_name").then(unwrap)],
  ["GET", /^\/areas$/,        () => rows("areas", "name_en")],
  ["GET", /^\/zones$/,        () => rows("zones", "name")],
  ["GET", /^\/service-types$/,() => rows("service_types", "name_en")],
  ["GET", /^\/shift-types$/,  () => rows("shift_types", "name")],
  ["GET", /^\/chemicals$/,    () => rows("chemicals", "name_en")],
  ["GET", /^\/devices$/,      () => rows("v_devices", "code")],
  ["GET", /^\/report-options$/, () => rows("report_options", "sort_order")],
  ["GET", /^\/settings$/,     async () => {
    const r = await rows("settings");
    return Object.fromEntries(r.map(x => [x.key, x.value]));   // app.js wants a map
  }],

  // ---- one row by id -----------------------------------------------------
  ["GET",    /^\/clients\/(\d+)$/, (m) => one("v_clients", m[1])],
  ["GET",    /^\/sites\/(\d+)$/,   (m) => one("v_sites",   m[1])],
  ["GET",    /^\/visits\/(\d+)$/,  (m) => one("v_visits",  m[1])],

  // ---- writes ------------------------------------------------------------
  ["POST",   /^\/clients$/,        (m, b) => ins("clients", b)],
  ["PUT",    /^\/clients\/(\d+)$/, (m, b) => upd("clients", m[1], b)],
  ["DELETE", /^\/clients\/(\d+)$/, (m)    => del("clients", m[1])],
  ["POST",   /^\/sites$/,          (m, b) => ins("sites", b)],
  ["PUT",    /^\/sites\/(\d+)$/,   (m, b) => upd("sites", m[1], b)],
  ["DELETE", /^\/sites\/(\d+)$/,   (m)    => del("sites", m[1])],
  ["POST",   /^\/visits$/,         (m, b) => ins("visits", b)],
  ["PUT",    /^\/visits\/(\d+)$/,  (m, b) => upd("visits", m[1], b)],
  ["DELETE", /^\/visits\/(\d+)$/,  (m)    => del("visits", m[1])],

  // ---- visits list: honours ?from/?to/?agent/?status/?sort ---------------
  ["GET", /^\/visits$/, async (m, b, q) => {
    let sel = sb.from("v_visits").select("*");
    if (q.from)   sel = sel.gte("scheduled_start", q.from);
    if (q.to)     sel = sel.lte("scheduled_start", q.to + " 23:59:59");
    if (q.agent)  sel = sel.eq("agent_id", q.agent);
    if (q.site)   sel = sel.eq("site_id", q.site);
    if (q.status) sel = sel.eq("status", q.status);
    // The office reads a diary forwards; ASC is the server's default too.
    sel = sel.order("scheduled_start", { ascending: (q.sort || "asc") !== "desc" });
    return paginate(sel, q);
  }],

  // ---- reports list ------------------------------------------------------
  ["GET", /^\/reports$/, async (m, b, q) => {
    let sel = sb.from("v_reports").select("*");
    if (q.from) sel = sel.gte("visit_date", q.from);
    if (q.to)   sel = sel.lte("visit_date", q.to);
    sel = sel.order("visit_date", { ascending: (q.sort || "asc") !== "desc" });
    return paginate(sel, q);
  }],
];

// ------------------------------------------------------------- PostgREST
const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const rows = (t, order) => {
  let q = sb.from(t).select("*");
  if (order) order.split(",").forEach(c => { q = q.order(c); });
  return q.then(unwrap);
};
const one = (t, id) => sb.from(t).select("*").eq("id", id).single().then(unwrap);
const ins = (t, b)  => sb.from(t).insert(b).select().single().then(unwrap);
const upd = (t, id, b) => sb.from(t).update(b).eq("id", id).select().single().then(unwrap);
const del = (t, id) => sb.from(t).delete().eq("id", id).then(() => ({ ok: true }));

// The server returns a bare array unless ?page or ?limit is given, and an
// {items,total,page,pages,limit} envelope when it is. Match that exactly.
async function paginate(sel, q) {
  if (!q.page && !q.limit) return sel.then(unwrap);
  const limit = Math.min(Math.max(parseInt(q.limit || 25, 10), 1), 200);
  const page  = Math.max(parseInt(q.page || 1, 10), 1);
  const from  = (page - 1) * limit;
  const { data, error, count } =
    await sel.range(from, from + limit - 1).select("*", { count: "exact" });
  if (error) throw new Error(error.message);
  return { items: data, total: count, page, pages: Math.ceil(count / limit) || 1, limit };
}

// The public.users row for the signed-in account, shaped like the old
// /api/auth/me payload (role, permissions map, client scoping).
async function profile() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const me = await sb.from("v_users").select("*").eq("auth_id", user.id).single().then(unwrap);
  const perms = await sb.rpc("my_permissions").then(unwrap);   // §7.3
  return { ...me, permissions: perms };
}

// ------------------------------------------------------- Edge fallback
// Anything the table above does not match goes to the catch-all function,
// which runs the ported handler. This is what lets you port incrementally.
async function edge(method, path, body, q) {
  const { data: { session } } = await sb.auth.getSession();
  const qs = new URLSearchParams(q).toString();
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/api${path}${qs ? "?" + qs : ""}`,
    { method,
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON,
        Authorization: "Bearer " + (session ? session.access_token : SUPABASE_ANON),
      },
      body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || "Request failed");
  return data;
}

function _readStoredUser() {
  try { return JSON.parse(localStorage.getItem("user") || "null"); } catch (e) { return null; }
}

const API = {
  token: localStorage.getItem("token") || null,
  user: _readStoredUser(),

  setAuth(token, user) {
    this.token = token; this.user = user;
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(user));
  },
  clearAuth() {
    this.token = null; this.user = null;
    localStorage.removeItem("token"); localStorage.removeItem("user");
    // Read cache deliberately NOT dropped — same reasoning as the original.
  },

  async _cached(path) {
    if (!window.ReadStore) return null;
    const row = await window.ReadStore.get(path);
    if (!row) return null;
    window.dispatchEvent(new CustomEvent("rs-stale", { detail: { path, ts: row.ts } }));
    return row.data;
  },

  async request(method, rawPath, body) {
    const [path, qs] = rawPath.split("?");
    const q = Object.fromEntries(new URLSearchParams(qs || ""));
    const mutating = method !== "GET";

    try {
      for (const [m, re, fn] of ROUTES) {
        if (m !== method) continue;
        const hit = re.exec(path);
        if (hit) {
          const data = await fn(hit, body, q);
          if (!mutating && data !== null && window.ReadStore) {
            window.ReadStore.put(rawPath, data);
            window.dispatchEvent(new CustomEvent("rs-fresh", { detail: { path: rawPath } }));
          }
          return data;
        }
      }
      const data = await edge(method, path, body, q);
      if (!mutating && data !== null && window.ReadStore) window.ReadStore.put(rawPath, data);
      return data;

    } catch (e) {
      // Offline behaviour, preserved exactly from the original file.
      const offline = !navigator.onLine || /fetch|network/i.test(e.message || "");
      if (offline && mutating && window.OfflineQueue) {
        await window.OfflineQueue.enqueue({ kind: "json", method, path: rawPath, body: body || {} });
        return { __queued: true };
      }
      if (offline && !mutating) {
        const hit = await this._cached(rawPath);
        if (hit !== null) return hit;
        throw new Error("offline_no_data");
      }
      if (/JWT|expired|not signed in/i.test(e.message || "")) {
        this.clearAuth(); location.reload(); return;
      }
      throw e;
    }
  },

  get(p) { return this.request("GET", p); },
  post(p, b) { return this.request("POST", p, b); },
  put(p, b) { return this.request("PUT", p, b); },
  del(p) { return this.request("DELETE", p); },

  // ------------------------------------------------------------- uploads
  async uploadPhoto(entityType, entityId, file, caption, businessPlan) {
    const path = `${entityType}/${entityId}/${Date.now()}-${file.name || "photo.jpg"}`;
    const { error } = await sb.storage.from("photos").upload(path, file, { upsert: false });
    if (error) {
      if (window.OfflineQueue) {
        await window.OfflineQueue.enqueue({
          kind: "photo", method: "POST", path: "/photos",
          entity_type: entityType, entity_id: entityId, caption: caption || "",
          business_plan: businessPlan ? "1" : "", file, filename: file.name || "photo.jpg" });
        return { __queued: true };
      }
      throw new Error(error.message);
    }
    // The photos row is what the report reads; the object is just the bytes.
    // Column names match the live schema exactly: `filename`, not file_path,
    // and `is_business_plan`, not business_plan.
    return ins("photos", {
      entity_type: entityType, entity_id: entityId,
      filename: path, original_name: file.name || null,
      caption: caption || null,
      is_business_plan: businessPlan ? 1 : 0,
    });
  },

  async uploadDoc(path, file, fields) {
    const key = `${Date.now()}-${file.name}`;
    const { error } = await sb.storage.from("documents").upload(key, file);
    if (error) throw new Error(error.message);
    return ins("company_files", {
      ...fields, filename: key, original_name: file.name, size_bytes: file.size });
  },

  async uploadSiteMap(siteId, file) {
    const key = `sites/${siteId}/${Date.now()}-${file.name}`;
    const { error } = await sb.storage.from("maps").upload(key, file, { upsert: true });
    if (error) throw new Error(error.message);
    return upd("sites", siteId, { map_image: key });
  },
};
```

### 7.3 The one RPC the shim needs

`/api/auth/me` returns the user's resolved permission map, which `app.js` uses to show and hide every button. Reproduce it as an RPC:

```sql
CREATE OR REPLACE FUNCTION my_permissions() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  SELECT CASE WHEN app_role() = 'admin'
    THEN (SELECT jsonb_object_agg(DISTINCT perm, true) FROM role_permissions)
    ELSE COALESCE((
      SELECT jsonb_object_agg(perm, allowed)
      FROM (
        SELECT rp.perm,
               COALESCE(up.allowed, rp.allowed) = 1 AS allowed
        FROM role_permissions rp
        LEFT JOIN user_permissions up
               ON up.perm = rp.perm AND up.user_id = app_uid()
        WHERE rp.role = app_role()
      ) x), '{}'::jsonb)
  END
$$;
```

### 7.4 What else changes in the front end

| File | Change |
|---|---|
| `static/js/app.js` | **None.** 14,898 lines untouched |
| `static/js/i18n.js` | **None** |
| `static/css/styles.css` | **None** |
| `static/js/offline.js`, `store.js` | **None** — the shim keeps their hooks |
| `static/index.html` | One line: the `supabase-js` CDN `<script>` before `api.js` |
| `static/js/api.js` | **Replaced** (above) |
| `static/sw.js` | Update the cache name; drop the `/api` network-first rule (calls no longer go to your origin) |

---

## 8. Storage

The live system writes every upload into one flat folder — **3,277 files, 193 MB** in `uploads/`, named by a random 32-hex string, with the original name kept in the database (`photos.filename`, `company_files.filename`).

For the demo, use four buckets. Keep them **private** and let the app request signed URLs; a public bucket means every demo photo is on the open internet forever.

```sql
INSERT INTO storage.buckets (id, name, public) VALUES
  ('photos',    'photos',    false),   -- visit photos, report images
  ('maps',      'maps',      false),   -- site map images and PDFs
  ('documents', 'documents', false),   -- the IPM file library
  ('branding',  'branding',  true);    -- company logo only; public is fine
```

Storage policies mirror §6 — Supabase stores objects in `storage.objects`, so the same helpers work:

```sql
CREATE POLICY photos_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'photos' AND app_has_perm('visits.view'));
CREATE POLICY photos_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'photos' AND app_has_perm('visits.edit'));

CREATE POLICY maps_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'maps' AND app_has_perm('maps.view'));
CREATE POLICY maps_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'maps' AND app_has_perm('maps.create'));

CREATE POLICY docs_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'documents' AND app_has_perm('ipm.view'));
CREATE POLICY docs_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents' AND app_has_perm('ipm.create'));
```

Reading a private object needs a signed URL. Add this helper and use it wherever `app.js` builds an `/uploads/<filename>` src:

```js
async function fileUrl(bucket, name) {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(name, 3600);
  if (error) return "";
  return data.signedUrl;
}
```

> **Do not copy the live `uploads/` folder into the demo.** Those 3,277 files are real customers' branches, real trap photos, real signed paperwork. Section 10 generates fresh placeholder images instead.

---

## 9. Edge Functions — the computed 83

### 9.1 What has to be rewritten

Of the 250 routes, **161 are plain CRUD** and the shim's routing table plus a view handles them. **6 are file uploads**, handled by Storage. The remaining **83 compute something** and need real code:

| Group | Routes | What it does | Difficulty |
|---|---|---|---|
| Auto-roster | `/shifts/auto`, `/auto/runs`, `/auto/over-asked`, `/auto/who-can-take` | The planner — §9.3 | **Hard** |
| Dispatch | `/dispatch/grid`, `/cell`, `/move`, `/optimize`, `/sla` | The month/week board and drag validation | Hard |
| Reports | `/reports`, `/reports/drafts`, report PDF | Bilingual report sheet + photo pagination | Medium |
| Dashboard | `/dashboard`, `/analytics`, `/capacity`, `/service-gaps` | Aggregates | Easy — mostly SQL views |
| Finance | `/finance/*`, `/invoices/*/bill`, `/contracts/run`, `/vat-returns` | Billing runs, cashflow | Medium |
| Scoring | `/engineers/scorecard`, `/cost-to-serve`, `/pipeline` | Aggregates | Easy |
| Misc | `/search`, `/notifications/generate`, `/geo/resolve`, `/branches/import` | | Easy–Medium |

Many of the "Easy" ones should not be Edge Functions at all — write them as Postgres views or RPCs and let the shim's table hit them directly. That is faster to write and faster to run. **Reserve Edge Functions for what genuinely needs a procedural language.**

### 9.2 The catch-all function

One function, routed internally, so the shim's fallback works and you can port incrementally:

```ts
// supabase/functions/api/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

type Ctx = { db: any; user: any; q: URLSearchParams; body: any; m: RegExpExecArray };
const ROUTES: [string, RegExp, (c: Ctx) => Promise<unknown>][] = [];
const route = (me: string, re: RegExp, fn: (c: Ctx) => Promise<unknown>) =>
  ROUTES.push([me, re, fn]);

// ---- the handlers you port go here ----
route("GET", /^\/dashboard$/, async ({ db }) => {
  const { data } = await db.rpc("dashboard_summary");
  return data;
});

route("POST", /^\/shifts\/auto$/, async (c) => (await import("./roster.ts")).plan(c));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/api/, "");

  // IMPORTANT: build the client with the CALLER's JWT, never the service-role
  // key. That keeps every RLS policy from §6 in force inside the function.
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } } },
  );

  const { data: { user } } = await db.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Not signed in" }),
      { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const body = ["POST", "PUT", "PATCH"].includes(req.method)
    ? await req.json().catch(() => ({})) : undefined;

  for (const [m, re, fn] of ROUTES) {
    if (m !== req.method) continue;
    const hit = re.exec(path);
    if (!hit) continue;
    try {
      const out = await fn({ db, user, q: url.searchParams, body, m: hit });
      return new Response(JSON.stringify(out),
        { headers: { ...cors, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e) }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
  }
  return new Response(JSON.stringify({ error: "Not found: " + path }),
    { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
});
```

> **The service-role key must never appear in an Edge Function that serves user requests**, and never in the browser. It bypasses every RLS policy in §6. Build the client from the caller's `Authorization` header, as above.

### 9.3 The auto-roster — read this before you promise a date

`roster.py` is **2,759 lines**, and it is the single most valuable and most subtle part of the system. It is not a scheduling loop; it is six interacting rules with an explicit precedence, built by correction over months:

1. **Two books** — night work and day work never mix, read from each engineer's own hours
2. **Every branch has an owner** — the customer sees the same face
3. **Cover when the owner cannot** — same shift, allowed area, preferring an engineer already in that zone
4. **The week is fixed, the day is free** — `visits_per_month` picks which roster week, the planner picks the day
5. **A day is one journey** — one zone a day, nearest-first, never return to an area — *a preference, which bends on the last pass only, by exactly one patch, and reports what it cost*
6. **Nothing is squeezed** — what did not fit comes back named, with a reason a human can act on

Rule 5's "bends but does not break, and says so" is where a naive rewrite goes wrong. So does the boundary in rule 6: engineer hours, branch opening hours, visit length, area permission, travel ceiling, and one-person-one-place are **walls**, never preferences.

**Three honest options:**

| Option | Effort | Risk |
|---|---|---|
| **A. Port to TypeScript** | 3–6 weeks | High. 40,375 `roster_run_items` rows exist as a regression corpus — use them, or you will not know it is wrong |
| **B. Keep Python, run it beside Supabase** | ~2 days | Low. One small Python host (Fly.io free tier) running only `roster.py` against Supabase Postgres. Contradicts "no VPS", but it is a container you never log into |
| **C. Demo the *output*, not the planner** | ~1 day | None. Ship the demo with a pre-computed roster seeded into `roster_runs`. The button shows a real, correct plan instantly |

**For a sales demo, C is almost certainly right.** Prospective clients want to see a filled month and a plan they can read. They are not going to stress-test the routing engine, and a planner that produces a subtly worse round in front of a customer is worse than one that replays a good one. Keep A on the roadmap for when a demo becomes a deployment.

`roster.py` writes nothing — it reads the book and returns a plan; `server.py` owns the decision to apply it. That purity is what makes B and C easy, and it is worth preserving in any rewrite.

---

## 10. Demo data

### 10.1 Never seed from live

The live book holds **65 real clients, 214 real branches, 959 visits, 21 staff, 1,265 QR devices and 3,277 uploaded files**. None of it goes near the demo. Fortunately the repo already ships a bilingual fake dataset in `seed.py` — invented companies (Al Noor Restaurant, Nile View Hotel, Green Valley School, Fresh Mart Supermarket), invented staff, invented phone numbers. That is the right starting point, and Appendix E has the whole file.

### 10.2 Reference data first

Service types, areas and the permission matrix are structure, not customer data, so they can be copied verbatim:

```sql
INSERT INTO service_types(id, name_en, name_ar) VALUES
  (1,'IPM','الإدارة المتكاملة للآفات'),
  (2,'Rodent Control','مكافحة القوارض'),
  (3,'Termite Treatment','مكافحة النمل الأبيض'),
  (4,'Cockroach Treatment','مكافحة الصراصير'),
  (5,'Bed Bugs Treatment','مكافحة بق الفراش'),
  (6,'Fumigation','التبخير'),
  (7,'Mosquito Control','مكافحة البعوض');

INSERT INTO areas(id, name_en, name_ar, sort_order) VALUES
  (1,'6th of October','السادس من أكتوبر',1),
  (2,'Sheikh Zayed','الشيخ زايد',2),
  (3,'Maadi','المعادي',3),
  (4,'Nasr City','مدينة نصر',4),
  (5,'Heliopolis','مصر الجديدة',5);

INSERT INTO settings(key, value) VALUES
  ('company_name_en','Fox Systems Pest Control (DEMO)'),
  ('company_name_ar','فوكس سيستمز لمكافحة الآفات (تجريبي)'),
  ('currency','EGP'), ('tax_rate','14'),
  ('phone','+20 100 000 0000'), ('email','demo@example.com'),
  ('address_en','Demo Address, Cairo'), ('address_ar','عنوان تجريبي، القاهرة');
```

Then the 450-row permission matrix from **Appendix A**, and `report_options` (the bilingual condition/recommendation wording the report prints — 100 rows live) from **Appendix B**.

### 10.3 Demo accounts

Create these through Supabase Auth so GoTrue owns the credentials, then link each to its `public.users` profile. Passwords are deliberately weak and public — that is the point of a demo — so **this project must contain nothing real, ever**.

| Email | Password | Role | Shows off |
|---|---|---|---|
| `admin@demo.foxcrm.app` | `demo1234` | admin | Everything, including permissions and finance |
| `manager@demo.foxcrm.app` | `demo1234` | manager | The office: 68 of 75 permissions, no finance |
| `area@demo.foxcrm.app` | `demo1234` | area_manager | Scoped to one patch — proves the RLS |
| `leader@demo.foxcrm.app` | `demo1234` | team_leader | Scoped to their engineers |
| `engineer@demo.foxcrm.app` | `demo1234` | agent | The phone view: own visits only |
| `client@demo.foxcrm.app` | `demo1234` | client | The customer portal: one company |

```bash
# Create the auth accounts (service-role key — run from your machine, never the browser)
for e in admin manager area leader engineer client; do
  curl -s -X POST "$SUPABASE_URL/auth/v1/admin/users" \
    -H "apikey: $SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$e@demo.foxcrm.app\",\"password\":\"demo1234\",\"email_confirm\":true}"
done
```

```sql
-- Link each auth account to its profile row.
INSERT INTO users (full_name, email, password_hash, role, lang, active, auth_id) VALUES
  ('Demo Admin',        'admin@demo.foxcrm.app',    '', 'admin',        'en', 1,
     (SELECT id FROM auth.users WHERE email = 'admin@demo.foxcrm.app')),
  ('Demo Manager',      'manager@demo.foxcrm.app',  '', 'manager',      'en', 1,
     (SELECT id FROM auth.users WHERE email = 'manager@demo.foxcrm.app')),
  ('Demo Area Manager', 'area@demo.foxcrm.app',     '', 'area_manager', 'en', 1,
     (SELECT id FROM auth.users WHERE email = 'area@demo.foxcrm.app')),
  ('Demo Team Leader',  'leader@demo.foxcrm.app',   '', 'team_leader',  'en', 1,
     (SELECT id FROM auth.users WHERE email = 'leader@demo.foxcrm.app')),
  ('Demo Engineer',     'engineer@demo.foxcrm.app', '', 'agent',        'en', 1,
     (SELECT id FROM auth.users WHERE email = 'engineer@demo.foxcrm.app'));

-- The area manager holds one patch; the engineer reports to the team leader.
INSERT INTO area_manager_areas(user_id, area_id)
  SELECT id, 1 FROM users WHERE email = 'area@demo.foxcrm.app';
UPDATE users SET team_leader_id = (SELECT id FROM users WHERE email='leader@demo.foxcrm.app')
  WHERE email = 'engineer@demo.foxcrm.app';
```

> `password_hash` is set to `''` because Supabase Auth owns credentials now. Better still, drop the column in the demo entirely (§6.4).

### 10.4 Give it enough volume to look real

Four clients and three visits looks like a prototype. A demo needs a full month with a believable spread. This generates it — adjust the counts to taste:

```sql
-- 20 branches across the 4 demo clients and 5 areas
INSERT INTO sites (client_id, name, address, area, area_id, visits_per_month,
                   visit_minutes, service_from, service_to, status)
SELECT 1 + (g % 4),
       'Branch ' || g,
       'Demo Street ' || g || ', Cairo',
       a.name_en, a.id,
       (ARRAY[1,2,4,4,8])[1 + (g % 5)],     -- monthly frequency spread
       (ARRAY[30,45,60,90])[1 + (g % 4)],
       '09:00', '17:00', 'active'
FROM generate_series(1, 20) g
JOIN areas a ON a.id = 1 + (g % 5);

-- A month of visits for the demo engineer, weekdays only, three a day
INSERT INTO visits (site_id, client_id, agent_id, service_type_id,
                    scheduled_start, scheduled_end, status)
SELECT s.id, s.client_id,
       (SELECT id FROM users WHERE email = 'engineer@demo.foxcrm.app'),
       1 + (s.id % 7),
       to_char(d, 'YYYY-MM-DD') || ' ' ||
         lpad((9 + (s.id % 3) * 2)::text, 2, '0') || ':00:00',
       to_char(d, 'YYYY-MM-DD') || ' ' ||
         lpad((10 + (s.id % 3) * 2)::text, 2, '0') || ':00:00',
       CASE WHEN d < current_date THEN 'completed' ELSE 'scheduled' END
FROM sites s
CROSS JOIN generate_series(date_trunc('month', current_date),
                           date_trunc('month', current_date) + interval '1 month' - interval '1 day',
                           interval '1 day') d
WHERE extract(dow FROM d) BETWEEN 1 AND 5      -- Mon-Fri
  AND s.id % 5 = extract(day FROM d)::int % 5; -- spread, not every site every day
```

Then reset the identity sequences, or the next insert from the UI collides:

```sql
DO $$
DECLARE t text; c text;
BEGIN
  FOR t, c IN
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_default LIKE 'nextval%'
        OR (is_identity = 'YES' AND table_schema = 'public')
  LOOP
    EXECUTE format(
      'SELECT setval(pg_get_serial_sequence(%L, %L), COALESCE((SELECT max(%I) FROM %I), 1))',
      t, c, c, t);
  END LOOP;
END $$;
```

### 10.5 Reset it nightly

A demo everyone can edit becomes a mess within a week. Snapshot the seeded state and restore it on a schedule with `pg_cron`:

```sql
SELECT cron.schedule('demo-reset', '0 3 * * *', $$
  TRUNCATE visits, reports, photos, notifications, audit_log RESTART IDENTITY CASCADE;
  -- then re-run the §10.4 volume block
$$);
```

---

## 11. Build order

Do it in this order — several steps depend on the one before.

1. **Create a new Supabase project.** Region closest to your clients. Note the URL, the publishable (anon) key, and the service-role key. *Do not put the service-role key in the front end.*
2. **§4.2 clock functions** — before the schema, because `DEFAULT`s call them.
3. **§4.3 schema** — one migration. Then **§4.4** to widen the `role_permissions` check.
4. **§5.2 `auth_id` column**, then **§5.3–5.4 helper functions**.
5. **Appendix A** — the 450-row permission matrix.
6. **§6.1 enable RLS everywhere** (default deny), then **§6.2–6.5 policies**.
7. **§7.1 views** — one per list endpoint, every one with `security_invoker = true`.
8. **§7.3 `my_permissions()` RPC.**
9. **§8 storage buckets and policies.**
10. **§10 seed** — reference data, accounts, volume, sequence reset.
11. **Front end**: copy `static/`, replace `api.js` (§7.2), add the CDN script to `index.html`, set the two constants. Deploy to Netlify / Vercel / Cloudflare Pages.
12. **§9.2 catch-all Edge Function**, then port computed routes as you need them.
13. **§6.6 verify**: log in as each of the six demo accounts, check the row counts, run the security advisor, fix everything it reports.

### Cost

Supabase's free tier covers this comfortably: 500 MB database (the demo needs well under 50 MB), 1 GB storage, 500K Edge Function calls. Static hosting is free on all three providers. **A demo should cost nothing.** Note that free projects pause after 7 days idle — if the demo must always be instant for a prospect, either ping it on a schedule or move it to the paid tier.

---

## 12. What this will actually take

Honest estimates, assuming one developer who knows the codebase:

| Phase | Work | Time |
|---|---|---|
| 1 | Schema + RLS + helpers + storage (§4–§8) | 3–5 days |
| 2 | The shim + views for the main lists (§7) | 4–6 days |
| 3 | Seed and demo accounts (§10) | 1–2 days |
| 4 | The easy computed routes as views/RPCs | 3–5 days |
| 5 | Dashboard, dispatch, reports as Edge Functions | 2–3 weeks |
| 6 | Auto-roster — **option C**, pre-computed | 1 day |
| | **A demo that shows well** | **≈ 3–5 weeks** |
| 6b | Auto-roster — **option A**, real TypeScript port | +3–6 weeks |

### The five things most likely to go wrong

1. **A view without `security_invoker = true`.** Bypasses every policy silently. Grep for it.
2. **The service-role key reaching the browser or a user-facing Edge Function.** Same result, worse. It is in `.env` and nowhere else.
3. **Converting 0/1 integers to `boolean`, or text dates to `timestamptz`.** `app.js` breaks in a hundred quiet places. §4.1.
4. **Response shapes drifting from the Python handlers.** `app.js` reads `client_en`, not `clients.name_en`. Build the view to match the old `SELECT` column for column, and diff them.
5. **Assuming the roster port is a week.** It is six interacting rules with an explicit precedence order and a deliberate bend-but-report behaviour. The 40,375 existing `roster_run_items` rows are your regression corpus — use them.

### What you get for free

`test_api.py` (1,967 checks) and `check_ui.py` (522 checks) already encode the correct behaviour of this system. They point at HTTP endpoints, so with the shim's fallback in place **you can run large parts of the existing suite against the demo** and find the shape mismatches automatically rather than by clicking. That is the cheapest quality you will ever buy on this port — wire it up early.

---

# Appendices

## Appendix A — The permission matrix (450 rows)

Generated directly from `ROLE_DEFAULTS` in `server.py`. Run after the schema and after widening the `role_permissions` check constraint (§4.4).

```sql
-- The Python ROLE_DEFAULTS matrix, materialised so SQL can read it.
-- 75 permissions x 6 roles.
INSERT INTO role_permissions(role, perm, allowed) VALUES
  ('admin','dashboard.view',1),
  ('admin','clients.view',1),
  ('admin','clients.create',1),
  ('admin','clients.edit',1),
  ('admin','clients.delete',1),
  ('admin','leads.view',1),
  ('admin','leads.create',1),
  ('admin','leads.edit',1),
  ('admin','leads.delete',1),
  ('admin','visits.view',1),
  ('admin','visits.create',1),
  ('admin','visits.edit',1),
  ('admin','visits.delete',1),
  ('admin','dispatch.view',1),
  ('admin','requests.view',1),
  ('admin','requests.create',1),
  ('admin','requests.edit',1),
  ('admin','calendar.view',1),
  ('admin','shifts.view',1),
  ('admin','shifts.create',1),
  ('admin','shifts.edit',1),
  ('admin','shifts.delete',1),
  ('admin','schedule.clear_all',1),
  ('admin','chemicals.view',1),
  ('admin','chemicals.create',1),
  ('admin','chemicals.edit',1),
  ('admin','chemicals.delete',1),
  ('admin','issues.view',1),
  ('admin','issues.create',1),
  ('admin','issues.approve',1),
  ('admin','issues.delete',1),
  ('admin','cash.view',1),
  ('admin','cash.create',1),
  ('admin','cash.approve',1),
  ('admin','cash.delete',1),
  ('admin','invoices.view',1),
  ('admin','invoices.create',1),
  ('admin','invoices.edit',1),
  ('admin','invoices.delete',1),
  ('admin','payments.view',1),
  ('admin','payments.create',1),
  ('admin','payments.delete',1),
  ('admin','contracts.view',1),
  ('admin','contracts.create',1),
  ('admin','contracts.edit',1),
  ('admin','contracts.delete',1),
  ('admin','finance.view',1),
  ('admin','finance.create',1),
  ('admin','finance.edit',1),
  ('admin','finance.delete',1),
  ('admin','targets.view',1),
  ('admin','targets.edit',1),
  ('admin','analytics.view',1),
  ('admin','transport.view',1),
  ('admin','certificates.view',1),
  ('admin','ipm.view',1),
  ('admin','ipm.create',1),
  ('admin','ipm.edit',1),
  ('admin','ipm.delete',1),
  ('admin','maps.view',1),
  ('admin','maps.create',1),
  ('admin','maps.edit',1),
  ('admin','maps.delete',1),
  ('admin','devices.view',1),
  ('admin','devices.create',1),
  ('admin','devices.edit',1),
  ('admin','devices.delete',1),
  ('admin','users.view',1),
  ('admin','users.create',1),
  ('admin','users.edit',1),
  ('admin','users.delete',1),
  ('admin','settings.view',1),
  ('admin','settings.edit',1),
  ('admin','permissions.view',1),
  ('admin','permissions.edit',1),
  ('manager','dashboard.view',1),
  ('manager','clients.view',1),
  ('manager','clients.create',1),
  ('manager','clients.edit',1),
  ('manager','clients.delete',1),
  ('manager','leads.view',1),
  ('manager','leads.create',1),
  ('manager','leads.edit',1),
  ('manager','leads.delete',1),
  ('manager','visits.view',1),
  ('manager','visits.create',1),
  ('manager','visits.edit',1),
  ('manager','visits.delete',1),
  ('manager','dispatch.view',1),
  ('manager','requests.view',1),
  ('manager','requests.create',1),
  ('manager','requests.edit',1),
  ('manager','calendar.view',1),
  ('manager','shifts.view',1),
  ('manager','shifts.create',1),
  ('manager','shifts.edit',1),
  ('manager','shifts.delete',1),
  ('manager','schedule.clear_all',0),
  ('manager','chemicals.view',1),
  ('manager','chemicals.create',1),
  ('manager','chemicals.edit',1),
  ('manager','chemicals.delete',1),
  ('manager','issues.view',1),
  ('manager','issues.create',1),
  ('manager','issues.approve',1),
  ('manager','issues.delete',1),
  ('manager','cash.view',1),
  ('manager','cash.create',1),
  ('manager','cash.approve',1),
  ('manager','cash.delete',1),
  ('manager','invoices.view',1),
  ('manager','invoices.create',1),
  ('manager','invoices.edit',1),
  ('manager','invoices.delete',1),
  ('manager','payments.view',1),
  ('manager','payments.create',1),
  ('manager','payments.delete',1),
  ('manager','contracts.view',1),
  ('manager','contracts.create',1),
  ('manager','contracts.edit',1),
  ('manager','contracts.delete',1),
  ('manager','finance.view',0),
  ('manager','finance.create',0),
  ('manager','finance.edit',0),
  ('manager','finance.delete',0),
  ('manager','targets.view',1),
  ('manager','targets.edit',1),
  ('manager','analytics.view',1),
  ('manager','transport.view',1),
  ('manager','certificates.view',1),
  ('manager','ipm.view',1),
  ('manager','ipm.create',1),
  ('manager','ipm.edit',1),
  ('manager','ipm.delete',1),
  ('manager','maps.view',1),
  ('manager','maps.create',1),
  ('manager','maps.edit',1),
  ('manager','maps.delete',1),
  ('manager','devices.view',1),
  ('manager','devices.create',1),
  ('manager','devices.edit',1),
  ('manager','devices.delete',1),
  ('manager','users.view',1),
  ('manager','users.create',1),
  ('manager','users.edit',1),
  ('manager','users.delete',1),
  ('manager','settings.view',1),
  ('manager','settings.edit',1),
  ('manager','permissions.view',0),
  ('manager','permissions.edit',0),
  ('agent','dashboard.view',1),
  ('agent','clients.view',1),
  ('agent','clients.create',0),
  ('agent','clients.edit',0),
  ('agent','clients.delete',0),
  ('agent','leads.view',0),
  ('agent','leads.create',0),
  ('agent','leads.edit',0),
  ('agent','leads.delete',0),
  ('agent','visits.view',1),
  ('agent','visits.create',0),
  ('agent','visits.edit',1),
  ('agent','visits.delete',0),
  ('agent','dispatch.view',0),
  ('agent','requests.view',0),
  ('agent','requests.create',0),
  ('agent','requests.edit',0),
  ('agent','calendar.view',1),
  ('agent','shifts.view',1),
  ('agent','shifts.create',0),
  ('agent','shifts.edit',0),
  ('agent','shifts.delete',0),
  ('agent','schedule.clear_all',0),
  ('agent','chemicals.view',0),
  ('agent','chemicals.create',0),
  ('agent','chemicals.edit',0),
  ('agent','chemicals.delete',0),
  ('agent','issues.view',1),
  ('agent','issues.create',1),
  ('agent','issues.approve',0),
  ('agent','issues.delete',0),
  ('agent','cash.view',1),
  ('agent','cash.create',1),
  ('agent','cash.approve',0),
  ('agent','cash.delete',0),
  ('agent','invoices.view',0),
  ('agent','invoices.create',0),
  ('agent','invoices.edit',0),
  ('agent','invoices.delete',0),
  ('agent','payments.view',0),
  ('agent','payments.create',0),
  ('agent','payments.delete',0),
  ('agent','contracts.view',0),
  ('agent','contracts.create',0),
  ('agent','contracts.edit',0),
  ('agent','contracts.delete',0),
  ('agent','finance.view',0),
  ('agent','finance.create',0),
  ('agent','finance.edit',0),
  ('agent','finance.delete',0),
  ('agent','targets.view',1),
  ('agent','targets.edit',0),
  ('agent','analytics.view',0),
  ('agent','transport.view',1),
  ('agent','certificates.view',1),
  ('agent','ipm.view',1),
  ('agent','ipm.create',0),
  ('agent','ipm.edit',0),
  ('agent','ipm.delete',0),
  ('agent','maps.view',1),
  ('agent','maps.create',1),
  ('agent','maps.edit',1),
  ('agent','maps.delete',0),
  ('agent','devices.view',0),
  ('agent','devices.create',0),
  ('agent','devices.edit',0),
  ('agent','devices.delete',0),
  ('agent','users.view',0),
  ('agent','users.create',0),
  ('agent','users.edit',0),
  ('agent','users.delete',0),
  ('agent','settings.view',0),
  ('agent','settings.edit',0),
  ('agent','permissions.view',0),
  ('agent','permissions.edit',0),
  ('area_manager','dashboard.view',1),
  ('area_manager','clients.view',1),
  ('area_manager','clients.create',0),
  ('area_manager','clients.edit',0),
  ('area_manager','clients.delete',0),
  ('area_manager','leads.view',0),
  ('area_manager','leads.create',0),
  ('area_manager','leads.edit',0),
  ('area_manager','leads.delete',0),
  ('area_manager','visits.view',1),
  ('area_manager','visits.create',0),
  ('area_manager','visits.edit',1),
  ('area_manager','visits.delete',0),
  ('area_manager','dispatch.view',1),
  ('area_manager','requests.view',0),
  ('area_manager','requests.create',0),
  ('area_manager','requests.edit',0),
  ('area_manager','calendar.view',1),
  ('area_manager','shifts.view',1),
  ('area_manager','shifts.create',1),
  ('area_manager','shifts.edit',1),
  ('area_manager','shifts.delete',0),
  ('area_manager','schedule.clear_all',0),
  ('area_manager','chemicals.view',0),
  ('area_manager','chemicals.create',0),
  ('area_manager','chemicals.edit',0),
  ('area_manager','chemicals.delete',0),
  ('area_manager','issues.view',1),
  ('area_manager','issues.create',1),
  ('area_manager','issues.approve',0),
  ('area_manager','issues.delete',0),
  ('area_manager','cash.view',1),
  ('area_manager','cash.create',1),
  ('area_manager','cash.approve',0),
  ('area_manager','cash.delete',0),
  ('area_manager','invoices.view',0),
  ('area_manager','invoices.create',0),
  ('area_manager','invoices.edit',0),
  ('area_manager','invoices.delete',0),
  ('area_manager','payments.view',0),
  ('area_manager','payments.create',0),
  ('area_manager','payments.delete',0),
  ('area_manager','contracts.view',0),
  ('area_manager','contracts.create',0),
  ('area_manager','contracts.edit',0),
  ('area_manager','contracts.delete',0),
  ('area_manager','finance.view',0),
  ('area_manager','finance.create',0),
  ('area_manager','finance.edit',0),
  ('area_manager','finance.delete',0),
  ('area_manager','targets.view',1),
  ('area_manager','targets.edit',0),
  ('area_manager','analytics.view',1),
  ('area_manager','transport.view',1),
  ('area_manager','certificates.view',1),
  ('area_manager','ipm.view',1),
  ('area_manager','ipm.create',0),
  ('area_manager','ipm.edit',0),
  ('area_manager','ipm.delete',0),
  ('area_manager','maps.view',1),
  ('area_manager','maps.create',1),
  ('area_manager','maps.edit',1),
  ('area_manager','maps.delete',0),
  ('area_manager','devices.view',1),
  ('area_manager','devices.create',0),
  ('area_manager','devices.edit',0),
  ('area_manager','devices.delete',0),
  ('area_manager','users.view',0),
  ('area_manager','users.create',0),
  ('area_manager','users.edit',0),
  ('area_manager','users.delete',0),
  ('area_manager','settings.view',0),
  ('area_manager','settings.edit',0),
  ('area_manager','permissions.view',0),
  ('area_manager','permissions.edit',0),
  ('team_leader','dashboard.view',1),
  ('team_leader','clients.view',1),
  ('team_leader','clients.create',0),
  ('team_leader','clients.edit',0),
  ('team_leader','clients.delete',0),
  ('team_leader','leads.view',0),
  ('team_leader','leads.create',0),
  ('team_leader','leads.edit',0),
  ('team_leader','leads.delete',0),
  ('team_leader','visits.view',1),
  ('team_leader','visits.create',0),
  ('team_leader','visits.edit',1),
  ('team_leader','visits.delete',0),
  ('team_leader','dispatch.view',1),
  ('team_leader','requests.view',0),
  ('team_leader','requests.create',0),
  ('team_leader','requests.edit',0),
  ('team_leader','calendar.view',1),
  ('team_leader','shifts.view',1),
  ('team_leader','shifts.create',1),
  ('team_leader','shifts.edit',1),
  ('team_leader','shifts.delete',0),
  ('team_leader','schedule.clear_all',0),
  ('team_leader','chemicals.view',0),
  ('team_leader','chemicals.create',0),
  ('team_leader','chemicals.edit',0),
  ('team_leader','chemicals.delete',0),
  ('team_leader','issues.view',1),
  ('team_leader','issues.create',1),
  ('team_leader','issues.approve',0),
  ('team_leader','issues.delete',0),
  ('team_leader','cash.view',1),
  ('team_leader','cash.create',1),
  ('team_leader','cash.approve',0),
  ('team_leader','cash.delete',0),
  ('team_leader','invoices.view',0),
  ('team_leader','invoices.create',0),
  ('team_leader','invoices.edit',0),
  ('team_leader','invoices.delete',0),
  ('team_leader','payments.view',0),
  ('team_leader','payments.create',0),
  ('team_leader','payments.delete',0),
  ('team_leader','contracts.view',0),
  ('team_leader','contracts.create',0),
  ('team_leader','contracts.edit',0),
  ('team_leader','contracts.delete',0),
  ('team_leader','finance.view',0),
  ('team_leader','finance.create',0),
  ('team_leader','finance.edit',0),
  ('team_leader','finance.delete',0),
  ('team_leader','targets.view',1),
  ('team_leader','targets.edit',0),
  ('team_leader','analytics.view',1),
  ('team_leader','transport.view',1),
  ('team_leader','certificates.view',1),
  ('team_leader','ipm.view',1),
  ('team_leader','ipm.create',0),
  ('team_leader','ipm.edit',0),
  ('team_leader','ipm.delete',0),
  ('team_leader','maps.view',1),
  ('team_leader','maps.create',1),
  ('team_leader','maps.edit',1),
  ('team_leader','maps.delete',0),
  ('team_leader','devices.view',0),
  ('team_leader','devices.create',0),
  ('team_leader','devices.edit',0),
  ('team_leader','devices.delete',0),
  ('team_leader','users.view',0),
  ('team_leader','users.create',0),
  ('team_leader','users.edit',0),
  ('team_leader','users.delete',0),
  ('team_leader','settings.view',0),
  ('team_leader','settings.edit',0),
  ('team_leader','permissions.view',0),
  ('team_leader','permissions.edit',0),
  ('client','dashboard.view',1),
  ('client','clients.view',0),
  ('client','clients.create',0),
  ('client','clients.edit',0),
  ('client','clients.delete',0),
  ('client','leads.view',0),
  ('client','leads.create',0),
  ('client','leads.edit',0),
  ('client','leads.delete',0),
  ('client','visits.view',1),
  ('client','visits.create',0),
  ('client','visits.edit',0),
  ('client','visits.delete',0),
  ('client','dispatch.view',0),
  ('client','requests.view',1),
  ('client','requests.create',1),
  ('client','requests.edit',0),
  ('client','calendar.view',0),
  ('client','shifts.view',0),
  ('client','shifts.create',0),
  ('client','shifts.edit',0),
  ('client','shifts.delete',0),
  ('client','schedule.clear_all',0),
  ('client','chemicals.view',0),
  ('client','chemicals.create',0),
  ('client','chemicals.edit',0),
  ('client','chemicals.delete',0),
  ('client','issues.view',0),
  ('client','issues.create',0),
  ('client','issues.approve',0),
  ('client','issues.delete',0),
  ('client','cash.view',0),
  ('client','cash.create',0),
  ('client','cash.approve',0),
  ('client','cash.delete',0),
  ('client','invoices.view',1),
  ('client','invoices.create',0),
  ('client','invoices.edit',0),
  ('client','invoices.delete',0),
  ('client','payments.view',0),
  ('client','payments.create',0),
  ('client','payments.delete',0),
  ('client','contracts.view',1),
  ('client','contracts.create',0),
  ('client','contracts.edit',0),
  ('client','contracts.delete',0),
  ('client','finance.view',0),
  ('client','finance.create',0),
  ('client','finance.edit',0),
  ('client','finance.delete',0),
  ('client','targets.view',0),
  ('client','targets.edit',0),
  ('client','analytics.view',0),
  ('client','transport.view',0),
  ('client','certificates.view',1),
  ('client','ipm.view',1),
  ('client','ipm.create',0),
  ('client','ipm.edit',0),
  ('client','ipm.delete',0),
  ('client','maps.view',0),
  ('client','maps.create',0),
  ('client','maps.edit',0),
  ('client','maps.delete',0),
  ('client','devices.view',0),
  ('client','devices.create',0),
  ('client','devices.edit',0),
  ('client','devices.delete',0),
  ('client','users.view',0),
  ('client','users.create',0),
  ('client','users.edit',0),
  ('client','users.delete',0),
  ('client','settings.view',0),
  ('client','settings.edit',0),
  ('client','permissions.view',0),
  ('client','permissions.edit',0)
ON CONFLICT (role, perm) DO UPDATE SET allowed = excluded.allowed;
```

## Appendix B — Report wording (`report_options`, 100 rows)

The condition and recommendation choices the office wrote in both languages. The report looks these up rather than machine-translating (Google Translate answers 429 from this host, which is why every auto-translated report used to print Arabic). Company content, not customer data — safe to seed.

```sql
-- 100 rows, the bilingual wording the report prints.
INSERT INTO report_options(id, kind, name_en, name_ar, sort_order, active, created_at) VALUES
  (22, 'recommendation', 'Maintain high standards of general cleanliness.', 'الحفاظ على مستوى عالٍ من النظافة العامة.', 1, 1, '2026-08-27 12:50:07'),
  (23, 'recommendation', 'Follow a regular cleaning and sanitation program', 'الالتزام ببرنامج دوري للتنظيف والتعقيم.', 2, 1, '2026-08-27 12:52:30'),
  (24, 'condition', 'Poor general cleanliness.', 'مستوى النظافة العامة غير مناسب.', 1, 1, '2026-08-27 12:53:08'),
  (25, 'recommendation', 'Remove food residues immediately', 'إزالة بقايا الطعام فورًا', 0, 1, '2026-08-27 12:53:37'),
  (26, 'recommendation', 'Keep food covered and properly sealed', 'حفظ الأغذية مغطاة ومحكمة الغلق', 0, 1, '2026-08-27 12:54:34'),
  (27, 'condition', 'Cleaning and sanitation program not followed.', 'عدم الالتزام ببرنامج التنظيف والتعقيم', 2, 1, '2026-08-27 12:55:14'),
  (28, 'recommendation', 'Consume food only in designated areas', 'تناول الطعام في الأماكن المخصصة فقط', 0, 1, '2026-08-27 12:55:50'),
  (29, 'condition', 'Food residues present.', 'وجود بقايا طعام', 3, 1, '2026-08-27 12:56:20'),
  (30, 'recommendation', 'Clean surfaces, equipment, and utensils after use', 'تنظيف الأسطح والمعدات والأدوات بعد الاستخدام', 0, 1, '2026-08-27 12:56:55'),
  (31, 'condition', 'Food left uncovered or improperly sealed', 'وجود أغذية مكشوفة أو غير محكمة الغلق', 4, 1, '2026-08-27 12:57:22'),
  (32, 'recommendation', 'Clean under and behind equipment regularly', 'تنظيف أسفل وخلف المعدات بانتظام', 0, 1, '2026-08-27 12:57:49'),
  (33, 'condition', 'Food consumed outside designated areas.', 'تناول الطعام خارج الأماكن المخصصة', 0, 1, '2026-08-27 12:58:10'),
  (34, 'recommendation', 'Remove damaged or expired products', 'إزالة المنتجات التالفة أو منتهية الصلاحية', 0, 1, '2026-08-27 12:58:35'),
  (35, 'recommendation', 'Store food in clean and dry areas', 'تخزين الأغذية في أماكن نظيفة وجافة', 0, 1, '2026-08-27 12:59:38'),
  (36, 'condition', 'Dirty surfaces, equipment, or utensils.', 'وجود أسطح أو معدات أو أدوات غير نظيفة', 0, 1, '2026-08-27 13:00:16'),
  (37, 'recommendation', 'Maintain proper storage and follow FIFO', 'تنظيم التخزين والالتزام بنظام FIFO', 0, 1, '2026-08-27 13:00:42'),
  (38, 'condition', 'Debris or waste under or behind equipment.', 'وجود حطام أو مخلفات أسفل أو خلف المعدات', 0, 1, '2026-08-27 13:00:56'),
  (39, 'recommendation', 'Keep products off the floor on pallets or shelves', 'رفع المنتجات عن الأرض باستخدام طبالي أو رفوف', 0, 1, '2026-08-27 13:02:11'),
  (40, 'condition', 'Damaged or expired products present.', 'وجود منتجات تالفة أو منتهية الصلاحية', 0, 1, '2026-08-27 13:02:36'),
  (41, 'recommendation', 'Maintain adequate clearance between goods and walls', 'ترك مسافات مناسبة بين البضائع والجدران', 0, 1, '2026-08-27 13:02:56'),
  (42, 'condition', 'Food stored in unclean or damp areas.', 'تخزين الأغذية في أماكن غير نظيفة أو رطبة', 0, 1, '2026-08-27 13:03:21'),
  (43, 'recommendation', 'Avoid improper stacking of goods', 'تجنب تكديس البضائع بصورة غير سليمة', 0, 1, '2026-08-27 13:03:46'),
  (44, 'condition', 'Improper storage or FIFO not followed.', 'سوء تنظيم التخزين أو عدم تطبيق FIFO', 0, 1, '2026-08-27 13:04:03'),
  (45, 'recommendation', 'Keep shelves and storage areas clean and organized', 'الحفاظ على نظافة وترتيب الرفوف ومناطق التخزين', 0, 1, '2026-08-27 13:04:32'),
  (46, 'condition', 'Products or goods stored directly on the floor.', 'وجود منتجات أو بضائع موضوعة على الأرض', 0, 1, '2026-08-27 13:04:44'),
  (47, 'condition', 'Inadequate clearance between goods and walls.', 'عدم وجود مسافة كافية بين البضائع والجدران', 0, 1, '2026-08-27 13:05:21'),
  (48, 'recommendation', 'Remove empty cartons and unused materials', 'إزالة الكراتين الفارغة والمواد غير المستخدمة.', 0, 1, '2026-08-27 13:05:21'),
  (49, 'condition', 'Improper or overcrowded storage.', 'وجود تكدس أو تخزين عشوائي للبضائع', 0, 1, '2026-08-27 13:05:54'),
  (50, 'recommendation', 'Remove waste regularly and use covered containers', 'إزالة المخلفات بانتظام واستخدام حاويات محكمة الغلق', 0, 1, '2026-08-27 13:06:07'),
  (51, 'condition', 'Dirty or disorganized shelves and storage areas.', 'وجود رفوف أو مناطق تخزين غير نظيفة أو غير مرتبة', 0, 1, '2026-08-27 13:06:26'),
  (52, 'recommendation', 'Clean and empty waste containers regularly', 'تنظيف وتفريغ حاويات المخلفات بانتظام', 0, 1, '2026-08-27 13:06:47'),
  (53, 'condition', 'Empty cartons or unused materials present.', 'وجود كراتين فارغة أو مواد غير مستخدمة', 0, 1, '2026-08-27 13:07:05'),
  (54, 'recommendation', 'Keep waste areas clean and free of debris', 'الحفاظ على مناطق المخلفات نظيفة وخالية من الحطام', 0, 1, '2026-08-27 13:07:26'),
  (55, 'condition', 'Accumulated waste or garbage.', 'وجود مخلفات أو قمامة متراكمة', 0, 1, '2026-08-27 13:07:56'),
  (56, 'recommendation', 'Repair water leaks and eliminate moisture sources', 'إصلاح تسربات المياه ومعالجة مصادر الرطوبة', 0, 1, '2026-08-27 13:08:15'),
  (57, 'condition', 'Waste containers full or unclean.', 'حاويات المخلفات ممتلئة أو غير نظيفة', 0, 1, '2026-08-27 13:08:35'),
  (58, 'condition', 'Debris or waste in the waste collection area.', 'وجود حطام أو مخلفات في منطقة تجميع القمامة', 0, 1, '2026-08-27 13:09:12'),
  (59, 'recommendation', 'Keep floors dry and clean spills immediately', 'الحفاظ على جفاف الأرضيات وإزالة الانسكابات فورًا', 0, 1, '2026-08-27 13:09:24'),
  (60, 'condition', 'Water leakage or moisture present.', 'وجود تسرب مياه أو مصادر رطوبة', 0, 1, '2026-08-27 13:09:53'),
  (61, 'recommendation', 'Clean and maintain drains regularly', 'تنظيف وصيانة المصارف بانتظام', 0, 1, '2026-08-27 13:10:07'),
  (62, 'condition', 'Wet floors or standing water present.', 'وجود أرضيات مبللة أو تجمعات مياه', 0, 1, '2026-08-27 13:10:31'),
  (63, 'recommendation', 'Keep drains properly sealed and screened', 'إحكام غلق المصارف وتركيب مصافي مناسبة', 0, 1, '2026-08-27 13:10:55'),
  (64, 'condition', 'Dirty or blocked drains.', 'وجود مصارف غير نظيفة أو مسدودة', 0, 1, '2026-08-27 13:11:05'),
  (65, 'recommendation', 'Keep doors and windows closed when not in use', 'إبقاء الأبواب والنوافذ مغلقة عند عدم الاستخدام', 0, 1, '2026-08-27 13:11:41'),
  (66, 'condition', 'Unsealed drains or missing drain screens.', 'وجود مصارف غير محكمة الغلق أو بدون مصافي مناسبة', 0, 1, '2026-08-27 13:11:43'),
  (67, 'condition', 'Doors or windows left open.', 'وجود أبواب أو نوافذ مفتوحة', 0, 1, '2026-08-27 13:12:18'),
  (68, 'recommendation', 'Repair doors and maintain Door Sweeps', 'إصلاح الأبواب وصيانة الـ Door Sweeps', 0, 1, '2026-08-27 13:12:23'),
  (69, 'condition', 'Damaged or improperly sealed doors.', 'وجود أبواب تالفة أو غير محكمة الغلق', 0, 1, '2026-08-27 13:12:53'),
  (70, 'recommendation', 'Install and maintain window and ventilation screens', 'تركيب وصيانة شبك النوافذ وفتحات التهوية', 0, 1, '2026-08-27 13:13:08'),
  (71, 'condition', 'Damaged or missing window or ventilation screens.', 'وجود تلف أو فتحات في شبك النوافذ أو التهوية', 0, 1, '2026-08-27 13:13:26'),
  (72, 'recommendation', 'Seal all cracks, gaps, and openings', 'سد جميع الشقوق والفتحات والفراغات', 0, 1, '2026-08-27 13:13:48'),
  (73, 'condition', 'Cracks, gaps, or openings present.', 'وجود شقوق أو فتحات أو فراغات في المبنى', 0, 1, '2026-08-27 13:14:03'),
  (74, 'condition', 'Gaps around pipes or cables.', 'وجود فراغات حول المواسير أو الكابلات', 0, 1, '2026-08-27 13:14:41'),
  (75, 'recommendation', 'Seal gaps around pipes and cables', 'سد الفراغات حول المواسير والكابلات', 0, 1, '2026-08-27 13:14:46'),
  (76, 'condition', 'Damaged or open suspended ceilings.', 'وجود تلف أو فتحات في الأسقف المعلقة', 0, 1, '2026-08-27 13:15:08'),
  (77, 'recommendation', 'Repair and seal suspended ceilings', 'إصلاح وإحكام غلق الأسقف المعلقة', 0, 1, '2026-08-27 13:15:25'),
  (78, 'condition', 'Debris or materials above suspended ceilings or in hidden areas.', 'وجود حطام أو مواد متراكمة في الأسقف المعلقة أو الأماكن المخفية', 0, 1, '2026-08-27 13:15:40'),
  (79, 'recommendation', 'Remove debris from suspended ceilings and hidden areas', 'إزالة الحطام من الأسقف المعلقة والأماكن المخفية', 0, 1, '2026-08-27 13:16:09'),
  (80, 'condition', 'Poor ventilation or excessive moisture in enclosed areas.', 'ضعف التهوية أو ارتفاع الرطوبة في المناطق المغلقة', 0, 1, '2026-08-27 13:16:11'),
  (81, 'recommendation', 'Improve ventilation in enclosed areas', 'تحسين التهوية في الأماكن المغلقة', 0, 1, '2026-08-27 13:16:47'),
  (82, 'condition', 'Air Curtain missing or not functioning properly.', 'ستارة الهواء غير موجودة أو لا تعمل بشكل صحيح', 0, 1, '2026-08-27 13:16:48'),
  (83, 'condition', 'Waste or debris around the building or garage.', 'وجود مخلفات أو حطام حول المبنى أو في الجراج', 0, 1, '2026-08-27 13:17:20'),
  (84, 'recommendation', 'Install and maintain Air Curtains', 'تركيب وصيانة الـ Air Curtains', 0, 1, '2026-08-27 13:18:02'),
  (85, 'condition', 'Grass or vegetation close to the building.', 'وجود حشائش أو نباتات ملاصقة للمبنى', 0, 1, '2026-08-27 13:18:07'),
  (86, 'condition', 'Unused tools, equipment, or materials present.', 'وجود أدوات أو معدات أو مواد غير مستخدمة بالموقع', 0, 1, '2026-08-27 13:18:47'),
  (87, 'recommendation', 'Keep external areas and garages clean and free of debris', 'الحفاظ على نظافة المناطق الخارجية والجراج وخلوها من الحطام', 0, 1, '2026-08-27 13:18:48'),
  (88, 'condition', 'Food or packaging materials stored near chemicals.', 'وجود مواد غذائية أو مواد تعبئة مخزنة بالقرب من المواد الكيميائية', 0, 1, '2026-08-27 13:19:18'),
  (89, 'recommendation', 'Trim vegetation and keep it away from the building', 'تقليم النباتات وإبعادها عن المبنى', 0, 1, '2026-08-27 13:19:29'),
  (90, 'condition', 'Stored products or containers improperly sealed.', 'وجود عبوات أو منتجات مخزنة غير محكمة الغلق', 0, 1, '2026-08-27 13:19:50'),
  (91, 'recommendation', 'Remove unused tools, equipment, and materials', 'إزالة الأدوات والمعدات والمواد غير المستخدمة', 0, 1, '2026-08-27 13:20:04'),
  (92, 'condition', 'Pest control equipment difficult to access.', 'صعوبة الوصول إلى معدات مكافحة الآفات', 0, 1, '2026-08-27 13:20:26'),
  (93, 'condition', 'Pest control equipment moved or removed from designated locations.', 'نقل أو إزالة معدات مكافحة الآفات من مواقعها المحددة', 0, 1, '2026-08-27 13:21:19'),
  (94, 'recommendation', 'Separate food from chemicals and store chemicals safely', 'فصل الأغذية عن المواد الكيميائية وتخزينها بأمان', 0, 1, '2026-08-27 13:21:23'),
  (96, 'condition', 'Bait stations unsecured or difficult to access.', 'محطات الطعوم غير ثابتة أو يصعب الوصول إليها', 0, 1, '2026-08-27 13:21:59'),
  (97, 'condition', 'Damaged or unusable pest control equipment.', 'وجود معدات مكافحة آفات تالفة أو غير صالحة للاستخدام', 0, 1, '2026-08-27 13:22:38'),
  (98, 'recommendation', 'Keep stored products and containers properly sealed', 'إحكام غلق المنتجات والعبوات المخزنة', 0, 1, '2026-08-27 13:22:41'),
  (99, 'condition', 'Damaged or missing equipment labels.', 'وجود ملصقات معدات تالفة أو مفقودة', 0, 1, '2026-08-27 13:23:32'),
  (100, 'condition', 'ILTs improperly installed or positioned.', 'المصائد الضوئية ILT غير مثبتة أو غير موضوعة بشكل صحيح', 0, 1, '2026-08-27 13:24:12'),
  (101, 'recommendation', 'Maintain access to all pest control equipment', 'الحفاظ على سهولة الوصول إلى معدات المكافحة', 0, 1, '2026-08-27 13:24:17'),
  (102, 'condition', 'ILTs located near water or moisture sources.', 'وجود ILT بالقرب من المياه أو مصادر الرطوبة', 0, 1, '2026-08-27 13:24:54'),
  (103, 'recommendation', 'Do not move or remove pest control equipment without DRUDGE approval', 'عدم نقل أو إزالة معدات المكافحة دون موافقة درودج', 0, 1, '2026-08-27 13:25:11'),
  (104, 'condition', 'ILT glue boards full or ineffective.', 'ألواح الغراء الخاصة بالـ ILT ممتلئة أو غير صالحة', 0, 1, '2026-08-27 13:25:45'),
  (105, 'recommendation', 'Keep bait stations secured and accessible', 'الحفاظ على محطات الطعوم ثابتة وسهلة الوصول', 0, 1, '2026-08-27 13:25:57'),
  (106, 'condition', 'Flying insect activity or increased numbers observed.', 'وجود نشاط أو زيادة في أعداد الحشرات الطائرة', 0, 1, '2026-08-27 13:26:33'),
  (107, 'recommendation', 'Clean, maintain, and replace damaged pest control equipment', 'تنظيف وصيانة واستبدال معدات المكافحة التالفة', 0, 1, '2026-08-27 13:26:41'),
  (108, 'recommendation', 'Do not remove or tamper with equipment labels', 'عدم إزالة أو العبث بملصقات المعدات', 0, 1, '2026-08-27 13:27:17'),
  (109, 'condition', 'Signs of insect or rodent activity observed.', 'وجود مؤشرات على نشاط الحشرات أو القوارض', 0, 1, '2026-08-27 13:27:20'),
  (110, 'condition', 'Obstructions preventing inspection or service.', 'وجود عوائق تمنع الفحص أو تنفيذ الخدمة', 0, 1, '2026-08-27 13:27:59'),
  (111, 'recommendation', 'Install and properly secure ILTs', 'تركيب وتثبيت المصائد الضوئية ILT بشكل صحيح', 0, 1, '2026-08-27 13:28:13'),
  (112, 'condition', 'Outstanding observations or corrective actions from previous visits.', 'وجود ملاحظات أو إجراءات تصحيحية معلقة من الزيارات السابقة', 0, 1, '2026-08-27 13:28:50'),
  (113, 'recommendation', 'Keep ILTs away from water and maintain them regularly', 'إبعاد الـ ILT عن المياه وصيانتها بانتظام', 0, 1, '2026-08-27 13:28:55'),
  (114, 'condition', 'Employees not following pest prevention practices.', 'عدم التزام العاملين بإجراءات الوقاية من الآفات', 0, 1, '2026-08-27 13:29:38'),
  (115, 'recommendation', 'Replace ILT glue boards according to schedule', '. استبدال ألواح الغراء الخاصة بالـ ILT حسب الجدول', 0, 1, '2026-08-27 13:29:55'),
  (116, 'condition', 'Unusual pest activity or signs of infestation observed.', 'وجود نشاط غير طبيعي للآفات أو مؤشرات على الإصابة', 0, 1, '2026-08-27 13:30:14'),
  (117, 'recommendation', 'Implement an appropriate flying insect control program', 'تطبيق برنامج مناسب لمكافحة الحشرات الطائرة', 0, 1, '2026-08-27 13:30:32'),
  (118, 'recommendation', 'Inspect areas regularly for pest activity', 'فحص المناطق بانتظام لاكتشاف نشاط الآفات', 0, 1, '2026-08-27 13:31:07'),
  (119, 'recommendation', 'Keep all inspection and service areas accessible', 'الحفاظ على سهولة الوصول إلى مناطق الفحص والخدمة', 0, 1, '2026-08-27 13:31:52'),
  (120, 'recommendation', 'Close all outstanding corrective actions', 'إغلاق جميع الإجراءات التصحيحية المعلقة', 0, 1, '2026-08-27 13:32:34'),
  (121, 'recommendation', 'Train employees on pest prevention practices', 'تدريب العاملين على ممارسات الوقاية من الآفات', 0, 1, '2026-08-27 13:33:10'),
  (122, 'recommendation', 'Follow DRUDGE pest control instructions and report unusual pest activity', 'الالتزام بتعليمات درودج والإبلاغ عن أي نشاط غير طبيعي للآفات', 0, 1, '2026-08-27 13:33:47');
```

## Appendix C — All 250 routes, with their demo target

Extracted from the `@route(...)` decorators in `server.py`. **PostgREST** = the shim's routing table plus a view. **Edge Function** = needs porting (§9). **Storage** = a bucket (§8).


| Method | Path | Handler | Demo target | Public |
|---|---|---|---|---|
| GET | `/api/health` | `health()` | PostgREST | yes |
| POST | `/api/auth/login` | `login()` | Edge Function | yes |
| GET | `/api/auth/me` | `me()` | Edge Function |  |
| POST | `/api/auth/logout` | `logout()` | Edge Function |  |
| GET | `/api/dashboard` | `dashboard()` | Edge Function |  |
| GET | `/api/users` | `list_users()` | PostgREST |  |
| GET | `/api/agents` | `list_agents()` | PostgREST |  |
| GET | `/api/my-team` | `my_team()` | PostgREST |  |
| POST | `/api/users` | `create_user()` | PostgREST |  |
| PUT | `/api/users/(\d+)` | `update_user()` | PostgREST |  |
| DELETE | `/api/users/(\d+)` | `deactivate_user()` | PostgREST |  |
| DELETE | `/api/users/(\d+)/permanent` | `delete_user()` | PostgREST |  |
| GET | `/api/shift-types` | `list_shift_types()` | PostgREST |  |
| POST | `/api/shift-types` | `create_shift_type()` | PostgREST |  |
| PUT | `/api/shift-types/(\d+)` | `update_shift_type()` | PostgREST |  |
| DELETE | `/api/shift-types/(\d+)` | `delete_shift_type()` | PostgREST |  |
| GET | `/api/shifts` | `list_shifts()` | PostgREST |  |
| GET | `/api/shifts/week` | `shift_week()` | Edge Function |  |
| POST | `/api/shifts/day` | `set_day_shifts()` | Edge Function |  |
| POST | `/api/shifts` | `assign_shift()` | PostgREST |  |
| POST | `/api/shifts/bulk` | `assign_shifts_bulk()` | Edge Function |  |
| POST | `/api/shifts/area` | `roster_area()` | Edge Function |  |
| POST | `/api/shifts/auto` | `auto_roster()` | Edge Function |  |
| GET | `/api/backup/options` | `backup_options()` | PostgREST |  |
| GET | `/api/backup/list` | `backup_list()` | Edge Function |  |
| GET | `/api/backup/download` | `backup_download()` | Edge Function |  |
| POST | `/api/backup/prepare` | `backup_prepare()` | Edge Function |  |
| GET | `/api/backup/file/([0-9a-f]{32})` | `backup_collect()` | PostgREST | yes |
| GET | `/api/shifts/auto/runs` | `list_roster_runs()` | Edge Function |  |
| GET | `/api/shifts/auto/runs/(\d+)/unplaced` | `roster_run_unplaced()` | Edge Function |  |
| POST | `/api/shifts/auto/unplaced/(\d+)/dismiss` | `dismiss_roster_unplaced()` | Edge Function |  |
| GET | `/api/shifts/auto/over-asked` | `roster_over_asked()` | Edge Function |  |
| POST | `/api/shifts/auto/who-can-take` | `who_can_take()` | Edge Function |  |
| POST | `/api/shifts/auto/runs/(\d+)/undo` | `undo_roster_run()` | Edge Function |  |
| POST | `/api/schedule/clear` | `clear_schedule()` | Edge Function |  |
| DELETE | `/api/shifts/(\d+)` | `delete_shift()` | PostgREST |  |
| GET | `/api/permissions/catalog` | `permissions_catalog()` | Edge Function |  |
| PUT | `/api/permissions/roles/(\w+)` | `update_role_permissions()` | PostgREST |  |
| GET | `/api/permissions/users/(\d+)` | `get_user_permissions()` | PostgREST |  |
| PUT | `/api/permissions/users/(\d+)` | `update_user_permissions()` | PostgREST |  |
| GET | `/api/audit` | `list_audit()` | PostgREST |  |
| GET | `/api/clients` | `list_clients()` | PostgREST |  |
| GET | `/api/clients/(\d+)` | `get_client()` | PostgREST |  |
| POST | `/api/clients/(\d+)/status` | `set_client_status()` | PostgREST |  |
| POST | `/api/sites/(\d+)/status` | `set_site_status()` | PostgREST |  |
| POST | `/api/clients` | `create_client()` | PostgREST |  |
| PUT | `/api/clients/(\d+)` | `update_client()` | PostgREST |  |
| DELETE | `/api/clients/(\d+)` | `delete_client()` | PostgREST |  |
| GET | `/api/sites` | `list_all_sites()` | PostgREST |  |
| POST | `/api/branches/import` | `import_branches()` | Edge Function |  |
| GET | `/api/cost-to-serve` | `cost_to_serve()` | Edge Function |  |
| GET | `/api/service-gaps` | `service_gaps()` | Edge Function |  |
| GET | `/api/pipeline` | `pipeline_board()` | Edge Function |  |
| GET | `/api/capacity` | `capacity_check()` | Edge Function |  |
| GET | `/api/branch-schedule` | `branch_schedule()` | Edge Function |  |
| PUT | `/api/branch-schedule` | `save_branch_schedule()` | Edge Function |  |
| POST | `/api/clients/(\d+)/sites` | `add_site()` | PostgREST |  |
| PUT | `/api/sites/(\d+)` | `update_site()` | PostgREST |  |
| DELETE | `/api/sites/(\d+)` | `delete_site()` | PostgREST |  |
| POST | `/api/sites/(\d+)/map` | `upload_site_map()` | Storage |  |
| DELETE | `/api/sites/(\d+)/map` | `delete_site_map()` | Storage |  |
| GET | `/api/service-types` | `list_service_types()` | PostgREST |  |
| POST | `/api/service-types` | `create_service_type()` | PostgREST |  |
| GET | `/api/visits` | `list_visits()` | PostgREST |  |
| GET | `/api/visits/(\d+)` | `get_visit()` | PostgREST |  |
| POST | `/api/visits` | `create_visit()` | PostgREST |  |
| POST | `/api/visits/batch` | `create_visits_batch()` | Edge Function |  |
| PUT | `/api/visits/(\d+)` | `update_visit()` | PostgREST |  |
| DELETE | `/api/visits/(\d+)` | `delete_visit()` | PostgREST |  |
| POST | `/api/visits/(\d+)/checkin` | `visit_checkin()` | PostgREST |  |
| POST | `/api/visits/(\d+)/checkout` | `visit_checkout()` | PostgREST |  |
| DELETE | `/api/visits/(\d+)/report` | `delete_report()` | Edge Function |  |
| POST | `/api/visits/(\d+)/report` | `upsert_report()` | Edge Function |  |
| POST | `/api/visits/(\d+)/rating` | `rate_visit()` | PostgREST |  |
| GET | `/api/reports/drafts` | `list_draft_reports()` | Edge Function |  |
| GET | `/api/areas` | `list_areas()` | Edge Function |  |
| GET | `/api/zones` | `list_zones()` | PostgREST |  |
| POST | `/api/zones` | `create_zone()` | PostgREST |  |
| PUT | `/api/zones/(\d+)` | `update_zone()` | PostgREST |  |
| DELETE | `/api/zones/(\d+)` | `delete_zone()` | PostgREST |  |
| GET | `/api/agent-availability` | `get_agent_availability()` | PostgREST |  |
| PUT | `/api/agent-availability` | `set_agent_availability()` | PostgREST |  |
| POST | `/api/areas` | `create_area()` | Edge Function |  |
| PUT | `/api/areas/(\d+)` | `update_area()` | Edge Function |  |
| GET | `/api/areas/(\d+)/branches` | `area_branches()` | Edge Function |  |
| POST | `/api/areas/(\d+)/branches` | `set_area_branches()` | Edge Function |  |
| DELETE | `/api/areas/(\d+)` | `delete_area()` | Edge Function |  |
| GET | `/api/report-options` | `list_report_options()` | Edge Function |  |
| POST | `/api/report-options` | `create_report_option()` | Edge Function |  |
| PUT | `/api/report-options/(\d+)` | `update_report_option()` | Edge Function |  |
| DELETE | `/api/report-options/(\d+)` | `delete_report_option()` | Edge Function |  |
| GET | `/api/reports` | `list_reports()` | Edge Function |  |
| GET | `/api/transport` | `list_transport()` | PostgREST |  |
| POST | `/api/visits/(\d+)/transport` | `add_transport()` | PostgREST |  |
| DELETE | `/api/transport/(\d+)` | `delete_transport()` | PostgREST |  |
| GET | `/api/chemicals` | `list_chemicals()` | PostgREST |  |
| POST | `/api/chemicals` | `create_chemical()` | PostgREST |  |
| PUT | `/api/chemicals/(\d+)` | `update_chemical()` | PostgREST |  |
| DELETE | `/api/chemicals/(\d+)` | `delete_chemical()` | PostgREST |  |
| POST | `/api/chemicals/(\d+)/stock` | `adjust_stock()` | PostgREST |  |
| GET | `/api/purchase-orders` | `list_purchase_orders()` | PostgREST |  |
| POST | `/api/purchase-orders` | `create_purchase_order()` | PostgREST |  |
| PUT | `/api/purchase-orders/(\d+)` | `update_purchase_order()` | PostgREST |  |
| DELETE | `/api/purchase-orders/(\d+)` | `delete_purchase_order()` | PostgREST |  |
| GET | `/api/chemicals/(\d+)/transactions` | `chemical_transactions()` | PostgREST |  |
| POST | `/api/visits/(\d+)/usage` | `record_usage()` | PostgREST |  |
| DELETE | `/api/usage/(\d+)` | `delete_usage()` | PostgREST |  |
| GET | `/api/issues` | `list_issues()` | PostgREST |  |
| GET | `/api/issues/balance` | `issues_balance()` | Edge Function |  |
| GET | `/api/issues/(\d+)` | `get_issue()` | PostgREST |  |
| POST | `/api/issues` | `create_issue()` | PostgREST |  |
| POST | `/api/issues/(\d+)/approve` | `approve_issue()` | PostgREST |  |
| POST | `/api/issues/(\d+)/receive` | `receive_issue()` | PostgREST |  |
| POST | `/api/issues/(\d+)/dispute` | `dispute_issue()` | PostgREST |  |
| POST | `/api/issues/(\d+)/decline` | `decline_issue()` | PostgREST |  |
| DELETE | `/api/issues/(\d+)` | `delete_issue()` | PostgREST |  |
| GET | `/api/returns` | `list_returns()` | PostgREST |  |
| GET | `/api/returns/(\d+)` | `get_return()` | PostgREST |  |
| POST | `/api/returns` | `create_return()` | PostgREST |  |
| POST | `/api/returns/(\d+)/approve` | `approve_return()` | PostgREST |  |
| POST | `/api/returns/(\d+)/decline` | `decline_return()` | PostgREST |  |
| POST | `/api/returns/(\d+)/receive` | `receive_return()` | PostgREST |  |
| POST | `/api/returns/(\d+)/dispute` | `dispute_return()` | PostgREST |  |
| DELETE | `/api/returns/(\d+)` | `delete_return()` | PostgREST |  |
| GET | `/api/cash` | `list_cash()` | PostgREST |  |
| GET | `/api/cash/summary` | `cash_summary()` | Edge Function |  |
| POST | `/api/cash` | `create_cash()` | PostgREST |  |
| POST | `/api/cash/(\d+)/approve` | `approve_cash()` | PostgREST |  |
| POST | `/api/cash/(\d+)/decline` | `decline_cash()` | PostgREST |  |
| DELETE | `/api/cash/(\d+)` | `delete_cash()` | PostgREST |  |
| GET | `/api/invoices` | `list_invoices()` | PostgREST |  |
| GET | `/api/invoices/(\d+)` | `get_invoice()` | PostgREST |  |
| POST | `/api/invoices` | `create_invoice()` | PostgREST |  |
| PUT | `/api/invoices/(\d+)` | `update_invoice()` | PostgREST |  |
| DELETE | `/api/invoices/(\d+)` | `delete_invoice()` | PostgREST |  |
| POST | `/api/invoices/(\d+)/payments` | `add_payment()` | Edge Function |  |
| GET | `/api/clients/(\d+)/finance` | `client_finance()` | PostgREST |  |
| GET | `/api/clients/(\d+)/statement` | `client_statement()` | Edge Function |  |
| POST | `/api/visits/(\d+)/invoice` | `invoice_a_visit()` | PostgREST |  |
| POST | `/api/contracts/(\d+)/apply-to-branches` | `contract_to_branches()` | PostgREST |  |
| POST | `/api/invoices/(\d+)/to-contract` | `quote_to_contract()` | PostgREST |  |
| POST | `/api/invoices/(\d+)/convert` | `convert_quote()` | PostgREST |  |
| POST | `/api/invoices/(\d+)/approve` | `approve_quote()` | PostgREST |  |
| POST | `/api/invoices/(\d+)/decline` | `decline_quote()` | PostgREST |  |
| GET | `/api/price-book` | `list_price_book()` | PostgREST |  |
| POST | `/api/price-book` | `create_price_item()` | PostgREST |  |
| PUT | `/api/price-book/(\d+)` | `update_price_item()` | PostgREST |  |
| DELETE | `/api/price-book/(\d+)` | `delete_price_item()` | PostgREST |  |
| GET | `/api/leads` | `list_leads()` | Edge Function |  |
| POST | `/api/leads` | `create_lead()` | Edge Function |  |
| PUT | `/api/leads/(\d+)` | `update_lead()` | Edge Function |  |
| DELETE | `/api/leads/(\d+)` | `delete_lead()` | Edge Function |  |
| POST | `/api/leads/(\d+)/convert` | `convert_lead()` | Edge Function |  |
| POST | `/api/public/lead` | `public_lead()` | Edge Function | yes |
| POST | `/api/invoices/(\d+)/pay` | `start_payment()` | PostgREST |  |
| GET | `/api/payment-intents/([0-9a-fA-F]+)` | `get_payment_intent()` | Edge Function |  |
| POST | `/api/payments/callback/(\w+)` | `payment_callback()` | Edge Function | yes |
| GET | `/api/settings` | `read_settings()` | PostgREST |  |
| PUT | `/api/settings` | `write_settings()` | PostgREST |  |
| POST | `/api/settings/logo` | `upload_logo()` | Edge Function |  |
| GET | `/api/contracts` | `list_contracts()` | PostgREST |  |
| POST | `/api/contracts` | `create_contract()` | PostgREST |  |
| PUT | `/api/contracts/(\d+)` | `update_contract()` | PostgREST |  |
| DELETE | `/api/contracts/(\d+)` | `delete_contract()` | PostgREST |  |
| POST | `/api/contracts/run` | `run_contracts()` | Edge Function |  |
| POST | `/api/contracts/bill` | `run_billing()` | Edge Function |  |
| GET | `/api/recurring-costs` | `list_recurring_costs()` | PostgREST |  |
| POST | `/api/recurring-costs` | `create_recurring_cost()` | PostgREST |  |
| PUT | `/api/recurring-costs/(\d+)` | `update_recurring_cost()` | PostgREST |  |
| DELETE | `/api/recurring-costs/(\d+)` | `delete_recurring_cost()` | PostgREST |  |
| POST | `/api/recurring-costs/post` | `post_due_costs()` | Edge Function |  |
| GET | `/api/expenses` | `list_expenses()` | PostgREST |  |
| POST | `/api/expenses` | `create_expense()` | PostgREST |  |
| PUT | `/api/expenses/(\d+)` | `update_expense()` | PostgREST |  |
| DELETE | `/api/expenses/(\d+)` | `delete_expense()` | PostgREST |  |
| GET | `/api/budgets` | `list_budgets()` | PostgREST |  |
| POST | `/api/budgets` | `set_budget()` | PostgREST |  |
| DELETE | `/api/budgets/(\d+)` | `delete_budget()` | PostgREST |  |
| GET | `/api/finance/summary` | `finance_summary()` | Edge Function |  |
| GET | `/api/vat-returns` | `list_vat_returns()` | PostgREST |  |
| PUT | `/api/vat-returns/(\d+)` | `update_vat_return()` | PostgREST |  |
| POST | `/api/vat-returns/(\d+)/pay` | `pay_vat_return()` | PostgREST |  |
| GET | `/api/finance/cashflow` | `finance_cashflow()` | Edge Function |  |
| GET | `/api/finance/clients` | `finance_by_client()` | PostgREST |  |
| GET | `/api/finance/contracts` | `finance_by_contract()` | PostgREST |  |
| GET | `/api/marketing/targets` | `marketing_targets()` | PostgREST |  |
| GET | `/api/marketing/person/(\d+)` | `marketing_person()` | PostgREST |  |
| POST | `/api/marketing/targets` | `set_marketing_target()` | PostgREST |  |
| DELETE | `/api/marketing/targets/(\d+)` | `delete_marketing_target()` | PostgREST |  |
| POST | `/api/marketing/attribute` | `attribute_contract()` | Edge Function |  |
| POST | `/api/geo/resolve` | `resolve_map_link()` | Edge Function |  |
| POST | `/api/dispatch/optimize` | `dispatch_optimize()` | Edge Function |  |
| GET | `/api/dispatch/sla` | `dispatch_sla()` | Edge Function |  |
| GET | `/api/me/prefs` | `get_my_prefs()` | Edge Function |  |
| PUT | `/api/me/prefs` | `set_my_prefs()` | Edge Function |  |
| GET | `/api/fixed-assignments` | `list_fixed_assignments()` | Edge Function |  |
| POST | `/api/fixed-assignments` | `create_fixed_assignment()` | Edge Function |  |
| PUT | `/api/fixed-assignments/(\d+)` | `update_fixed_assignment()` | Edge Function |  |
| DELETE | `/api/fixed-assignments/(\d+)` | `delete_fixed_assignment()` | Edge Function |  |
| GET | `/api/dispatch/grid` | `dispatch_grid()` | Edge Function |  |
| GET | `/api/dispatch/cell` | `dispatch_cell()` | Edge Function |  |
| POST | `/api/dispatch/move` | `dispatch_move()` | Edge Function |  |
| GET | `/api/visit-requests` | `list_visit_requests()` | PostgREST |  |
| POST | `/api/visit-requests` | `create_visit_request()` | PostgREST |  |
| POST | `/api/visit-requests/(\d+)/approve` | `approve_visit_request()` | PostgREST |  |
| POST | `/api/visit-requests/(\d+)/decline` | `decline_visit_request()` | PostgREST |  |
| GET | `/api/notifications` | `list_notifications()` | PostgREST |  |
| POST | `/api/reminders/run` | `run_reminders()` | Edge Function |  |
| POST | `/api/notifications/read` | `mark_notifications_read()` | PostgREST |  |
| POST | `/api/notifications/generate` | `gen_notifications()` | Edge Function |  |
| GET | `/api/notification-prefs` | `get_notification_prefs()` | PostgREST |  |
| PUT | `/api/notification-prefs` | `set_notification_prefs()` | PostgREST |  |
| GET | `/api/engineers/scorecard` | `engineer_scorecard()` | Edge Function |  |
| GET | `/api/analytics` | `analytics()` | Edge Function |  |
| GET | `/api/clients/(\d+)/analytics` | `client_analytics()` | Edge Function |  |
| GET | `/api/clients/(\d+)/pest-trends` | `client_pest_trends()` | PostgREST |  |
| GET | `/api/clients/(\d+)/audit-pack` | `client_audit_pack()` | PostgREST |  |
| POST | `/api/visits/(\d+)/signature` | `save_signature()` | PostgREST |  |
| GET | `/api/export/(clients|visits|invoices|chemicals|payments|expenses|reports)\.(csv|xlsx)` | `export_csv()` | Edge Function |  |
| GET | `/api/export/reports-bundle\.(csv|xlsx)\.zip` | `export_reports_bundle()` | Edge Function |  |
| GET | `/api/photos` | `list_photos()` | Storage |  |
| POST | `/api/photos` | `upload_photo()` | Storage |  |
| PUT | `/api/photos/(\d+)` | `update_photo()` | Storage |  |
| DELETE | `/api/photos/(\d+)` | `delete_photo()` | Storage |  |
| GET | `/api/ipm-files` | `list_ipm_files()` | PostgREST |  |
| POST | `/api/ipm-files` | `create_ipm_file()` | PostgREST |  |
| PUT | `/api/ipm-files/(\d+)` | `update_ipm_file()` | PostgREST |  |
| POST | `/api/ipm-files/(\d+)/file` | `replace_ipm_file()` | PostgREST |  |
| DELETE | `/api/ipm-files/(\d+)` | `delete_ipm_file()` | PostgREST |  |
| GET | `/api/maps` | `list_all_maps()` | PostgREST |  |
| GET | `/api/clients/(\d+)/maps` | `list_maps()` | PostgREST |  |
| GET | `/api/maps/(\d+)` | `get_map()` | PostgREST |  |
| POST | `/api/maps` | `upload_map()` | PostgREST |  |
| DELETE | `/api/maps/(\d+)` | `delete_map()` | PostgREST |  |
| POST | `/api/maps/(\d+)/markers` | `add_marker()` | PostgREST |  |
| PUT | `/api/markers/(\d+)` | `update_marker()` | PostgREST |  |
| DELETE | `/api/markers/(\d+)` | `delete_marker()` | PostgREST |  |
| GET | `/api/scan/([0-9a-fA-F]{32})` | `scan_device()` | PostgREST |  |
| POST | `/api/scan/([0-9a-fA-F]{32})` | `scan_inspect()` | PostgREST |  |
| GET | `/api/devices` | `list_devices()` | PostgREST |  |
| POST | `/api/devices/generate` | `generate_devices()` | Edge Function |  |
| POST | `/api/devices/assign` | `assign_devices()` | Edge Function |  |
| PUT | `/api/devices/(\d+)` | `update_device()` | PostgREST |  |
| DELETE | `/api/devices/(\d+)` | `delete_device()` | PostgREST |  |
| GET | `/api/devices/(\d+)/history` | `device_history()` | PostgREST |  |
| GET | `/api/scan/([A-Za-z]{3}\d{4,})` | `scan_device_code()` | PostgREST |  |
| POST | `/api/scan/([A-Za-z]{3}\d{4,})` | `inspect_device_code()` | PostgREST |  |
| GET | `/api/visits/(\d+)/devices` | `visit_device_coverage()` | PostgREST |  |
| GET | `/api/visits/(\d+)/followup` | `visit_followup()` | PostgREST |  |
| GET | `/api/search` | `search()` | Edge Function |  |

---

## Appendices D–F — Full source code

The complete source of `server.py`, `database.py`, `auth.py`, `multipart.py`, `roster.py`, `seed.py`,
`index.html`, `api.js`, `app.js`, `i18n.js`, `offline.js`, `store.js`, `sw.js` and `styles.css`
is embedded in the **full edition** of this document:

> **`fox-crm-demo-supabase.md`** — 2.3 MB, 43,238 lines.

This guide edition is identical up to this point; only the embedded source is omitted, so it stays
readable and quick to work from.
