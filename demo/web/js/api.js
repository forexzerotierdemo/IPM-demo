// static/js/api.js — Supabase edition (§7.2).
//
// Same public surface as the original file — API.get/post/put/del, API.token,
// API.user, API.setAuth/clearAuth, API.uploadPhoto/uploadDoc/uploadSiteMap,
// and the offline queue and read-cache hooks — so app.js is unaware this file
// changed and does not move by one character.
//
// The design is a routing table. Paths it knows become PostgREST calls;
// everything it does not know falls through to the catch-all Edge Function,
// so the computed routes can be ported one at a time and the app keeps
// working throughout.

const SUPABASE_URL  = window.__SUPABASE_URL__;
const SUPABASE_ANON = window.__SUPABASE_ANON__;

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ------------------------------------------------------------- PostgREST
const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

const rows = (t, order) => {
  let q = sb.from(t).select("*");
  if (order) order.split(",").forEach((c) => { q = q.order(c.trim()); });
  return q.then(unwrap);
};
const one = (t, id) => sb.from(t).select("*").eq("id", id).maybeSingle().then(unwrap);
const ins = (t, b)  => sb.from(t).insert(strip(b)).select().single().then(unwrap);
const upd = (t, id, b) => sb.from(t).update(strip(b)).eq("id", id).select().maybeSingle().then(unwrap);
const del = (t, id) => sb.from(t).delete().eq("id", id).then(({ error }) => {
  if (error) throw new Error(error.message);
  return { ok: true };
});

// app.js posts back rows it was handed, which for a view carry joined columns
// (client_en, agent_name, …) that do not exist on the base table. PostgREST
// rejects the whole insert on the first unknown column, so the write path
// drops anything that is not a real column of the target table. WRITABLE is
// filled from information_schema at build time (see tools/columns.js).
const WRITABLE = window.__WRITABLE_COLUMNS__ || {};
let _writeTable = null;
function strip(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return b;
  const cols = WRITABLE[_writeTable];
  if (!cols) return b;
  const out = {};
  for (const [k, v] of Object.entries(b)) if (cols.includes(k)) out[k] = v;
  return out;
}
const withTable = (t, fn) => { _writeTable = t; try { return fn(); } finally { _writeTable = null; } };

// The server returns a bare array unless ?page or ?limit is given, and an
// {items,total,page,pages,limit} envelope when it is. Match that exactly.
async function paginate(sel, q) {
  if (!q.page && !q.limit) return sel.then(unwrap);
  const limit = Math.min(Math.max(parseInt(q.limit || 25, 10), 1), 200);
  const page  = Math.max(parseInt(q.page || 1, 10), 1);
  const from  = (page - 1) * limit;
  const { data, error, count } = await sel.range(from, from + limit - 1);
  if (error) throw new Error(error.message);
  return { items: data, total: count, page, pages: Math.ceil(count / limit) || 1, limit };
}

// --------------------------------------------------------------- resources
// The 161 plain CRUD routes, as a table rather than 161 handlers. `read` is
// the view the list and the single-row GET come from; `write` is the base
// table the insert/update/delete go to (a view with joins is not updatable).
const RESOURCES = {
  "clients":            { read: "v_clients", write: "clients",        order: "name_en" },
  "sites":              { read: "v_sites",   write: "sites",          order: "client_en,name" },
  "branches":           { read: "v_sites",   write: "sites",          order: "client_en,name" },
  "users":              { read: "v_users",   write: "users",          order: "full_name" },
  "visits":             { read: "v_visits",  write: "visits",         order: "scheduled_start" },
  "reports":            { read: "v_reports", write: "reports",        order: "scheduled_start" },
  "devices":            { read: "v_devices", write: "devices",        order: "type,code" },
  "areas":              { read: "areas",     write: "areas",          order: "sort_order,name_en" },
  "zones":              { read: "zones",     write: "zones",          order: "sort_order,name_en" },
  "service-types":      { read: "service_types",  write: "service_types",  order: "name_en" },
  "shift-types":        { read: "shift_types",    write: "shift_types",    order: "sort_order" },
  "chemicals":          { read: "chemicals",      write: "chemicals",      order: "name_en" },
  "report-options":     { read: "report_options", write: "report_options", order: "kind,sort_order" },
  "leads":              { read: "leads",          write: "leads",          order: "id" },
  "contracts":          { read: "contracts",      write: "contracts",      order: "id" },
  "invoices":           { read: "invoices",       write: "invoices",       order: "issue_date" },
  "invoice-items":      { read: "invoice_items",  write: "invoice_items",  order: "id" },
  "payments":           { read: "payments",       write: "payments",       order: "id" },
  "expenses":           { read: "expenses",       write: "expenses",       order: "spent_on" },
  "budgets":            { read: "cost_budgets",   write: "cost_budgets",   order: "id" },
  "recurring-costs":    { read: "cost_recurring", write: "cost_recurring", order: "id" },
  "cash":               { read: "petty_cash",     write: "petty_cash",     order: "id" },
  "price-book":         { read: "price_book",     write: "price_book",     order: "id" },
  "purchase-orders":    { read: "purchase_orders", write: "purchase_orders", order: "id" },
  "vat-returns":        { read: "vat_returns",    write: "vat_returns",    order: "id" },
  "issues":             { read: "engineer_issues", write: "engineer_issues", order: "id" },
  "returns":            { read: "material_returns", write: "material_returns", order: "id" },
  "maps":               { read: "maps",           write: "maps",           order: "id" },
  "markers":            { read: "map_markers",    write: "map_markers",    order: "id" },
  "ipm-files":          { read: "company_files",  write: "company_files",  order: "id" },
  "notifications":      { read: "notifications",  write: "notifications",  order: "id" },
  "notification-prefs": { read: "notification_prefs", write: "notification_prefs", order: "user_id" },
  "visit-requests":     { read: "visit_requests", write: "visit_requests", order: "id" },
  "shifts":             { read: "agent_shifts",   write: "agent_shifts",   order: "shift_date" },
  "agent-availability": { read: "agent_availability", write: "agent_availability", order: "agent_id" },
  "fixed-assignments":  { read: "fixed_assignments", write: "fixed_assignments", order: "id" },
  "transport":          { read: "transport_entries", write: "transport_entries", order: "id" },
  "photos":             { read: "photos",         write: "photos",         order: "id" },
  "marketing-targets":  { read: "marketing_targets", write: "marketing_targets", order: "period" },
};

// Query keys the list endpoints filter on, and the column each one means.
// Anything not listed here is ignored rather than guessed at.
const FILTERS = {
  client: "client_id", client_id: "client_id", agent: "agent_id", agent_id: "agent_id",
  site: "site_id", site_id: "site_id", status: "status", type: "type", kind: "kind",
  role: "role", severity: "severity", contract: "contract_id", invoice: "invoice_id",
  user: "user_id", user_id: "user_id", area: "area_id", area_id: "area_id",
  visit: "visit_id", visit_id: "visit_id", map: "map_id", period: "period",
};

// The column a ?from/?to range means, per resource.
const DATE_COL = {
  visits: "scheduled_start", reports: "scheduled_start", shifts: "shift_date",
  invoices: "issue_date", expenses: "spent_on", cash: "spent_on",
  transport: "created_at", photos: "uploaded_at",
};

function applyQuery(sel, res, q) {
  for (const [k, v] of Object.entries(q)) {
    if (v === "" || v == null) continue;
    const col = FILTERS[k];
    if (!col) continue;
    if (v === "none" || v === "null") sel = sel.is(col, null);
    else sel = sel.eq(col, v);
  }
  const dc = DATE_COL[res];
  if (dc && q.from) sel = sel.gte(dc, q.from);
  // The date columns stayed text (§4.1), so an inclusive upper bound on a
  // datetime column is the day plus its last second, not the bare date.
  if (dc && q.to) sel = sel.lte(dc, dc.endsWith("_start") || dc.endsWith("_at")
                                     ? q.to + " 23:59:59" : q.to);
  if (q.q && (res === "clients" || res === "sites" || res === "leads")) {
    const like = `%${q.q}%`;
    sel = sel.or(res === "leads" ? `name.ilike.${like},company.ilike.${like}`
                                 : `name_en.ilike.${like},name_ar.ilike.${like}`);
  }
  return sel;
}

// ---------------------------------------------------------------- routing
// [method, regex, handler]. First match wins, so specific paths sit above
// generic ones. `m` holds the regex capture groups.
const ROUTES = [
  // ---- auth -------------------------------------------------------------
  ["POST", /^\/auth\/login$/, async (m, body) => {
    const { data, error } = await sb.auth.signInWithPassword({
      email: (body.email || "").trim().toLowerCase(), password: body.password,
    });
    if (error) throw new Error("Invalid email or password");
    // The trial ROLE is a sandbox: it starts clean every time. Resetting on
    // the way IN is the half that matters — the previous visitor almost
    // never signs out, they just close the tab. The reset restores the
    // profile identically, so reading it first costs nothing.
    const me = await profile();
    await trialSessionStart(me.role);
    return { token: data.session.access_token, user: me };
  }],
  ["POST", /^\/auth\/logout$/, async () => {
    // Closing the LAST live trial session is what cleans the sandbox.
    await trialSessionEnd(API.user && API.user.role);
    await sb.auth.signOut();
    return { ok: true };
  }],
  // app.js does `API.setAuth(API.token, await API.get("/auth/me"))`, so this
  // returns the profile itself — NOT wrapped in {user}, which is what
  // _me_payload() returned and what the guide's draft shim got wrong.
  ["GET",  /^\/auth\/me$/, () => profile()],

  // ---- settings: app.js wants a {key: value} map, not rows --------------
  ["GET", /^\/settings$/, async () => {
    const r = await rows("settings");
    return Object.fromEntries(r.map((x) => [x.key, x.value]));
  }],
  ["PUT", /^\/settings$/, async (m, body) => {
    const payload = Object.entries(body || {}).map(([key, value]) => ({ key, value: String(value) }));
    if (payload.length) unwrap(await sb.from("settings").upsert(payload, { onConflict: "key" }));
    return { ok: true };
  }],

  // ---- the dashboard: an RPC, not an Edge Function ---------------------
  // It runs SECURITY INVOKER, so every count inside it is already scoped by
  // the same policies that scope the lists.
  ["GET", /^\/dashboard$/, () => sb.rpc("dashboard_summary").then(unwrap)],

  // ---- the dispatch board ----------------------------------------------
  // grid/cell/sla/move are SQL functions, not Edge Function routes: each is
  // a counting or a scoping question, and SECURITY INVOKER means the §6
  // policies scope them without a role branch anywhere. /dispatch/optimize
  // is the exception and falls through to the Edge Function below, because
  // nearest-neighbour routing needs a procedural language.
  ["GET", /^\/dispatch\/grid$/, (m, b, q) => sb.rpc("dispatch_grid", {
      p_from: q.from, p_to: q.to || q.from,
      p_agent: q.agent ? Number(q.agent) : null,
      p_area: q.area ? Number(q.area) : null,
    }).then(unwrap)],
  ["GET", /^\/dispatch\/cell$/, (m, b, q) => sb.rpc("dispatch_cell", {
      p_date: q.date, p_agent: q.agent ? Number(q.agent) : null,
    }).then(unwrap)],
  ["GET", /^\/dispatch\/sla$/, () => sb.rpc("dispatch_sla").then(unwrap)],
  // The weekly roster. The dispatch board needs it before it will show the
  // day/week/month selector at all, so it is part of that screen even though
  // it lives under /shifts.
  ["GET", /^\/shifts\/week$/, (m, b, q) =>
      sb.rpc("shift_week", { p_start: q.start || null }).then(unwrap)],
  ["POST", /^\/dispatch\/move$/, (m, b) => sb.rpc("dispatch_move", {
      p_visit_ids: b.visit_ids || (b.visit_id ? [b.visit_id] : []),
      p_agent_id: Number(b.agent_id), p_date: b.date,
    }).then(unwrap)],

  // ---- analytics, the permission catalogue and the drafts queue --------
  // All SQL functions. analytics() in particular is SECURITY INVOKER on
  // purpose: the Python handler's scope() is twenty lines of role branching
  // that the §6 policies already perform, so a supervisor's numbers are
  // their patch's without this file knowing anything about roles.
  ["GET", /^\/analytics$/, (m, b, q) => sb.rpc("analytics", {
      p_from: q.from || null, p_to: q.to || null,
      p_client_id: q.client_id ? Number(q.client_id) : null,
      p_site_id: q.site_id || null,
    }).then(unwrap)],
  ["GET", /^\/permissions\/catalog$/, () => sb.rpc("permissions_catalog").then(unwrap)],
  // Must sit above the generic /reports table, or "drafts" is read as an id.
  ["GET", /^\/reports\/drafts$/, () => sb.rpc("reports_drafts").then(unwrap)],

  // ---- the QR scan chain ------------------------------------------------
  // A trap's printed label encodes <host>/scan/<CODE>. The engineer lands
  // here, sees what was found at it before and what the last visit promised,
  // and files this visit's reading — which is what the follow-up report
  // prints. The 32-hex form is the legacy floor-plan marker token.
  ["GET", /^\/scan\/([A-Za-z]{3}\d{4,})$/, (m) =>
      sb.rpc("scan_lookup", { p_code: m[1] }).then(unwrap)],
  ["POST", /^\/scan\/([A-Za-z]{3}\d{4,})$/, (m, b) => sb.rpc("scan_record", {
      p_code: m[1],
      p_status: b.status || "ok",
      p_findings: b.findings || null,
      p_note: b.note || null,
      p_visit_id: b.visit_id ? Number(b.visit_id) : null,
      p_lat: b.lat ?? null, p_lng: b.lng ?? null,
      p_details: b.details || null,
    }).then(unwrap)],

  ["GET", /^\/devices\/(\d+)\/history$/, (m) =>
      sb.rpc("device_history", { p_id: Number(m[1]) }).then(unwrap)],
  ["GET", /^\/visits\/(\d+)\/devices$/, (m) =>
      sb.rpc("visit_devices", { p_visit_id: Number(m[1]) }).then(unwrap)],
  // The follow-up sheet. Must sit above the generic /visits table.
  ["GET", /^\/visits\/(\d+)\/followup$/, (m) =>
      sb.rpc("visit_followup", { p_visit_id: Number(m[1]) }).then(unwrap)],

  // ---- the QR device registry ------------------------------------------
  ["POST", /^\/devices\/generate$/, (m, b) => sb.rpc("devices_generate", {
      p_type: b.type, p_count: Number(b.count),
      p_client_id: b.client_id ? Number(b.client_id) : null,
      p_site_id: b.site_id ? Number(b.site_id) : null,
      p_placement: b.placement || null,
    }).then(unwrap)],
  ["POST", /^\/devices\/assign$/, (m, b) => sb.rpc("devices_assign", {
      p_ids: (b.ids || []).map(Number),
      p_client_id: Number(b.client_id),
      p_site_id: b.site_id ? Number(b.site_id) : null,
    }).then(unwrap)],

  // ---- one client's own pages ------------------------------------------
  ["GET", /^\/clients\/(\d+)\/analytics$/, (m, b, q) => sb.rpc("client_analytics", {
      p_client_id: Number(m[1]), p_site_id: q.site_id || null }).then(unwrap)],
  ["GET", /^\/clients\/(\d+)\/statement$/, (m, b, q) => sb.rpc("client_statement", {
      p_client_id: Number(m[1]), p_site_id: q.site_id || null }).then(unwrap)],
  ["GET", /^\/clients\/(\d+)\/pest-trends$/, (m, b, q) => sb.rpc("client_pest_trends", {
      p_client_id: Number(m[1]), p_site_id: q.site_id || null }).then(unwrap)],

  // ---- the field-staff projection --------------------------------------
  ["GET", /^\/agents$/, () => sb.from("v_users").select("*")
      .in("role", ["agent", "area_manager", "team_leader"])
      .eq("active", 1).order("full_name").then(unwrap)],

  ["GET", /^\/my-team$/, async () => {
    const me = await profile();
    if (me.role !== "team_leader") return [];
    return sb.from("v_users").select("*").eq("team_leader_id", me.id)
             .eq("active", 1).order("full_name").then(unwrap);
  }],

  // ---- the permission matrix screen ------------------------------------
  ["GET", /^\/permissions$/, async () => ({
    roles: await rows("role_permissions", "role,perm"),
    users: await rows("user_permissions", "user_id,perm"),
  })],

  // ---- one client, with everything the detail page draws ---------------
  ["GET", /^\/clients\/(\d+)$/, async (m) => {
    const id = m[1];
    const client = await one("v_clients", id);
    if (!client) throw new Error("Client not found");
    const [sites, photos, recent] = await Promise.all([
      sb.from("v_sites").select("*").eq("client_id", id).order("name").then(unwrap),
      sb.from("photos").select("*").eq("entity_type", "client").eq("entity_id", id)
        .order("uploaded_at", { ascending: false }).then(unwrap),
      sb.from("v_visits").select("*").eq("client_id", id)
        .order("scheduled_start", { ascending: false }).limit(10).then(unwrap),
    ]);
    return { ...client, sites, photos, recent_visits: recent,
             upcoming_visits: client.upcoming_visits ?? 0 };
  }],

  // ---- one visit, with its report, photos and chemical usage -----------
  ["GET", /^\/visits\/(\d+)$/, async (m) => {
    const id = m[1];
    const visit = await one("v_visits", id);
    if (!visit) throw new Error("Visit not found");
    const [report, photos, usage] = await Promise.all([
      sb.from("reports").select("*").eq("visit_id", id).maybeSingle().then(unwrap),
      sb.from("photos").select("*").eq("entity_type", "visit").eq("entity_id", id)
        .order("uploaded_at").then(unwrap),
      sb.from("chemical_usage").select("*").eq("visit_id", id).then(unwrap),
    ]);
    return { ...visit, report, photos, chemical_usage: usage };
  }],

  // ---- a visit's report, written from the field ------------------------
  ["POST", /^\/visits\/(\d+)\/report$/, async (m, body) => {
    const visit_id = Number(m[1]);
    const existing = await sb.from("reports").select("id").eq("visit_id", visit_id)
                             .maybeSingle().then(unwrap);
    const row = withTable("reports", () => strip({ ...body, visit_id }));
    return existing ? upd("reports", existing.id, row)
                    : withTable("reports", () => ins("reports", row));
  }],
];

// -------------------------------------------------------- generic CRUD
// Tried after ROUTES and before the Edge fallback: /<resource> and
// /<resource>/<id> for every entry in RESOURCES.
async function generic(method, path, body, q) {
  const m = /^\/([a-z][a-z0-9-]*)(?:\/(\d+))?$/.exec(path);
  if (!m) return undefined;
  const res = RESOURCES[m[1]];
  if (!res) return undefined;
  const id = m[2];

  if (method === "GET") {
    if (id) return one(res.read, id);
    let sel = sb.from(res.read).select("*", { count: q.page || q.limit ? "exact" : undefined });
    sel = applyQuery(sel, m[1], q);
    const asc = (q.sort || "asc") !== "desc";
    (res.order || "id").split(",").forEach((c) => { sel = sel.order(c.trim(), { ascending: asc }); });
    return paginate(sel, q);
  }
  return withTable(res.write, () => {
    if (method === "POST"   && !id) return ins(res.write, body);
    if (method === "PUT"    &&  id) return upd(res.write, id, body);
    if (method === "DELETE" &&  id) return del(res.write, id);
    return undefined;
  });
}

// ------------------------------------------------------- the sandbox
// The `trial` role is for handing to a prospect: they may look at and change
// the whole operational system, and none of it survives them.
//
// The reset is NOT fired on every login. It runs when the last live trial
// session ends — otherwise a second prospect arriving would wipe the first
// one's work out from under them mid-session, which is exactly what used to
// happen. trial_session_start/end own that decision server-side; both refuse
// any role but `trial`, so these are safe to call unconditionally.
//
// Failure is deliberately swallowed. A session that fails to open leaves the
// demo untidy; an error that blocks the login leaves the prospect staring at
// "Invalid email or password", which is far worse.
async function trialSessionStart(role) {
  if (role !== "trial") return;
  try { await sb.rpc("trial_session_start", { p_user_agent: navigator.userAgent }); }
  catch (e) { /* untidy, not broken */ }
}
async function trialSessionEnd(role) {
  if (role !== "trial") return;
  try { await sb.rpc("trial_session_end"); } catch (e) { /* untidy, not broken */ }
}

// The public.users row for the signed-in account, shaped like the old
// /api/auth/me payload: the public profile plus the resolved permission map.
async function profile() {
  // One RPC, not a lookup keyed on auth_id. auth_id is the GoTrue
  // identifier that ties a profile row to a login, and it has no business
  // crossing the wire — my_profile() answers "who am I" without it, and
  // returns the resolved permission map in the same round trip.
  const me = await sb.rpc("my_profile").then(unwrap);
  if (!me || !me.id) throw new Error("Not signed in");
  return me;
}

// ------------------------------------------------------- Edge fallback
// Anything neither table matched goes to the catch-all function, which runs
// the ported handler. This is what lets the computed routes land one at a time.
async function edge(method, path, body, q) {
  const { data: { session } } = await sb.auth.getSession();
  const qs = new URLSearchParams(q).toString();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/api${path}${qs ? "?" + qs : ""}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON,
      Authorization: "Bearer " + (session ? session.access_token : SUPABASE_ANON),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || "Request failed");
  return data;
}

// ------------------------------------------------------------ storage
// The buckets are private (§8), so an object is read through a signed URL.
const _signed = new Map();
async function fileUrl(bucket, name) {
  if (!name) return "";
  const key = bucket + "/" + name;
  const hit = _signed.get(key);
  if (hit && hit.until > Date.now()) return hit.url;
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(name, 3600);
  if (error) return "";
  _signed.set(key, { url: data.signedUrl, until: Date.now() + 3000 * 1000 });
  return data.signedUrl;
}
window.fileUrl = fileUrl;

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
    // The read cache is deliberately NOT dropped — same reasoning as the
    // original file: clearAuth also runs when a token simply expires.
  },

  async _cached(path) {
    if (!window.ReadStore) return null;
    const row = await window.ReadStore.get(path);
    if (!row) return null;
    window.dispatchEvent(new CustomEvent("rs-stale", { detail: { path, ts: row.ts } }));
    return row.data;
  },

  async request(method, rawPath, body) {
    const [path, qs] = String(rawPath).split("?");
    const q = Object.fromEntries(new URLSearchParams(qs || ""));
    const mutating = method !== "GET";

    try {
      let data;
      let handled = false;
      for (const [rm, re, fn] of ROUTES) {
        if (rm !== method) continue;
        const hit = re.exec(path);
        if (hit) { data = await fn(hit, body, q); handled = true; break; }
      }
      if (!handled) {
        data = await generic(method, path, body, q);
        handled = data !== undefined;
      }
      if (!handled) data = await edge(method, path, body, q);

      if (!mutating && data !== null && data !== undefined && window.ReadStore) {
        window.ReadStore.put(rawPath, data);
        window.dispatchEvent(new CustomEvent("rs-fresh", { detail: { path: rawPath } }));
      }
      return data;

    } catch (e) {
      // Offline behaviour, preserved exactly from the original file.
      const msg = e.message || "";
      const offline = !navigator.onLine || /fetch|network|failed to fetch/i.test(msg);
      if (offline && mutating && window.OfflineQueue) {
        await window.OfflineQueue.enqueue({ kind: "json", method, path: rawPath, body: body || {} });
        return { __queued: true };
      }
      if (offline && !mutating) {
        const hit = await this._cached(rawPath);
        if (hit !== null) return hit;
        throw new Error("offline_no_data");
      }
      if (/JWT|jwt expired|not signed in|no profile/i.test(msg)) {
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
    const key = `${entityType}/${entityId}/${Date.now()}-${file.name || "photo.jpg"}`;
    const { error } = await sb.storage.from("photos").upload(key, file, { upsert: false });
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
    return withTable("photos", () => ins("photos", {
      entity_type: entityType, entity_id: entityId,
      filename: key, original_name: file.name || null,
      caption: caption || null,
      is_business_plan: businessPlan ? 1 : 0,
    }));
  },

  async uploadDoc(path, file, fields) {
    const key = `${Date.now()}-${file.name}`;
    const { error } = await sb.storage.from("documents").upload(key, file);
    if (error) throw new Error(error.message);
    return withTable("company_files", () => ins("company_files", {
      ...(fields || {}), filename: key, original_name: file.name, size_bytes: file.size }));
  },

  async uploadSiteMap(siteId, file) {
    const key = `sites/${siteId}/${Date.now()}-${file.name}`;
    const { error } = await sb.storage.from("maps").upload(key, file, { upsert: true });
    if (error) throw new Error(error.message);
    return withTable("sites", () => upd("sites", siteId, { map_image: key }));
  },
};
