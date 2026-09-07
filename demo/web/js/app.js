// ====================================================================
// PestCare CRM — single-page front-end
// ====================================================================
// Which web build the device is actually running. The APK is a shell around
// this site, so a phone can sit on last week's app.js long after the server was
// updated (the service worker fixes itself on the next resume — but only if it
// has been resumed). Printing it in the menu foot turns "it still doesn't work
// on my phone" into a question anyone can answer in two seconds. Bump it with
// the service-worker version whenever the front-end ships.
const APP_BUILD = "2026-09-06m";
// WHICH APK IS THIS? Only 1.8 and later answer PestPrint.appVersion(), so an
// app that says nothing is 1.7 or older. Declared here, at the top, because the
// login screen prints it — and that is drawn long before the sidebar section
// further down this file would have run.
const IS_APP = document.documentElement.classList.contains("pc-app");
function apkVersion() {
  try {
    if (window.PestPrint && typeof window.PestPrint.appVersion === "function") {
      return String(window.PestPrint.appVersion() || "").trim();
    }
  } catch (e) { /* an APK that cannot answer is an old one */ }
  return "";
}
const APK_VERSION = IS_APP ? apkVersion() : "";
const IS_OLD_APP = IS_APP && !APK_VERSION;   // 1.7 and earlier: no appVersion()
const $ = (id) => document.getElementById(id);
const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

function currencyLabel() { return (SETTINGS && SETTINGS.currency) || t("currency"); }
function money(n) { return (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + currencyLabel(); }
function fmtDate(s) { if (!s) return "—"; const d = new Date(s.replace(" ", "T")); return isNaN(d) ? s : d.toLocaleDateString(LANG === "ar" ? "ar" : "en-GB"); }
// hourCycle h23 keeps times 24-hour (00:00–23:59) whatever the device is set to
// — the app is rostered and dispatched in 24-hour throughout.
function fmtDateTime(s) {
  if (!s) return "—";
  const d = new Date(s.replace(" ", "T"));
  return isNaN(d) ? s : d.toLocaleString(LANG === "ar" ? "ar" : "en-GB", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
}
function toast(msg) { const e = $("toast"); e.textContent = msg; e.classList.remove("hidden"); setTimeout(() => e.classList.add("hidden"), 2200); }

// A write that was queued offline returns {__queued:true} instead of the saved
// record — it has no server id yet, and the usual follow-up (refresh GET +
// navigate to the new/updated record) would fail offline and mask the success.
// In that case just close the form; the oq-queued toast ("saved offline — will
// sync") already confirms it. Returns true when the caller should stop here.
function handledOffline(saved, optimisticEl) {
  if (saved && saved.__queued) {
    // Offline delete: drop the row immediately (no refresh possible) so the UI
    // reflects the queued removal; the delete replays on reconnect.
    if (optimisticEl) optimisticEl.remove();
    closeModal();
    return true;
  }
  return false;
}

function role() { return API.user ? API.user.role : null; }
// Whoever holds the engineer list can filter and assign by engineer. Gating
// these on users.view tied them to user ADMINISTRATION, which a supervisor
// deliberately does not have while still running other people's work.
function hasAgentList() { return (cache.agents || []).length > 0; }
// Whoever actually works a job. Both supervising roles carry visits like an
// engineer — an area manager answers for a patch, a team leader for a crew —
// so every "is this the person in the field" question has to answer yes for
// all three; asking role()==="agent" would quietly take My Day and the
// materials screens off a supervisor.
const SUPERVISOR_ROLES = ["area_manager", "team_leader"];
function isField() { return role() === "agent" || isLeader(); }
// "Leader" here means either supervising role: somebody with people or places
// under them. Where the two differ, ask isAreaManager() / isTeamLeader().
function isLeader() { return SUPERVISOR_ROLES.includes(role()); }
function isAreaManager() { return role() === "area_manager"; }
function isTeamLeader() { return role() === "team_leader"; }

// ---- RBAC: permission checks driven by API.user.permissions ----
// admin is always allowed; otherwise consult the resolved permission map.
function can(perm) {
  if (!API.user) return false;
  if (API.user.role === "admin") return true;
  const p = API.user.permissions || {};
  return !!p[perm];
}
// True if the user has any action within a module (e.g. "invoices").
function canModule(mod) {
  if (!API.user) return false;
  if (API.user.role === "admin") return true;
  const p = API.user.permissions || {};
  return Object.keys(p).some(k => k.startsWith(mod + ".") && p[k]);
}

// ---- pagination helper for list views ----
const PAGE_SIZE = 25;
function pagerHTML(d) {
  if (!d || (d.pages || 1) <= 1) return "";
  return `<div class="pager">
    <button class="btn sm secondary" data-pg="prev" ${d.page <= 1 ? "disabled" : ""}>‹ ${t("prev")}</button>
    <span class="muted small">${t("page")} ${d.page} / ${d.pages} · ${d.total}</span>
    <button class="btn sm secondary" data-pg="next" ${d.page >= d.pages ? "disabled" : ""}>${t("next")} ›</button></div>`;
}
function wirePager(scope, d, go) {
  scope.querySelectorAll("[data-pg]").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.pg === "prev" && d.page > 1) go(d.page - 1);
    else if (b.dataset.pg === "next" && d.page < d.pages) go(d.page + 1);
  }));
}

// ---- caches for dropdowns ----
const cache = { services: [], agents: [], clients: [], chemicals: [], areas: null };
let SETTINGS = {};
async function loadCaches() {
  try { SETTINGS = await API.get("/settings"); } catch (e) {}
  try { cache.services = await API.get("/service-types"); } catch (e) {}
  // The engineer list drives every "who does this job" picker and the dispatch
  // board's columns, so anyone who assigns work needs it — not just user admins.
  if (can("users.view") || can("dispatch.view") || can("visits.edit")) {
    try { cache.agents = await API.get("/agents"); } catch (e) {}
  }
  if (can("clients.view")) { try { cache.clients = await API.get("/clients"); } catch (e) {} }
  // Engineers need the catalog for usage/issue pickers even without chemicals.view.
  if (can("chemicals.view") || can("issues.view")) {
    try { cache.chemicals = await API.get("/chemicals"); } catch (e) {}
  }
}

// ====================================================================
// Boot / auth
// ====================================================================
function applyStaticLabels() {
  document.documentElement.lang = LANG;
  document.documentElement.dir = LANG === "ar" ? "rtl" : "ltr";
  $("login-title").textContent = t("app_name");
  $("login-tagline").textContent = t("tagline");
  $("lbl-email").textContent = t("email");
  $("lbl-password").textContent = t("password");
  $("login-btn").textContent = t("sign_in");
  $("login-lang").textContent = t("language");
  $("brand-name").textContent = t("app_name");
  $("logout-btn").textContent = t("logout");
  // Only relabel the install button while it's actually offered (checking the
  // class, not the prompt variable, which is declared further down the file).
  const ib = $("install-btn");
  if (ib && !ib.classList.contains("hidden")) ib.textContent = "📲 " + t("install_app");
  $("lang-toggle").textContent = t("language");
  $("quick-search").placeholder = t("search_placeholder");
  if ($("nav-back")) $("nav-back").title = t("back");
  if ($("nav-refresh")) $("nav-refresh").title = t("refresh");
  // The login screen names the build (and, in the app, the APK) — the ONE
  // screen everybody reaches without touching the menu, which matters when the
  // menu is what is broken.
  $("login-powered").textContent = t("powered_by") + " · " + APP_BUILD
    + (IS_APP ? " · " + (APK_VERSION ? "app " + APK_VERSION : t("app_old_version")) : "");
  $("sidebar-powered").textContent = t("powered_by") + " · " + APP_BUILD
    + (IS_APP ? " · " + (APK_VERSION ? "app " + APK_VERSION : t("app_old_version")) : "");
  if (typeof syncAppUpdateBar === "function") syncAppUpdateBar();   // language switch
}

// A phone gets the phone layout (html.pc-phone, set in index.html before the
// app boots): one column, device-width, no pinch-zoom needed.
const IS_PHONE = document.documentElement.classList.contains("pc-phone");

// A FINGER, NOT A POINTER. HTML5 drag-and-drop never fires on a touch screen,
// so anything whose only gesture is a drag has to offer a second way in — the
// dispatch board's ⇄, for one. A phone always counts; so does a tablet running
// the app, which gets the desktop layout and the same dead drag. A desktop
// (fine pointer) keeps the drag alone, exactly as it was.
const IS_TOUCH = IS_PHONE || !!(window.matchMedia
  && window.matchMedia("(pointer: coarse)").matches);

// Tables that are genuinely a matrix — read across AND down — stay tables on a
// phone and scroll inside their box. Everything else reads better as one card
// per row (see .pc-cards in styles.css).
const NO_CARD_TABLES = ["perm-table", "sh-table", "li-table", "bud-form",
                        "rdoc-table", "cat-table", "dg", "no-cards"];

// Wrap data tables in a horizontal-scroll box so a wide table scrolls inside
// itself instead of pushing the whole page sideways — WITHOUT changing the
// table's layout (so narrow tables stay full-width, no blank gaps). Runs on
// every render via a MutationObserver on the view + modal containers.
//
// On a phone it also labels every cell with its column heading, which is what
// lets CSS restack the row as a card without any of the ~90 render functions
// knowing about it: the heading text becomes the label beside the value.
function installTableScroll() {
  const wrap = (t) => {
    if (!t.parentNode || (t.parentNode.classList && t.parentNode.classList.contains("table-scroll"))) return;
    const box = document.createElement("div");
    box.className = "table-scroll";
    t.parentNode.insertBefore(box, t);
    box.appendChild(t);
  };
  // Column headings of the table this row belongs to, trimmed of any markup.
  const headings = (table) => {
    if (table.__pcHeads) return table.__pcHeads;
    const hr = table.querySelector("thead tr");
    const heads = hr ? Array.from(hr.cells).map(th => (th.textContent || "").trim()) : [];
    table.__pcHeads = heads;
    return heads;
  };
  const labelRow = (tr, table, heads) => {
    if (!tr.cells || tr.dataset.pcLabelled) return;
    tr.dataset.pcLabelled = "1";
    let col = 0, titled = tr.parentNode !== table.tBodies[0];
    for (const td of tr.cells) {
      const span = td.colSpan || 1;
      const head = span > 1 ? "" : (heads[col] || "");
      col += span;
      // Controls (row buttons, a select-row checkbox, a QR thumbnail) need the
      // whole width; a label beside them reads as noise.
      if (span > 1 || td.querySelector("button, input, select, textarea, svg, img")) {
        td.classList.add("pc-wide");
      } else if (!titled && (td.textContent || "").trim()) {
        // First real cell of the row is the card's headline.
        td.classList.add("pc-title");
        titled = true;
      }
      td.setAttribute("data-label", head);
    }
  };
  const cardify = (t) => {
    if (NO_CARD_TABLES.some(c => t.classList.contains(c))) return;
    t.classList.add("pc-cards");
    // Card layout hides the header row, so a heading that carries a control of
    // its own (the devices list keeps its select-all checkbox there) would go
    // with it. Those cells are kept, on their own strip above the cards.
    if (t.querySelector("thead input, thead button, thead select")) {
      t.classList.add("pc-headkeep");
      t.querySelectorAll("thead th").forEach(th => {
        if (th.querySelector("input, button, select")) th.classList.add("pc-ctl");
      });
    }
    const heads = headings(t);
    // closest() keeps a nested table's rows (a contract's per-site breakdown)
    // out of the outer table's column labels.
    t.querySelectorAll("tr").forEach(tr => {
      if (tr.cells.length && tr.closest("table") === t) labelRow(tr, t, heads);
    });
  };
  const handle = (t) => { wrap(t); if (IS_PHONE) cardify(t); };
  const scan = (root) => { if (root.querySelectorAll) root.querySelectorAll("table").forEach(handle); };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.tagName === "TABLE") handle(n);
      else if (IS_PHONE && n.tagName === "TR") {
        // A row appended to a table that was already laid out (a lazily loaded
        // list) still needs its labels.
        const t = n.closest("table");
        if (t && t.classList.contains("pc-cards")) labelRow(n, t, headings(t));
      } else scan(n);
    }
  });
  ["view", "modal-body"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { scan(el); obs.observe(el, { childList: true, subtree: true }); }
  });
}

async function boot() {
  setLang(LANG);
  applyStaticLabels();
  installTableScroll();
  if (API.token && API.user) {
    // Refresh the profile so the resolved permission map is always current.
    try {
      const me = await API.get("/auth/me");
      if (me) { API.setAuth(API.token, me); _permSyncAt = Date.now(); }
      await loadNavPrefs();
      showApp();
    } catch (e) {
      // Offline / network error: keep the cached session so field agents can
      // keep working. A real 401 clears auth + reloads inside API.request.
      if (API.token && API.user) showApp();
      else { API.clearAuth(); showLogin(); }
    }
  } else showLogin();
}

// ---- THE PERMISSION MAP GOES STALE, AND NOTHING USED TO NOTICE ------------
// `can()` reads API.user.permissions, which is written at login and refreshed
// exactly once more: in boot(), on a full page load. That is the one thing an
// installed app almost never does. The Android WebView RESTORES the open page
// on resume instead of navigating, pull-to-refresh is off, and ↻ only re-fetches
// the current screen's data — so an engineer's permission map was whatever it
// was the last time the app was cold-started, and could sit there for days. The
// office would grant a permission, watch the engineer open the app, see no
// change, and try again (five saves of the agent role on 30 Aug, seven of one
// user's on 31 Aug — the shape of somebody retrying something that never
// arrived). The server was right the whole time: a fresh login always had it.
//
// So the map is re-read whenever the app comes back to the front, when the
// network returns, on ↻, and at most once a minute while it is simply being
// used. Nothing is thrown away when the answer cannot be fetched — an engineer
// in a basement keeps working under the rules they already have.
let _permSyncAt = 0, _permSyncing = false;
function _samePerms(a, b) {
  a = a || {}; b = b || {};
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => !!a[k] === !!b[k]);
}
async function syncMyPerms(opts) {
  if (!API.token || !API.user || _permSyncing) return false;
  if (!(opts && opts.force) && Date.now() - _permSyncAt < 60000) return false;
  _permSyncing = true;
  try {
    const me = await API.get("/auth/me");
    if (!me || !me.permissions) return false;
    _permSyncAt = Date.now();
    if (me.role === API.user.role && _samePerms(me.permissions, API.user.permissions)) return false;
    API.setAuth(API.token, me);
    renderNav();
    // The screen they are on was drawn under the old rules — one they may no
    // longer be allowed, or one that was missing a button they now have. It is
    // re-run, but never over a half-typed form or an open dialog: the new rules
    // reach that screen on the next navigation instead, which is soon enough.
    if (currentView && safeToReloadNow()) await reNavigate();
    toast(t("perms_changed"));
    return true;
  } catch (e) {
    return false;      // offline, or the server is between restarts
  } finally { _permSyncing = false; }
}

function showLogin() {
  $("login-screen").classList.remove("hidden");
  $("app").classList.add("hidden");
  applyStaticLabels();
}

async function showApp() {
  $("login-screen").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("user-name").textContent = API.user.full_name;
  $("user-role").textContent = t("role_" + API.user.role);
  await loadCaches();
  renderNav();
  initNotifications();
  initOfflineUI();
  // A QR deep link (/scan/<token>) opens the scanned device straight away.
  const scanTok = scanTokenFromUrl();
  if (scanTok) { navigate("scan", { token: scanTok }); return; }
  navigate("dashboard");
  promptDraftReports();
  warmOfflineCache();
}

// A report saved with no signal is queued for the server, but the agent will
// reopen that visit long before the queue drains — so the same text is folded
// into the cached copy of the visit they will read it from.
async function patchCachedReport(visitId, fields) {
  if (!window.ReadStore) return;
  try {
    await window.ReadStore.patch(`/visits/${visitId}`, (v) => {
      if (!v || typeof v !== "object") return undefined;
      return { ...v, report: { ...(v.report || {}), ...fields, __queued: true } };
    });
  } catch (e) { /* the queue is still the record that matters */ }
}

// ====================================================================
// Offline readiness
// ====================================================================
// Caching what the user happens to open is not enough: an agent who drives to a
// site with no signal needs today's work already on the phone. So while there IS
// a connection, fetch the screens the field actually depends on — the reads all
// flow through API.get, which stores them on the way past.
//
// Deliberately modest: the agent's own days, the companies and products behind
// them, and the detail page of each visit that is about to be worked. Office
// screens (invoices, analytics, payroll) are not pre-warmed — they are read at a
// desk, and a phone should not carry the company's finances around.
let warming = false;
async function warmOfflineCache() {
  if (warming || !navigator.onLine || !window.ReadStore) return;
  warming = true;
  const quiet = async (p) => { try { return await API.get(p); } catch (e) { return null; } };
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return ymd(d);
  };
  try {
    // Cached answers are keyed by the EXACT path a screen asks for, so the warm
    // list has to mirror the calls those screens make — a range that looks
    // equivalent but is spelled differently is a cache miss in the field.
    const paths = ["/settings", "/service-types", "/auth/me", `/notifications?lang=${LANG}`,
                   "/dashboard"];
    if (role() === "client") {
      // "/visits?status=completed" is what the certificates page asks for —
      // there is no /certificates endpoint, and warming a 404 helps nobody.
      paths.push("/visits", "/contracts", "/invoices", "/ipm-files",
                 "/visits?status=completed");
    } else {
      paths.push("/clients", `/visits?page=1&limit=${PAGE_SIZE}`);
      // My Day asks for one date at a time: yesterday (a job that ran late),
      // today, and tomorrow (an early start with no signal at the depot).
      // A supervisor's My Day names itself in the query (see viewMyDay), so the
      // warm path has to carry the same filter or it is a miss in the field.
      for (const off of [-1, 0, 1]) {
        paths.push(`/visits?from=${day(off)}&to=${day(off)}`);
        if (isLeader()) paths.push(`/visits?from=${day(off)}&to=${day(off)}&agent=${API.user.id}`);
      }
      if (isLeader()) paths.push(`/my-team?date=${day(0)}`);
      if (can("chemicals.view") || can("issues.view")) paths.push("/chemicals");
      if (can("issues.view")) paths.push("/issues", "/issues/balance");
      if (can("shifts.view")) paths.push(`/shifts?from=${day(-1)}&to=${day(7)}`);
    }
    for (const p of paths) await quiet(p);

    // Then the visit pages themselves: the report form an agent stands in front
    // of a trap filling in, its device list and its photos. Two days is enough
    // to cover a shift without turning the phone into an archive.
    const seen = new Set();
    for (const off of [0, 1]) {
      const res = await quiet(`/visits?from=${day(off)}&to=${day(off)}`);
      const list = (res && (res.items || res)) || [];
      for (const v of list.slice(0, 12)) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        // Clients read a translated copy; staff read the original. Warm the one
        // this user's visit page will actually request.
        await quiet(role() === "client" ? `/visits/${v.id}?lang=${LANG}` : `/visits/${v.id}`);
        await quiet(`/visits/${v.id}/devices`);
        await quiet(`/photos?entity_type=visit&entity_id=${v.id}`);
        if (v.client_id) await quiet("/clients/" + v.client_id);
      }
    }
    await window.ReadStore.prune();
    const st = await window.ReadStore.stats();
    console.info(`offline cache: ${st.entries} screens ready`);
    window.dispatchEvent(new CustomEvent("rs-warm", { detail: st }));
  } finally { warming = false; }
}

// Top the cache up whenever the signal comes back, so the next dead spot is
// covered by fresh data rather than whatever was there hours ago.
window.addEventListener("online", () => {
  setTimeout(warmOfflineCache, 2500);
  syncMyPerms({ force: true });
});
// Resuming the app is the moment a permission change from the office can land:
// the WebView does not navigate on resume, so this is the only thing that asks.
// Deliberately not rate-limited: coming back to the front is a rare, deliberate
// act by a person, and the office granting something and the engineer opening
// the app to look for it happens inside the same minute all the time.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncMyPerms({ force: true });
});

// Pull the device code/token out of a /scan/<x> deep link, if we're on one.
// Matches both printed device codes (LIT0001) and legacy marker hex tokens.
function scanTokenFromUrl() {
  const m = location.pathname.match(/^\/scan\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// On login, if the user has unfinished (draft) reports, pop up a reminder to
// complete & save them. Drafts are auto-saved server-side, so this fires when an
// agent logged out mid-report.
async function promptDraftReports() {
  if (role() === "client") return;
  try {
    const d = await API.get("/reports/drafts");
    const items = (d && d.items) || [];
    if (!items.length) return;
    const rows = items.map(r => `<div class="notif" data-visit="${r.visit_id}" style="cursor:pointer">
        <div class="nt">${esc(localized(r, "name"))}</div>
        <div class="nb muted small">${r.scheduled_start ? fmtDateTime(r.scheduled_start) : ""}${role() !== "agent" && r.agent_name ? " · " + esc(r.agent_name) : ""}</div>
      </div>`).join("");
    openModal(`⚠ ${t("drafts_pending_title")}`, `<p class="muted">${t("drafts_pending_body")}</p>${rows}`, (body) => {
      body.querySelectorAll("[data-visit]").forEach(el => el.addEventListener("click", () => {
        closeModal(); navigate("visit", { id: el.dataset.visit });
      }));
    });
  } catch (e) { /* non-blocking */ }
}

// ---- offline status pill + pending-sync badge ----
// When a screen is drawn from the read cache, remember how old that answer was
// so the status pill can say "data from 07:40" rather than implying it is live.
let cacheStampAt = null;
function fmtClock(ts) {
  const d = new Date(ts);
  return isNaN(d) ? "" : d.toLocaleTimeString(LANG === "ar" ? "ar" : "en-GB",
                                              { hour: "2-digit", minute: "2-digit" });
}

function initOfflineUI() {
  const el = $("offline-status");
  if (!el || el.dataset.wired) {
    if (el) renderOfflineStatus();
    if (navigator.onLine && window.OfflineQueue) window.OfflineQueue.flush();
    return;
  }
  el.dataset.wired = "1";
  el.addEventListener("click", () => { if (window.OfflineQueue) window.OfflineQueue.flush(); });
  window.addEventListener("online", renderOfflineStatus);
  window.addEventListener("offline", renderOfflineStatus);
  window.addEventListener("rs-stale", (e) => {
    cacheStampAt = (e.detail && e.detail.ts) || cacheStampAt;
    renderOfflineStatus();
  });
  window.addEventListener("rs-fresh", () => { cacheStampAt = null; });
  window.addEventListener("oq-change", renderOfflineStatus);
  window.addEventListener("oq-queued", (e) => toast(t(e.detail && e.detail.method === "DELETE" ? "deleted_offline" : "saved_offline")));
  window.addEventListener("oq-synced", (e) => { toast(`${e.detail.synced} ${t("synced_ok")}`); renderOfflineStatus(); });
  renderOfflineStatus();
  if (navigator.onLine && window.OfflineQueue) window.OfflineQueue.flush();
}

async function renderOfflineStatus() {
  const el = $("offline-status");
  if (!el) return;
  let count = 0;
  try { count = window.OfflineQueue ? await window.OfflineQueue.count() : 0; } catch (e) {}
  if (!navigator.onLine) {
    el.className = "offline-status off";
    el.textContent = "⚠ " + t("offline") + (count ? ` · ${count}` : "")
      + (cacheStampAt ? " · " + t("data_from") + " " + fmtClock(cacheStampAt) : "");
  } else if (count > 0) {
    el.className = "offline-status pend";
    el.textContent = `⟳ ${count} ${t("to_sync")}`;
  } else {
    el.className = "offline-status hidden";
  }
}

// login form
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").classList.add("hidden");
  try {
    const r = await API.post("/auth/login", { email: $("login-email").value, password: $("login-password").value });
    API.setAuth(r.token, r.user);
    if (r.user.lang) setLang(r.user.lang);
    applyStaticLabels();
    showApp();
  } catch (err) {
    $("login-error").textContent = t("invalid_login");
    $("login-error").classList.remove("hidden");
  }
});
$("login-lang").addEventListener("click", () => { toggleLang(); applyStaticLabels(); });
$("lang-toggle").addEventListener("click", () => { toggleLang(); applyStaticLabels(); showApp(); });
$("logout-btn").addEventListener("click", async () => {
  try { await API.post("/auth/logout", {}); } catch (e) {}  // revoke token server-side
  // Signing out on a shared phone must take the cached data with it. Queued
  // writes stay: they are unsent work, and they replay after the next sign-in.
  if (window.ReadStore) { try { await window.ReadStore.clearAll(); } catch (e) {} }
  API.clearAuth(); showLogin();
});

// quick search
$("quick-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.value.trim()) navigate("search", { q: e.target.value.trim() });
});

// ====================================================================
// Navigation
// ====================================================================
// The sidebar is deliberately text-only: emoji icons read as a toy next to a
// customer's own finance software, so every tab is just its localized name.
function navItems() {
  const items = [{ k: "dashboard", t: "nav_dashboard" }];
  if (role() === "client") {
    if (can("visits.view")) items.push({ k: "visits", t: "nav_visits" });
    if (can("requests.view")) items.push({ k: "requests", t: "nav_requests" });
    if (can("contracts.view")) items.push({ k: "contracts", t: "nav_contracts" });
    if (can("invoices.view")) items.push({ k: "invoices", t: "nav_invoices" });
    if (can("certificates.view")) items.push({ k: "certificates", t: "nav_certificates" });
    if (can("ipm.view")) items.push({ k: "ipm", t: "nav_ipm" });
    items.push({ k: "my-devices", t: "nav_my_devices" });
    items.push({ k: "folder", t: "company_folder" });
  } else {
    if (isField()) items.push({ k: "myday", t: "nav_myday" });
    if (isLeader()) items.push({ k: "myteam", t: "nav_myteam" });
    if (can("clients.view")) items.push({ k: "clients", t: "nav_clients" });
    if (can("leads.view")) items.push({ k: "leads", t: "nav_leads" });
    if (can("clients.view")) items.push({ k: "locations", t: "nav_locations" });
    if (can("visits.view")) items.push({ k: "schedule", t: "nav_schedule" });
    if (can("dispatch.view")) items.push({ k: "dispatch", t: "nav_dispatch" });
    if (can("requests.view")) items.push({ k: "requests", t: "nav_requests" });
    if (can("visits.view")) items.push({ k: "reports", t: "nav_reports" });
    if (can("transport.view")) items.push({ k: "transport", t: "nav_transport" });
    if (can("calendar.view")) items.push({ k: "calendar", t: "nav_calendar" });
    if (can("shifts.view")) items.push({ k: "shifts", t: "nav_shifts" });
    if (can("contracts.view")) items.push({ k: "contracts", t: "nav_contracts" });
    if (can("chemicals.view")) items.push({ k: "chemicals", t: "nav_chemicals" });
    if (can("issues.view")) items.push({ k: "issues", t: "nav_issues" });
    if (can("cash.view")) items.push({ k: "cash", t: "nav_cash" });
    if (can("devices.view")) items.push({ k: "devices", t: "nav_devices" });
    if (can("ipm.view")) items.push({ k: "ipm", t: "nav_ipm" });
    if (can("invoices.view")) items.push({ k: "invoices", t: "nav_invoices" });
    if (can("finance.view")) items.push({ k: "finance", t: "nav_finance" });
    // An engineer holds this for their own number only, so it is named for
    // what they actually open — their target, not the team's board.
    if (can("targets.view")) items.push({ k: "marketing",
      t: isField() ? "nav_my_target" : "nav_marketing" });
    if (can("analytics.view")) items.push({ k: "analytics", t: "nav_analytics" });
    if (can("users.view")) items.push({ k: "agents", t: "nav_agents" });
    if (can("shifts.edit")) items.push({ k: "availability", t: "nav_availability" });
    if (can("shifts.edit")) items.push({ k: "fixedposts", t: "nav_fixedposts" });
    if (can("clients.edit")) items.push({ k: "branchsched", t: "nav_branch_schedule" });
    if (can("visits.view")) items.push({ k: "pipeline", t: "nav_pipeline" });
    if (can("settings.edit")) items.push({ k: "areas", t: "nav_areas" });
    if (can("settings.edit")) items.push({ k: "reportopts", t: "nav_report_options" });
    if (can("settings.view")) items.push({ k: "settings", t: "nav_settings" });
    if (can("permissions.view")) items.push({ k: "permissions", t: "nav_permissions" });
    // A full backup is every customer, every engineer and their credentials in
    // one file, and a restore replaces all of it — the owner's screen, nobody
    // else's, so it hangs off the role rather than a permission.
    if (role() === "admin") items.push({ k: "backup", t: "nav_backup" });
  }
  // Search sweeps clients/chemicals/invoices — nothing an engineer works from.
  if (role() !== "agent") items.push({ k: "search", t: "nav_search" });
  return items;
}
// WHAT HE HAS PUT BEHIND "MORE". A preference, never a permission: everything
// here is still his to open, it is simply not on the front of the menu.
let NAV_HIDDEN = [];
async function loadNavPrefs() {
  try {
    const d = await API.get("/me/prefs");
    NAV_HIDDEN = ((d.prefs || {}).nav_hidden) || [];
  } catch (e) { NAV_HIDDEN = []; }
}

function renderNav() {
  const all = navItems();
  const hidden = new Set(NAV_HIDDEN);
  const shown = all.filter(it => !hidden.has(it.k));
  const tucked = all.filter(it => hidden.has(it.k));
  const link = (it) => `<a class="nav-item" data-view="${it.k}"><span>${t(it.t)}</span></a>`;
  // ANYTHING HIDDEN IS STILL ONE CLICK AWAY. A menu you cannot get back from
  // is not a tidy menu, it is a lost feature.
  const more = tucked.length ? `<details class="nav-more"${
      tucked.some(it => it.k === currentView) ? " open" : ""}>
      <summary>${t("nav_more")} <span class="n">${tucked.length}</span></summary>
      ${tucked.map(link).join("")}</details>` : "";
  const gear = role() === "admin"
    ? `<a class="nav-item nav-customise" id="nav-customise"><span>⚙ ${t("nav_customise")}</span></a>` : "";
  $("nav").innerHTML = shown.map(link).join("") + more + gear;
  $("nav").querySelectorAll(".nav-item[data-view]").forEach(a =>
    // Pressing the section you are already in is how you ask for the top of it.
    a.addEventListener("click", () => navigate(a.dataset.view, undefined, { top: true })));
  if ($("nav-customise")) $("nav-customise").addEventListener("click", customiseMenu);
  renderTabbar();
}

// HIS MENU, HIS CHOICE. Tick what belongs on the front of it; everything else
// goes under "More". Nothing is taken away and nothing about what he may do
// changes — which is why this is a preference and not a permission.
function customiseMenu() {
  const all = navItems();
  const hidden = new Set(NAV_HIDDEN);
  openModal(t("nav_customise"), `<form id="nav-cf">
      <p class="muted small">${t("nav_customise_hint")}</p>
      <div class="chk-grid">${all.map(it => it.k === "dashboard" ? "" :
        `<label class="chk-item"><input type="checkbox" value="${it.k}"${
          hidden.has(it.k) ? "" : " checked"}> ${esc(t(it.t))}</label>`).join("")}</div>
      <div class="modal-actions">
        <button type="button" class="btn secondary" id="nav-all">${t("nav_show_all")}</button>
        <button class="btn" type="submit">${t("save")}</button></div>
    </form>`);
  $("nav-all").addEventListener("click", () => {
    document.querySelectorAll("#nav-cf input[type=checkbox]").forEach(c => { c.checked = true; });
  });
  $("nav-cf").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const off = [...document.querySelectorAll("#nav-cf input[type=checkbox]")]
      .filter(c => !c.checked).map(c => c.value);
    try {
      const d = await API.put("/me/prefs", { nav_hidden: off });
      NAV_HIDDEN = ((d.prefs || {}).nav_hidden) || [];
      closeModal(); renderNav(); toast(t("saved"));
    } catch (e) { alert(e.message || t("error")); }
  });
}

// ---- Bottom tab bar (phone only) ----------------------------------------
// The sections a role opens all day, one thumb away, where every other field
// app on that phone keeps them — instead of behind a drawer that has to be
// opened, scrolled and dismissed between every two screens. Everything else is
// still one tap further on, under ☰. Built from navItems(), so a section the
// user has no permission for can never show up here either.
const TAB_ORDER = {
  agent:  ["myday", "schedule", "reports", "clients"],
  client: ["dashboard", "visits", "invoices", "requests"],
  staff:  ["dashboard", "schedule", "clients", "invoices"],
};
function renderTabbar() {
  const bar = $("tabbar");
  if (!bar || !IS_PHONE) return;
  const avail = navItems();
  const wanted = TAB_ORDER[role()] || TAB_ORDER.staff;
  const picked = [];
  wanted.forEach(k => {
    const it = avail.find(i => i.k === k);
    if (it && picked.length < 4) picked.push(it);
  });
  // A role with fewer than four of those (a stripped-down permission set) fills
  // the bar from the top of its own sidebar rather than showing gaps.
  avail.forEach(it => { if (picked.length < 4 && !picked.includes(it)) picked.push(it); });
  bar.innerHTML = picked.map(it =>
    `<button type="button" class="tab-item" data-view="${it.k}">${esc(t(it.t))}</button>`).join("") +
    `<button type="button" class="tab-item" id="tab-more">☰ ${esc(t("menu"))}</button>`;
  bar.querySelectorAll("[data-view]").forEach(b =>
    b.addEventListener("click", () => navigate(b.dataset.view, undefined, { top: true })));
  $("tab-more").addEventListener("click", () => {
    $("app").classList.remove("nav-collapsed");
    syncDrawerLock();
  });
  updateTabbar();
}
function updateTabbar() {
  const bar = $("tabbar");
  if (!bar || !IS_PHONE) return;
  bar.querySelectorAll("[data-view]").forEach(b =>
    b.classList.toggle("active", b.dataset.view === currentView));
}

let currentView = null;
// The argument the current view was rendered with, so a dialog can send the
// user back to exactly the screen they opened it from (reNavigate).
let currentArg = null;
const reNavigate = () => navigate(currentView, currentArg);

// ---- Where you came from -------------------------------------------------
// Opening a client, a visit or a scanned device is a step INTO something, and
// the way out used to be the sidebar — back to the top of a section you were
// already deep inside. This keeps the trail so the topbar's ← walks it back.
const navTrail = [];
const NAV_TRAIL_MAX = 40;
const NAV_HOME = "dashboard";
let _navGoingBack = false;
// With an empty trail there is still a way out of anywhere that isn't home —
// which is what a phone that opened straight into a scanned QR code needs.
function navCanGoBack() { return navTrail.length > 0 || (!!currentView && currentView !== NAV_HOME); }
function navGoBack() {
  if (!navCanGoBack()) return false;
  const prev = navTrail.pop();
  _navGoingBack = true;
  navigate(prev ? prev.view : NAV_HOME, prev ? prev.arg : undefined);
  return true;
}
function updateNavButtons() {
  const b = $("nav-back");
  if (b) b.classList.toggle("hidden", !navCanGoBack());
}
// The Android shell asks these before it closes the app on hardware back.
window.pcCanGoBack = navCanGoBack;
window.pcGoBack = navGoBack;
// Views that must not render without the matching permission. The sidebar is
// already built from can(), but a bookmark, a back button or an in-app link
// can still ask for a view the user isn't allowed to see.
const VIEW_PERMS = { dispatch: "dispatch.view", chemicals: "chemicals.view", cash: "cash.view",
                     devices: "devices.view", requests: "requests.view",
                     ipm: "ipm.view", finance: "finance.view",
                     reportopts: "settings.edit", areas: "settings.edit",
                     availability: "shifts.edit" };

// WHERE YOU WERE WHEN YOU PRESSED SAVE.
// Most screens refresh themselves after an edit by calling navigate() again.
// That empties #view for as long as the reload takes, and a page with nothing
// in it cannot be scrolled — the browser clamps to the top, so the office lands
// back at row 1 of 179 after every single edit. He reported it on Branches and
// asked for it everywhere: "just make it save and stay where i am".
// So a re-render of the SAME screen holds the page's height while it loads and
// puts the scroll back afterwards. Going to a DIFFERENT screen still starts at
// its own top, and so does pressing a screen's own name in the sidebar or the
// tab bar (`{top: true}`) — that gesture MEANS "take me back to the top".
function holdPlace(v) {
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  if (!y) return null;
  // Pin the height first: without it the page collapses under the loading line
  // and the scroll position is gone before there is anything to put back.
  const h = v.offsetHeight;
  if (h) v.style.minHeight = h + "px";
  return () => {
    v.style.minHeight = "";
    // The user always wins: the moment they scroll, we stop putting them back.
    let stopped = false;
    const stop = () => { stopped = true; };
    const once = { passive: true, once: true };
    window.addEventListener("wheel", stop, once);
    window.addEventListener("touchstart", stop, once);
    window.addEventListener("keydown", stop, { once: true });
    const put = () => { if (!stopped) window.scrollTo(0, y); };
    put();
    requestAnimationFrame(put);
    // A screen that fetches part of itself late changes height underneath us —
    // Chemicals fills its purchase-order box after the first paint, which used
    // to shift the row you edited by 64px — so the place is re-taken briefly.
    setTimeout(put, 120);
    setTimeout(() => {
      put();
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", stop);
    }, 400);
  };
}

// EVERY NAVIGATION TAKES A TICKET. A screen that fetches (the dashboard reads
// the whole diary) can finish AFTER the user has moved on — and when it then
// fails, its error used to be painted over whatever screen they had reached:
// open the app, tap Dispatch straight away, and the board you asked for is
// replaced by "⚠️ Cannot set properties of null". The ticket says whether this
// render is still the one on screen.
let navSeq = 0;
async function navigate(view, arg, opts) {
  const seq = ++navSeq;
  // Leaving a screen is the safe moment to pick up newly deployed code: nothing
  // is half-typed and the next screen has to render anyway. No-op unless an
  // update is waiting (see markSwUpdate).
  if (typeof applyPendingUpdate === "function") applyPendingUpdate();
  // Same idea for the permission map, for a desktop tab that is never hidden
  // and never resumed. Deliberately not awaited: it must not slow a screen down.
  if (typeof syncMyPerms === "function") syncMyPerms();
  // The same screen with the same argument is a REFRESH — a save, the ↻ button,
  // a filter — not a step in the trail (there would be nowhere to go back TO)
  // and not a reason to move the page out from under whoever pressed save.
  const sameScreen = currentView === view && sameNavArg(currentArg, arg);
  const keepPlace = sameScreen && !(opts && opts.top);
  if (_navGoingBack) {
    _navGoingBack = false;
  } else if (currentView && !sameScreen) {
    navTrail.push({ view: currentView, arg: currentArg });
    if (navTrail.length > NAV_TRAIL_MAX) navTrail.shift();
  }
  currentView = view;
  currentArg = arg;
  updateNavButtons();
  // Once the user leaves a scanned-device deep link, drop /scan/<token> from the
  // address bar so a reload returns to the app rather than re-opening the device.
  if (view !== "scan" && location.pathname.startsWith("/scan/")) {
    try { history.replaceState({}, "", "/"); } catch (e) { /* ignore */ }
  }
  $("nav").querySelectorAll(".nav-item").forEach(a =>
    a.classList.toggle("active", a.dataset.view === view));
  updateTabbar();
  // A phone keeps the whole page as one scroll, so a NEW screen must start at
  // its own top instead of halfway down where the last list was left — but a
  // screen refreshing itself is not a new screen.
  if (IS_PHONE && !keepPlace) window.scrollTo(0, 0);
  const v = $("view");
  const putBack = keepPlace ? holdPlace(v) : null;
  v.innerHTML = `<div class="empty">${t("loading")}</div>`;
  if (VIEW_PERMS[view] && !can(VIEW_PERMS[view])) {
    v.innerHTML = `<div class="empty">🚫 ${t("no_permission")}</div>`;
    if (putBack) putBack();
    return;
  }
  try {
    if (view === "dashboard") await viewDashboard(v);
    else if (view === "clients") await viewClients(v);
    else if (view === "leads") await viewLeads(v);
    else if (view === "locations") await viewLocations(v);
    else if (view === "client" || view === "folder") await viewClientFolder(v, arg);
    else if (view === "client-analytics") await viewClientAnalytics(v, arg);
    else if (view === "map") await viewMap(v, arg);
    else if (view === "devices") await viewDevices(v);
    else if (view === "ipm") await viewIpm(v);
    else if (view === "scan") await viewScan(v, arg);
    else if (view === "device-history") await viewDeviceHistory(v, arg);
    else if (view === "my-devices") await viewMyDevices(v);
    else if (view === "schedule" || view === "visits") await viewSchedule(v);
    else if (view === "dispatch") await viewDispatch(v, arg);
    else if (view === "requests") await viewRequests(v);
    else if (view === "myday") await viewMyDay(v, arg);
    else if (view === "reports") await viewReports(v);
    else if (view === "report") await viewReportDoc(v, arg);
    else if (view === "transport") await viewTransport(v);
    else if (view === "visit") await viewVisit(v, arg);
    else if (view === "chemicals") await viewChemicals(v);
    else if (view === "issues") await viewIssues(v);
    else if (view === "cash") await viewCash(v);
    else if (view === "invoices") await viewInvoices(v);
    else if (view === "invoice") await viewInvoice(v, arg);
    else if (view === "finance") await viewFinance(v);
    else if (view === "agents") await viewAgents(v);
    else if (view === "calendar") await viewCalendar(v, arg);
    else if (view === "shifts") await viewShifts(v, arg);
    else if (view === "contracts") await viewContracts(v);
    else if (view === "analytics") await viewAnalytics(v);
    else if (view === "settings") await viewSettings(v);
    else if (view === "backup") await viewBackup(v);
    else if (view === "reportopts") await viewReportOptions(v);
    else if (view === "areas") await viewAreas(v);
    else if (view === "permissions") await viewPermissions(v, arg);
    else if (view === "certificates") await viewCertificates(v);
    else if (view === "search") await viewSearch(v, arg);
    else if (view === "myteam") await viewMyTeam(v, arg);
    else if (view === "availability") await viewAvailability(v);
    else if (view === "fixedposts") await viewFixedPosts(v);
    else if (view === "branchsched") await viewBranchSchedule(v);
    else if (view === "pipeline") await viewPipeline(v);
    else if (view === "marketing") await viewMarketing(v, arg);
    else if (view === "marketing-person") await viewMarketingPerson(v, arg);
  } catch (e) {
    // Kept in the console (and only there): a boundary that swallows the stack
    // is how a render fault stays invisible until somebody reports a blank page.
    console.error("navigate(" + view + ") failed", e && e.stack);
    if (seq !== navSeq) return;      // the user has moved on — leave their screen alone
    const msg = String(e && e.message || "");
    // Offline with nothing cached for this screen is not a failure to report as
    // one — it tells the agent what to do about it.
    v.innerHTML = (msg === "offline_no_data" || msg === "offline")
      ? `<div class="empty">📴 ${t("offline_no_data")}</div>`
      : `<div class="empty">⚠️ ${esc(msg)}</div>`;
  } finally {
    if (putBack) putBack();
  }
}

// Two navigations are "the same screen" when the view and its argument match,
// so re-rendering never piles up a trail of identical steps.
function sameNavArg(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => String(a[k]) === String(b[k]));
}

if ($("nav-back")) $("nav-back").addEventListener("click", navGoBack);
// Refresh re-runs the current screen against the server — no page reload, so
// nothing cached is thrown away and the app never flashes white.
if ($("nav-refresh")) $("nav-refresh").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.classList.remove("spin"); void btn.offsetWidth; btn.classList.add("spin");
  // With new code waiting, ↻ means what the user expects it to mean: reload the
  // app, not just re-fetch this screen's data.
  if (swUpdatePending && !swReloading) { swReloading = true; location.reload(); return; }
  // ↻ includes WHAT I AM ALLOWED TO SEE, not only what is on the screen. If the
  // office has just changed this user's access, syncMyPerms re-runs the screen
  // itself, so there is nothing left to do here.
  if (await syncMyPerms({ force: true })) return;
  if (currentView) await reNavigate();
});

// ====================================================================
// Modal helper
// ====================================================================
// Anything a modal must release when it closes (a camera stream, a timer).
// Set by the dialog itself; always cleared, even if the cleanup throws.
let modalCleanup = null;
function onModalClose(fn) { modalCleanup = fn; }
function openModal(title, bodyHtml, onMount) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = bodyHtml;
  $("modal-overlay").classList.remove("hidden");
  if (onMount) onMount($("modal-body"));
}
function closeModal() {
  const cleanup = modalCleanup;
  modalCleanup = null;
  if (cleanup) { try { cleanup(); } catch (e) { /* never block the close */ } }
  $("modal-overlay").classList.add("hidden"); $("modal-body").innerHTML = "";
  $("modal-body").classList.remove("modal-flush");   // set by the file viewer
  $("modal-title").removeAttribute("translate");     // and so was this
  $("modal-title").classList.remove("notranslate");
}
$("modal-close").addEventListener("click", closeModal);
$("modal-overlay").addEventListener("click", (e) => { if (e.target === $("modal-overlay")) closeModal(); });

// Collapsible sidebar — toggled from the topbar, remembered across sessions.
// On a phone (html.pc-phone, set in index.html) it is a slide-over drawer
// holding the full section list, while the four sections the role works in
// every day sit on the bottom tab bar. Desktop keeps the sticky sidebar.
// APK 1.7 and earlier lay an invisible 56dp long-press hotspot over the screen's
// top-left corner, and Android hands that view every tap landing on it — which
// is why the topbar's ☰ did nothing in the installed app while working fine in
// a phone browser and on desktop. 1.8 removes the overlay and exposes
// PestPrint.appVersion(); anything without it gets the nudge that moves ☰ clear
// of the corner (see .pc-app-hotspot in styles.css).
//
// The corner is 56 DP, which is only 56 CSS px when the page is laid out at the
// device's own width. On the tablet path the app lays the CRM out at 900 px and
// zooms it down, so the same square covers far more of the page — hence the
// width is measured rather than assumed, and measured again after a rotation.
// THE GUARD IS FOR OLD BUILDS ONLY (2026-09-06, his instruction: "the top left
// is the drop menu, make it work in that place, don't move it"). It was briefly
// applied inside EVERY APK, which is why ☰ sat a thumb's width in from the
// corner on 1.8 as well. 1.8 answers appVersion() and no longer lays anything
// over that corner — the long-press that opens the server-URL box only WATCHES
// the touch stream there — so on 1.8 the button belongs in the corner itself
// and works there. Only an app that cannot name itself (1.7 and older, whose
// invisible 56dp View still eats the tap) gets the indent, and that disappears
// the moment the new APK is installed.
const IS_OLD_APP_CORNER = IS_OLD_APP;
function syncCornerGuard() {
  if (!IS_OLD_APP_CORNER) return;
  const dp = (window.screen && window.screen.width) ? window.screen.width : 0;
  const scale = dp > 0 ? Math.max(1, (window.innerWidth || dp) / dp) : 1;
  document.documentElement.style.setProperty("--pc-corner", Math.ceil(56 * scale) + 6 + "px");
}
if (IS_OLD_APP_CORNER) {
  document.documentElement.classList.add("pc-app-hotspot");
  syncCornerGuard();
  window.addEventListener("resize", syncCornerGuard);
  window.addEventListener("orientationchange", syncCornerGuard);
}

// AND TELL HIM THE NEW APP EXISTS. Moving ☰ out of the corner is a patch on a
// build that is already superseded; the cure is APK 1.8, which drops the corner
// view for good. An engineer has no way of knowing a new one was published, so
// an old app says so itself. The link is a plain download — every build since
// 1.7 has a DownloadListener, so Android saves the APK and offers to install it
// over the top (same signing key, nothing is lost). Dismissed for the session
// only: it comes back tomorrow, and disappears for good once 1.8 is installed,
// because 1.8 answers appVersion().
function syncAppUpdateBar() {
  const bar = $("app-update");
  if (!bar) return;
  const show = IS_OLD_APP && sessionStorage.getItem("apkNudgeHidden") !== "1";
  bar.classList.toggle("hidden", !show);
  if (!show) return;
  $("app-update-text").textContent = t("app_update_ready");
  $("app-update-link").textContent = t("app_update_get");
}
if ($("app-update-close")) $("app-update-close").addEventListener("click", () => {
  try { sessionStorage.setItem("apkNudgeHidden", "1"); } catch (e) { /* private mode */ }
  $("app-update").classList.add("hidden");
});
syncAppUpdateBar();
const IS_DRAWER = IS_PHONE;
function applySidebarState() {
  // A phone always starts with the drawer shut — it covers the screen, so a
  // preference saved on a desktop must not open it over the first page.
  if (IS_DRAWER) { $("app").classList.add("nav-collapsed"); syncDrawerLock(); return; }
  const stored = localStorage.getItem("navCollapsed");
  $("app").classList.toggle("nav-collapsed", stored === "1");
}
// Phone only: with the drawer open, freeze the page underneath it. The drawer
// keeps its own scroll (see .sidebar in styles.css); this stops a gesture that
// escapes it from scrolling the dashboard behind. Locking the document loses
// its scroll offset, so put it back when the drawer shuts.
let drawerScrollY = 0;
function syncDrawerLock() {
  if (!IS_DRAWER) return;
  const root = document.documentElement;
  const open = !$("app").classList.contains("nav-collapsed");
  if (open === root.classList.contains("drawer-open")) return;
  if (open) {
    drawerScrollY = window.scrollY;
    root.classList.add("drawer-open");
  } else {
    root.classList.remove("drawer-open");
    window.scrollTo(0, drawerScrollY);
  }
}
if ($("nav-toggle")) $("nav-toggle").addEventListener("click", () => {
  const collapsed = $("app").classList.toggle("nav-collapsed");
  localStorage.setItem("navCollapsed", collapsed ? "1" : "0");
  syncDrawerLock();
});
applySidebarState();
// Phone only: close the drawer after picking a nav item or tapping the dimmed
// page behind it (clicks elsewhere inside the drawer keep it open).
if (IS_DRAWER) document.addEventListener("click", (e) => {
  const app = $("app");
  if (!app || app.classList.contains("nav-collapsed")) return;
  if (e.target.closest("#nav-toggle") || e.target.closest("#tab-more")) return;
  if (e.target.closest(".sidebar") && !e.target.closest(".nav-item")) return;
  app.classList.add("nav-collapsed");
  localStorage.setItem("navCollapsed", "1");
  syncDrawerLock();
});

// ====================================================================
// In-app document viewer
// ====================================================================
// Android's WebView has NO PDF reader. A link to /uploads/<file>.pdf is not
// rendered there — it turns into a download, and the app shell sets no
// DownloadListener, so the download is dropped and tapping "Open" did visibly
// nothing. The same file opened fine on a desktop browser, which has a viewer
// built in. So on a phone (and inside the APK, whatever its screen size) every
// /uploads link is opened in-page instead: images straight into an <img>, PDFs
// through pdf.js. This is deliberately web-side — it reaches the installed app
// with no rebuild.
const PDFJS_SRC = "/js/pdfjs/pdf.min.js";
const PDFJS_WORKER = "/js/pdfjs/pdf.worker.min.js";
// Desktop browsers keep their own (better) native viewer: only take over where
// the platform has none. pdfViewerEnabled is the direct question — Android
// WebView and Chrome for Android both answer false, desktop Chrome and Firefox
// answer true — so it catches the cases the layout classes miss (a tablet, or a
// WebView that measured itself as 0 wide and never got .pc-phone). The strict
// `=== false` matters: an older browser that has never heard of the property
// leaves the desktop path alone.
const VIEW_IN_PAGE = IS_PHONE || IS_APP || navigator.pdfViewerEnabled === false;

// pdf.js is 370 KB + a 1.1 MB worker — far too much for the app shell, so it is
// pulled in the first time someone opens a PDF and cached by the service worker
// from then on (including offline).
let pdfjsReady = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsReady) {
    pdfjsReady = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = PDFJS_SRC;
      s.onload = () => {
        if (!window.pdfjsLib) { reject(new Error("pdfjs")); return; }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        resolve(window.pdfjsLib);
      };
      s.onerror = () => { pdfjsReady = null; reject(new Error("pdfjs")); };
      document.head.appendChild(s);
    });
  }
  return pdfjsReady;
}

// /uploads is per-file authorized. <img> tags ride the scoped pc_upl cookie, but
// a fetch for PDF bytes carries the Bearer token like the rest of the API.
async function fetchUploadBytes(url) {
  const headers = {};
  if (API.token) headers["Authorization"] = "Bearer " + API.token;
  const res = await fetch(url, { headers });
  // A security layer in front of the app (Cloudflare's bot challenge, a captive
  // wifi portal) answers a file request with an HTML page rather than the file.
  // That is not the CRM refusing the file, and saying "you don't have
  // permission" would send someone hunting through the permission matrix for a
  // problem that is not there.
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (res.headers.get("cf-mitigated") || type.indexOf("text/html") === 0) {
    throw new Error(t("file_blocked_by_network"));
  }
  if (!res.ok) throw new Error(res.status === 403 ? t("file_denied") : t("file_open_failed"));
  return res.arrayBuffer();
}

// Open one uploaded file in a modal. The kind comes from the URL, never from the
// label — a link may read "Open" while pointing at a PDF. name is only the title.
//
// AN UPLOADED DOCUMENT IS NEVER TRANSLATED. The CRM does auto-translate some
// things — a visit report a customer reads, the bell — but a file the office
// uploaded is the document itself: an IPM manual, a licence, a safety sheet.
// Chrome (and the WebView the phone app runs in) offers to translate the page
// and rewrites every piece of text it can reach, so anything showing a
// document's own words is marked `translate="no"` / .notranslate and left in
// the language it was written in.
function openFileViewer(url, name) {
  const kind = attachKind(url.split("?")[0]);
  if (kind === "image") {
    openModal(name || t("open"), `<div class="fileview notranslate" translate="no">
      <img src="${esc(url)}" alt="${esc(name || "")}"></div>`);
    flushModalBody();
    return;
  }
  if (kind === "pdf") { openPdfViewer(url, name); return; }
  // Excel and anything else has no in-page renderer. In the APK a download goes
  // nowhere, so say so rather than leaving a dead tap.
  openModal(name || t("open"), `<div class="fileview-msg">
    <p>${esc(t("file_no_preview"))}</p>
    <p class="muted small notranslate" translate="no">${esc(name || "")}</p></div>`);
}

// A document wants the whole sheet on a phone — no dialog padding around it.
// closeModal drops the class again. The dialog's heading carries the file's own
// name, so it is protected from page translation for as long as it does.
function flushModalBody() {
  $("modal-body").classList.add("modal-flush");
  $("modal-title").setAttribute("translate", "no");
  $("modal-title").classList.add("notranslate");
}

async function openPdfViewer(url, name) {
  let cancelled = false;
  openModal(name || t("open"), `<div class="fileview pdfview notranslate" id="pdfview" translate="no">
    <div class="fileview-msg muted">${esc(t("file_loading"))}</div></div>`);
  flushModalBody();
  onModalClose(() => { cancelled = true; });
  const box = $("pdfview");
  try {
    const [pdfjs, data] = await Promise.all([loadPdfJs(), fetchUploadBytes(url)]);
    if (cancelled) return;
    const doc = await pdfjs.getDocument({ data }).promise;
    if (cancelled) return;
    box.innerHTML = "";
    // Render page by page so a long manual shows its first page immediately
    // instead of a spinner, and so closing the modal stops the work.
    for (let n = 1; n <= doc.numPages; n++) {
      if (cancelled) return;
      const page = await doc.getPage(n);
      if (cancelled) return;
      const wrap = document.createElement("div");
      wrap.className = "pdfpage";
      const canvas = document.createElement("canvas");
      wrap.appendChild(canvas);
      const label = document.createElement("div");
      label.className = "pdfpage-n muted small";
      label.textContent = `${t("page")} ${n} / ${doc.numPages}`;
      wrap.appendChild(label);
      box.appendChild(wrap);
      // Fit the page to the modal width, then render at the device's pixel
      // density (capped) so the text is sharp without huge canvases.
      const base = page.getViewport({ scale: 1 });
      const css = Math.max(240, box.clientWidth - 4);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (css / base.width) * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = "100%";
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    }
  } catch (e) {
    if (cancelled) return;
    // Never a dead end: whatever went wrong, say so and offer the phone's own
    // apps as the way through (the app shell hands the file to Android, which
    // opens it in a PDF reader).
    box.innerHTML = `<div class="fileview-msg">
      <p>${esc(e.message || t("file_open_failed"))}</p>
      <p><a class="btn secondary" id="pdf-external" href="${esc(url)}"
            target="_blank" rel="noopener">${esc(t("file_open_outside"))}</a></p></div>`;
    const out = $("pdf-external");
    // The delegated /uploads handler would catch this click and loop straight
    // back into the viewer that just failed, so this one goes out on its own.
    if (out) out.addEventListener("click", (ev) => { ev.stopPropagation(); closeModal(); });
  }
}

// Render a PDF's first page to a PNG File, client-side. Device markers are
// stored as x/y percentages over a picture, so a marker map has to BE a picture
// — but customers hand over their floor plans as PDFs. Converting here means
// they can upload the PDF they have and still drop devices on it.
async function pdfFirstPageToPng(file, maxW = 1600) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  // Upscale small plans a little and cap big ones: enough detail to place a
  // device on, without a 20 MB upload from the field.
  const viewport = page.getViewport({ scale: Math.min(maxW / base.width, 3) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const cx = canvas.getContext("2d");
  cx.fillStyle = "#fff";                       // PDFs are transparent; maps are not
  cx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: cx, viewport }).promise;
  const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
  const name = (file.name || "map").replace(/\.pdf$/i, "") + ".png";
  return new File([blob], name, { type: "image/png" });
}

// One delegated handler covers every /uploads link in the app — the IPM shelf,
// report attachments, SDS/label files, site maps — with no change at the call
// sites.
if (VIEW_IN_PAGE) document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if (!href.startsWith("/uploads/")) return;
  // A printable document rendered into its own window is not ours to intercept.
  if (a.ownerDocument !== document) return;
  e.preventDefault();
  // Title, in order of usefulness: an explicit name from the call site, the
  // download filename, the link's own text when it looks like a filename
  // (attachment lists show one), else the stored name — a bare uuid.
  const text = (a.textContent || "").trim();
  openFileViewer(href, a.dataset.fileName || a.getAttribute("download") ||
    (text.indexOf(".") !== -1 ? text : "") || decodeURIComponent(href.split("/").pop()));
});

function field(label, name, opts = {}) {
  const { type = "text", value = "", cls = "", options, textarea, attrs = "" } = opts;
  let input;
  if (options) {
    input = `<select name="${name}">${options.map(o =>
      `<option value="${esc(o.v)}" ${String(o.v) === String(value) ? "selected" : ""}>${esc(o.l)}</option>`).join("")}</select>`;
  } else if (textarea) {
    input = `<textarea name="${name}">${esc(value)}</textarea>`;
  } else {
    input = `<input type="${type}" name="${name}" value="${esc(value)}" ${attrs}/>`;
  }
  return `<div class="field ${cls}"><label>${esc(label)}</label>${input}</div>`;
}

// ---- 24-hour time entry ----------------------------------------------------
// <input type="time"> renders in the browser's locale, which puts an AM/PM
// picker in front of anyone whose device is set to 12-hour — there is no
// attribute to force otherwise. These are plain text fields instead, so the
// roster is always entered and shown as 24-hour.
const HHMM_ATTRS = 'class="hhmm" inputmode="numeric" maxlength="5" placeholder="HH:MM" autocomplete="off"';

// "17" / "1700" / "17.00" / "5:30" -> "17:00" / "05:30". "" when unusable.
function normHHMM(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  const m = /^(\d{1,2})\s*[:.\s]?\s*(\d{2})?$/.exec(s);
  if (!m) return "";
  let h = parseInt(m[1], 10);
  const min = m[2] === undefined ? 0 : parseInt(m[2], 10);
  if (h > 24 || min > 59) return "";
  if (h === 24) h = 0;                       // 24:00 is midnight
  return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
}

// A date box plus a 24-hour time box, replacing <input type="datetime-local">
// (whose time half also follows the device locale). `value` may be a stored
// "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM".
function dateTimeFields(label, name, value) {
  const s = String(value || "").replace("T", " ");
  return field(label, name + "_date", { type: "date", value: s.slice(0, 10) })
    + field(t("time_lbl"), name + "_time", { value: s.slice(11, 16), attrs: HHMM_ATTRS });
}

// Read a dateTimeFields pair back as "YYYY-MM-DDTHH:MM", and drop the two
// halves from the form payload. Returns "" when no date was picked.
function readDateTime(root, data, name) {
  const dateEl = root.querySelector(`[name=${name}_date]`);
  const timeEl = root.querySelector(`[name=${name}_time]`);
  delete data[name + "_date"];
  delete data[name + "_time"];
  if (!dateEl || !dateEl.value) return "";
  return dateEl.value + "T" + (normHHMM(timeEl && timeEl.value) || "00:00");
}

// Tidy every .hhmm field in `root` as it is left, and flag anything unusable.
function wireTimeInputs(root, onChange) {
  root.querySelectorAll("input.hhmm").forEach(el => {
    const tidy = () => {
      const norm = normHHMM(el.value);
      if (norm) el.value = norm;
      el.classList.toggle("bad", !!el.value && !norm);
      if (onChange) onChange(el);
    };
    el.addEventListener("blur", tidy);
    el.addEventListener("change", tidy);
    if (onChange) el.addEventListener("input", () => onChange(el));
  });
}
function formData(root) {
  const d = {};
  root.querySelectorAll("[name]").forEach(el => { d[el.name] = el.value; });
  return d;
}
// Fill a <select name="site_id"> with the client's locations. Sets
// dataset.hasSites="1" when the client has any (so the form can require one).
// firstLabel is the placeholder shown for the empty option.
async function loadSiteOptions(clientId, selectEl, selected, firstLabel) {
  if (!selectEl) return;
  if (!clientId) { selectEl.innerHTML = `<option value="">${t("none")}</option>`; selectEl.dataset.hasSites = ""; return; }
  selectEl.innerHTML = `<option value="">${t("loading")}</option>`;
  let sites = [];
  try { const c = await API.get("/clients/" + clientId); sites = c.sites || []; } catch (e) {}
  selectEl.dataset.hasSites = sites.length ? "1" : "";
  const ph = firstLabel || (sites.length ? t("select_location") : t("none"));
  const opts = [{ v: "", l: ph, n: "" }].concat(
    sites.map(s => ({ v: s.id, l: siteLabel(s), n: s.name })));
  // The plain branch name rides along on the option: a saved visit answers with
  // a site_id and the row needs the name, and this is the name the office just
  // picked rather than the one the row used to show.
  selectEl.innerHTML = opts.map(o =>
    `<option value="${esc(o.v)}" data-name="${esc(o.n || "")}" ${
      String(o.v) === String(selected || "") ? "selected" : ""}>${esc(o.l)}</option>`).join("");
}
// Fill a <select name="contract_id"> with that client's contracts. Booking a
// visit or an invoice against the deal is what makes profit per contract real —
// unlinked work lands in the 'no contract' line instead of on any deal.
async function loadContractOptions(clientId, selectEl, selected) {
  if (!selectEl) return;
  if (!clientId) { selectEl.innerHTML = `<option value="">${t("ct_none")}</option>`; return; }
  selectEl.innerHTML = `<option value="">${t("loading")}</option>`;
  let list = [];
  try { list = await API.get("/contracts?client=" + clientId); } catch (e) {}
  const opts = [{ v: "", l: t("ct_none") }].concat(list.map(c => ({
    v: c.id,
    l: `#${c.id} · ${t("freq_" + c.frequency)} · ${money(c.price)}`
       + (c.service_en ? ` · ${localized(c, "service")}` : ""),
  })));
  selectEl.innerHTML = opts.map(o =>
    `<option value="${esc(o.v)}" ${String(o.v) === String(selected || "") ? "selected" : ""}>${esc(o.l)}</option>`).join("");
}
function statusBadge(s) { return `<span class="badge b-${s}">${t(statusKey(s))}</span>`; }
function statusKey(s) {
  const map = { scheduled: "st_scheduled", in_progress: "st_in_progress", completed: "st_completed",
    cancelled: "st_cancelled", draft: "inv_draft", sent: "inv_sent", paid: "inv_paid",
    overdue: "inv_overdue", accepted: "accepted", declined: "declined", active: "active",
    inactive: "inactive" };
  return map[s] || s;
}

// ---- switched off ----------------------------------------------------------
// A customer or a branch that is no longer serviced stays in the CRM — its
// visits, reports and invoices are the company's own history. It is switched
// OFF instead: out of the automatic roster and off every "this needs an area"
// list, still findable, one press from being switched back on.
function isOff(x) { return !!x && x.status === "inactive"; }
// How a switched-off customer reads in a picker. Every dropdown still offers
// them — a closed customer can still be invoiced for work already done — but
// nobody picks one by accident.
function clientLabel(c) {
  return localized(c, "name") + (isOff(c) ? " · " + t("inactive") : "");
}
function siteLabel(s) { return s.name + (isOff(s) ? " · " + t("inactive") : ""); }

// ---- PUTTING ONE SAVED ROW BACK, INSTEAD OF THE WHOLE SCREEN --------------
// The audit of 2026-08-25 timed a branch edit at 835 ms on a phone: the PUT,
// then a 241 KB re-read of every branch in the book, then the screen rebuilt —
// to change one row. These two helpers are how a screen puts the SAVED row back
// in place instead. Nothing here is optimistic: every caller runs them only
// after the server has confirmed the write, so a save that fails leaves the
// screen exactly as it was.
// The company list every dropdown reads. After an edit it is 19 KB to re-read
// and one row to correct, so it is corrected. Only for an EDIT: a company that
// has just been CREATED is re-read, because the list carries figures the save
// does not return and a half-built row in the cache is worse than a round trip.
// The chemical list the issue and usage pickers read. Both writes answer with
// the whole chemical row, so the cached copy is corrected from it.
function patchChemicalCache(saved) {
  if (!saved || !saved.id || !Array.isArray(cache.chemicals)) return;
  const i = cache.chemicals.findIndex(c => String(c.id) === String(saved.id));
  if (i >= 0) cache.chemicals[i] = Object.assign({}, cache.chemicals[i], saved);
  else cache.chemicals.push(saved);
}
function patchClientCache(saved) {
  if (!saved || !Array.isArray(cache.clients)) return;
  const i = cache.clients.findIndex(c => String(c.id) === String(saved.id));
  if (i >= 0) cache.clients[i] = Object.assign({}, cache.clients[i], saved);
}
function swapRow(tr, html, rewire) {
  if (!tr) return null;
  const box = document.createElement("tbody");
  box.innerHTML = String(html).trim();
  const fresh = box.firstElementChild;
  if (!fresh) return null;
  tr.replaceWith(fresh);
  if (rewire) rewire(fresh);
  return fresh;
}
// A branch's AREA NAME is a join the save does not return, so re-reading it
// from the area list the page already holds is the difference between a
// correct row and a row still showing the area it used to be in. When the area
// did not change, the name the row already had is the right one — an inactive
// area is not in every user's list, and inventing "—" for it would be a lie.
function withAreaName(saved, prev) {
  const s = Object.assign({}, prev || {}, saved);
  if (prev && String(prev.area_id || "") === String(saved.area_id || "")) return s;
  const a = (cache.areas || []).find(x => String(x.id) === String(saved.area_id || ""));
  s.area_en = a ? a.name_en : null;
  s.area_ar = a ? a.name_ar : null;
  return s;
}
// The button that switches one on or off, for a table row.
function statusToggleBtn(x, kind) {
  return isOff(x)
    ? `<button class="link-btn sm" data-turn-on="${x.id}" data-kind="${kind}">${t("reactivate")}</button>`
    : `<button class="link-btn sm" data-turn-off="${x.id}" data-kind="${kind}">${t("deactivate")}</button>`;
}
// Switching one OFF asks one question the office cannot answer from memory:
// what is already booked. The dialog says the number and offers to call those
// visits off — a branch shut for a month keeps its diary, a customer who has
// left does not. Switching one back ON is not destructive and just asks.
// kind is "client" or "site"; `after` reloads whatever screen called it.
function deactivateDialog(kind, entity, after) {
  const n = +(entity.upcoming_visits || 0);
  const name = kind === "client" ? localized(entity, "name") : entity.name;
  openModal(t("deactivate") + " — " + name, `<form id="dof">
    <p>${t(kind === "client" ? "client_deactivate_confirm" : "branch_deactivate_confirm")}</p>
    ${n ? `<div class="field full"><label><input type="checkbox" id="dof-cancel">
      ${t("also_cancel_visits").replace("{n}", n)}</label>
      <div class="muted small">${t("also_cancel_visits_hint")}</div></div>`
      : `<p class="muted small">${t("no_upcoming_visits")}</p>`}
    <div class="form-actions"><button type="button" class="btn secondary" id="dof-x">${t("cancel")}</button>
    <button class="btn danger" type="submit">${t("deactivate")}</button></div></form>`, (root) => {
    $("dof-x").addEventListener("click", closeModal);
    root.querySelector("#dof").addEventListener("submit", async (e) => {
      e.preventDefault();
      const cancelVisits = !!($("dof-cancel") && $("dof-cancel").checked);
      try {
        const r = await API.post(`/${kind === "client" ? "clients" : "sites"}/${entity.id}/status`,
          { status: "inactive", cancel_visits: cancelVisits ? "1" : "0" });
        if (handledOffline(r)) return;
        closeModal();
        toast(r.cancelled_visits
          ? t("visits_cancelled").replace("{n}", r.cancelled_visits) : t("saved"));
        if (can("clients.view")) { try { cache.clients = await API.get("/clients"); } catch (err) {} }
        after && after();
      } catch (err) { alert(err.message); }
    });
  });
}
async function reactivate(kind, id, after) {
  try {
    const r = await API.post(`/${kind === "client" ? "clients" : "sites"}/${id}/status`,
      { status: "active" });
    if (handledOffline(r)) return;
    toast(t("saved"));
    if (can("clients.view")) { try { cache.clients = await API.get("/clients"); } catch (e) {} }
    after && after();
  } catch (err) { alert(err.message); }
}
// Wires every toggle button on a screen at once. `find` turns an id into the
// row's own object (it carries the upcoming-visit count the dialog needs).
function wireStatusToggles(v, find, after) {
  v.querySelectorAll("[data-turn-off]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const x = find(b.dataset.kind, b.dataset.turnOff);
    if (x) deactivateDialog(b.dataset.kind, x, after);
  }));
  v.querySelectorAll("[data-turn-on]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    reactivate(b.dataset.kind, b.dataset.turnOn, after);
  }));
}

// Human label for a required report field returned in a report_incomplete error.
function reportFieldLabel(key) {
  const map = { signature: "signature", customer_signature: "customer_sig",
                technician_signature: "technician_sig" };
  return t(map[key] || key);
}

// ====================================================================
// Dashboard
// ====================================================================
async function viewDashboard(v) {
  const d = await API.get("/dashboard");
  let cards = "";
  const card = (val, label, icon, cls = "c-green") =>
    `<div class="stat-card ${cls}"><div class="sc-ic">${icon}</div><div><div class="v">${val}</div><div class="l">${label}</div></div></div>`;
  if (d.role === "client") {
    cards = card(d.upcoming_visits, t("dash_upcoming"), "🗓️", "c-blue") +
      card(d.completed_visits, t("dash_completed"), "✅", "c-green") +
      card(d.open_invoices, t("dash_open_invoices"), "🧾", "c-amber") +
      card(money(d.outstanding), t("dash_outstanding"), "💰", "danger");
  } else if (d.role === "agent") {
    // Field agent: their own workload only — no company totals, no money.
    cards = card(d.visits_today, t("dash_visits_today"), "📅", "c-blue") +
      card(d.my_visits, t("dash_my_visits"), "📋", "c-purple") +
      card(d.in_progress, t("dash_in_progress"), "🚧", d.in_progress > 0 ? "warn" : "c-teal") +
      card(d.completed_month, t("dash_completed_month"), "✅", "c-green") +
      card(d.reports_due, t("dash_reports_due"), "📝", d.reports_due > 0 ? "danger" : "c-green");
  } else if (SUPERVISOR_ROLES.includes(d.role)) {
    // Supervisor: their own workload first — they work jobs too — then what
    // they answer for, which is a patch for an area manager and a crew for a
    // team leader. No money: that is the office's screen, not theirs.
    const tl = d.role === "team_leader";
    cards = card(d.visits_today, t("dash_visits_today"), "📅", "c-blue") +
      card(d.reports_due, t("dash_reports_due"), "📝", d.reports_due > 0 ? "danger" : "c-green") +
      card(d.team_today, t(tl ? "dash_team_size" : "dash_team_today"), "👷", "c-teal") +
      card(d.sup_visits_today, t(tl ? "dash_team_visits" : "dash_area_visits"), "📍", "c-purple") +
      card(d.sup_open, t(tl ? "dash_team_open" : "dash_area_open"), "🗓️", "c-blue") +
      card(d.sup_reports_due, t(tl ? "dash_team_reports_due" : "dash_area_reports_due"), "📋",
           d.sup_reports_due > 0 ? "warn" : "c-green") +
      // Traps overdue for a scan are a question about places, so only the role
      // that answers for places is shown it.
      (tl ? "" : card(d.sup_devices_stale, t("dash_area_stale"), "🐭",
           d.sup_devices_stale > 0 ? "warn" : "c-green"));
  } else {
    cards = card(d.clients, t("dash_clients"), "🏢", "c-blue") +
      card(d.agents, t("dash_agents"), "👷", "c-teal") +
      card(d.visits_today, t("dash_visits_today"), "📅", "c-green") +
      card(d.scheduled, t("dash_scheduled"), "🗓️", "c-purple") +
      card(d.low_stock, t("dash_low_stock"), "🧪", d.low_stock > 0 ? "warn" : "c-green") +
      card(d.expiring || 0, t("dash_expiring"), "⌛", d.expiring > 0 ? "warn" : "c-green") +
      card(money(d.outstanding), t("dash_outstanding"), "💰", "danger");
    if (d.my_visits !== undefined) cards += card(d.my_visits, t("dash_my_visits"), "📋", "c-blue");
  }
  const isClient = d.role === "client";
  // A supervisor reads like an agent on this screen: own workload up top, their
  // own visit list below, plus the strip a plain engineer never sees — the
  // areas they hold, or the crew they lead.
  const isSup = SUPERVISOR_ROLES.includes(d.role);
  const isAgent = d.role === "agent" || isSup;
  const areaStrip = d.role === "team_leader"
    ? `<div class="lead-areas">👷 ${t("my_team_standing")}</div>`
    : ((d.role === "area_manager" && (d.areas || []).length)
      ? `<div class="lead-areas">📌 ${t("my_areas")}: ${d.areas.map(a => esc(localized(a, "name"))).join(" · ")}</div>`
      : (d.role === "area_manager" ? `<div class="lead-areas warn-line">⚠️ ${t("leader_no_areas")}</div>` : ""));
  v.innerHTML = `<div class="page-head"><h2>${t("welcome")}, ${esc(API.user.full_name)}</h2>
    ${isClient && can("requests.create") ? `<button class="btn" id="dash-req">+ ${t("request_visit")}</button>` : ""}
    ${isAgent ? `<button class="btn" id="dash-myday">🧭 ${t("nav_myday")}</button>` : ""}
    ${isSup ? `<button class="btn secondary" id="dash-myteam">👷 ${t("nav_myteam")}</button>` : ""}</div>
    ${areaStrip}
    <div class="cards">${cards}</div>
    ${d.cockpit ? cockpitSection(d.cockpit) : ""}
    ${(!isClient && !isAgent && d.devices && d.devices.total) ? deviceDashStrip(d.devices) : ""}
    ${isClient ? `<div id="dash-sla"></div>` : ""}
    <div class="panel"><h3>${t(isAgent ? "my_visits_title" : "nav_schedule")}</h3>
      <div id="dash-visits">${t("loading")}</div></div>`;
  if ($("dash-req")) $("dash-req").addEventListener("click", requestForm);
  if ($("dash-myday")) $("dash-myday").addEventListener("click", () => navigate("myday"));
  if ($("dash-myteam")) $("dash-myteam").addEventListener("click", () => navigate("myteam"));
  if (isClient) loadSlaStrip("dash-sla");
  // upcoming visits table
  const visits = await API.get("/visits");
  const vlist = Array.isArray(visits) ? visits : (visits.items || []);
  // A customer's first question is "when are you coming?", so for them the
  // next booked visit is stated in words above the table rather than being
  // something to work out from a list sorted by date.
  if (isClient) {
    const now = new Date();
    const next = vlist
      .filter(v => ["scheduled", "in_progress"].includes(v.status) && v.scheduled_start
                   && new Date(v.scheduled_start) >= new Date(now.toDateString()))
      .sort((a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start))[0];
    if (!$("dash-visits")) return;      // the dashboard is no longer on screen
    $("dash-visits").insertAdjacentHTML("beforebegin", next
      ? `<div class="next-visit">🗓️ ${t("next_visit_is")
          .replace("{d}", esc(fmtDateTime(next.scheduled_start)))
          .replace("{s}", esc(next.site_name || localized(next, "client") || ""))}</div>`
      : `<div class="muted small">${t("no_visit_booked")}</div>`);
  }
  if (!$("dash-visits")) return;
  $("dash-visits").innerHTML = visitsTable(vlist.slice(0, 8));
  wireVisitRows($("dash-visits"));
}

// QR device fleet health strip on the staff dashboard: fleet size, this
// month's service coverage, devices needing service, activity detections.
function deviceDashStrip(dv) {
  const card = (val, label, icon, cls) =>
    `<div class="stat-card ${cls}"><div class="sc-ic">${icon}</div><div><div class="v">${val}</div><div class="l">${label}</div></div></div>`;
  return `<div class="section-title" style="margin-top:8px"><h3>🏷️ ${t("nav_devices")}</h3></div>
    <div class="cards">
      ${card(dv.total, t("total_devices"), "📍", "c-blue")}
      ${card(dv.coverage != null ? dv.coverage + "%" : "—", t("coverage_month"), "✅", (dv.coverage != null && dv.coverage < 60) ? "warn" : "c-green")}
      ${card(dv.stale || 0, t("overdue_devices"), "⏰", dv.stale > 0 ? "danger" : "c-green")}
      ${card(dv.needs_service, t("mst_needs_service"), "🛠️", dv.needs_service > 0 ? "warn" : "c-green")}
      ${card(dv.activity_month, t("activity_detections"), "🐭", dv.activity_month > 0 ? "danger" : "c-green")}</div>`;
}

// Owner cockpit: revenue / overdue billing / SLA health KPI strip + a
// per-technician utilization panel for the current month.
function cockpitSection(c) {
  const prev = Number(c.revenue_prev) || 0, cur = Number(c.revenue_month) || 0;
  const delta = cur - prev;
  const pct = prev ? Math.round(delta * 100 / prev) : (cur ? 100 : 0);
  const arrow = delta > 0 ? "▲" : (delta < 0 ? "▼" : "—");
  const trendCls = delta > 0 ? "up" : (delta < 0 ? "down" : "");
  const kpi = (val, label, icon, cls, extra = "") =>
    `<div class="stat-card ${cls}"><div class="sc-ic">${icon}</div><div>
      <div class="v">${val}</div><div class="l">${label}</div>${extra}</div></div>`;
  const cards =
    kpi(money(c.revenue_month), t("dash_revenue_month"), "💵", "c-green",
        `<div class="sc-trend ${trendCls}">${arrow} ${Math.abs(pct)}% ${t("vs_last_month")}</div>`) +
    kpi(c.overdue_invoices, t("dash_overdue_invoices"), "⏰",
        c.overdue_invoices > 0 ? "danger" : "c-green",
        `<div class="sc-trend">${money(c.overdue_amount)}</div>`) +
    kpi(c.sla.overdue, t("dash_sla_overdue"), "🚨", c.sla.overdue > 0 ? "danger" : "c-green") +
    kpi(c.sla.due_soon, t("dash_sla_due_soon"), "🕒", c.sla.due_soon > 0 ? "warn" : "c-green");
  const u = c.utilization || [];
  const rows = u.length ? u.map(a => `<tr>
      <td>${esc(a.name)}</td>
      <td class="num">${a.completed}/${a.total}</td>
      <td><div class="util-bar"><span style="width:${a.rate}%"></span></div></td>
      <td class="num">${a.rate}%</td>
      <td class="num">${a.rating != null ? `⭐ ${a.rating}` : "—"}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">${t("none")}</td></tr>`;
  return `<div class="cards cockpit-kpis">${cards}</div>
    <div class="panel"><h3>${t("tech_utilization")} <span class="muted">· ${t("this_month")}</span></h3>
      <table class="util-table"><thead><tr>
        <th>${t("nav_agents")}</th><th class="num">${t("col_completed_assigned")}</th>
        <th>${t("rate")}</th><th class="num">%</th><th class="num">${t("avg_rating")}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

// ====================================================================
// Leads (sales pipeline — website booking form + manual entry)
// ====================================================================
const LEAD_STATUSES = ["new", "contacted", "quoted", "won", "lost"];
let leadFilter = "";

async function viewLeads(v) {
  const d = await API.get("/leads" + (leadFilter ? `?status=${leadFilter}` : ""));
  const rows = d.items || [];
  const counts = d.counts || {};
  const total = LEAD_STATUSES.reduce((s, k) => s + (counts[k] || 0), 0);
  const chip = (k, label, n) => `<button class="btn ${leadFilter === k ? "" : "secondary"} sm" data-lf="${k}">
    ${label} <span class="badge b-${k || "draft"}">${n}</span></button>`;
  v.innerHTML = `<div class="page-head"><h2>${t("nav_leads")}</h2>
      ${can("leads.create") ? `<button class="btn" id="add-lead">+ ${t("new_lead")}</button>` : ""}</div>
    <div class="toolbar" style="flex-wrap:wrap">${chip("", t("all"), total)}
      ${LEAD_STATUSES.map(s => chip(s, t("ld_" + s), counts[s] || 0)).join(" ")}</div>
    <div class="panel"><table><thead><tr>
      <th>${t("date")}</th><th>${t("name_en")}</th><th>${t("contact_person")}</th>
      <th>${t("preferred_date")}</th><th>${t("lead_source")}</th><th>${t("status")}</th>
      <th>${t("actions")}</th></tr></thead>
      <tbody>${rows.map(l => `<tr>
        <td>${fmtDate(l.created_at)}</td>
        <td><strong>${esc(l.name)}</strong>${l.company ? `<div class="muted small">${esc(l.company)}</div>` : ""}
          ${l.message ? `<div class="muted small">💬 ${esc(l.message.slice(0, 120))}</div>` : ""}</td>
        <td>${l.phone ? `<a href="tel:${esc(l.phone)}" dir="ltr">${esc(l.phone)}</a>` : ""}
          ${l.email ? `<div class="muted small">${esc(l.email)}</div>` : ""}
          ${l.sector ? `<div class="muted small">${esc(l.sector)}</div>` : ""}</td>
        <td>${l.preferred_date ? fmtDate(l.preferred_date) : "—"}</td>
        <td><span class="badge b-${l.source === "website" ? "sent" : "draft"}">${t(l.source === "website" ? "lead_web" : "lead_manual")}</span></td>
        <td>${can("leads.edit") ? `<select class="ld-st" data-id="${l.id}">
            ${LEAD_STATUSES.map(s => `<option value="${s}" ${s === l.status ? "selected" : ""}>${t("ld_" + s)}</option>`).join("")}</select>`
          : `<span class="badge b-${l.status}">${t("ld_" + l.status)}</span>`}
          ${l.client_id ? `<div class="muted small">→ ${esc(localized(l, "client") || "")}</div>` : ""}</td>
        <td>${can("leads.edit") ? `<button class="link-btn sm" data-ed="${l.id}">✏️</button>` : ""}
          ${(!l.client_id && can("leads.edit") && can("clients.create")) ? `<button class="link-btn sm" data-cv="${l.id}" title="${t("convert_to_client")}">➡🏢</button>` : ""}
          ${can("leads.delete") ? `<button class="link-btn danger sm" data-rm="${l.id}">🗑</button>` : ""}</td>
      </tr>`).join("") || `<tr><td colspan="7" class="empty">${t("leads_empty")}</td></tr>`}</tbody></table></div>`;
  v.querySelectorAll("[data-lf]").forEach(b => b.addEventListener("click", () => {
    leadFilter = b.dataset.lf; navigate("leads");
  }));
  if ($("add-lead")) $("add-lead").addEventListener("click", () => leadForm());
  v.querySelectorAll(".ld-st").forEach(s => s.addEventListener("change", async () => {
    try { await API.put(`/leads/${s.dataset.id}`, { status: s.value }); toast(t("saved")); navigate("leads"); }
    catch (err) { alert(err.message); }
  }));
  v.querySelectorAll("[data-ed]").forEach(b => b.addEventListener("click", () =>
    leadForm(rows.find(l => l.id == b.dataset.ed))));
  v.querySelectorAll("[data-cv]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("convert_lead_confirm"))) return;
    try { const c = await API.post(`/leads/${b.dataset.cv}/convert`); if (handledOffline(c)) return;
      toast(t("lead_converted")); navigate("client", { id: c.id }); }
    catch (err) { alert(err.message); }
  }));
  v.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("confirm_delete"))) return;
    try { const r = await API.del(`/leads/${b.dataset.rm}`); if (handledOffline(r, b.closest("tr"))) return; navigate("leads"); }
    catch (err) { alert(err.message); }
  }));
}

function leadForm(l) {
  const isEdit = !!l; l = l || {};
  // Who found this customer. It decides who a contract's commission follows
  // later, so it is worth naming rather than leaving to "whoever typed last".
  const ownerOpts = soldByOptions({ sold_by: l.handled_by, sold_by_name: l.handled_by_name })
    .filter(o => o.v !== "");
  const showOwner = isEdit && can("targets.view") && ownerOpts.length > 0;
  openModal(isEdit ? t("edit") : t("new_lead"), `<form id="ldf"><div class="form-grid">
    ${field(t("contact_person"), "name", { value: l.name, required: true })}
    ${field(t("clients_title"), "company", { value: l.company })}
    ${field(t("phone"), "phone", { value: l.phone })}
    ${field(t("email"), "email", { value: l.email })}
    ${field(t("sector"), "sector", { value: l.sector })}
    ${field(t("preferred_date"), "preferred_date", { type: "date", value: (l.preferred_date || "").slice(0, 10) })}
    ${field(t("lead_note"), "note", { value: l.note })}
    ${showOwner ? field(t("lead_owner"), "handled_by",
        { options: ownerOpts, value: l.handled_by || "" }) : ""}
    ${showOwner ? `<div class="field full muted small">${t("lead_owner_hint")}</div>` : ""}
    <div class="full"><label>${t("lead_message")}</label><textarea name="message" rows="3">${esc(l.message || "")}</textarea></div>
    </div><div class="form-actions"><button type="button" class="btn secondary" id="ldf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("ldf-x").addEventListener("click", closeModal);
    root.querySelector("#ldf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      try {
        const saved = isEdit ? await API.put(`/leads/${l.id}`, d) : await API.post("/leads", d);
        if (handledOffline(saved)) return;
        closeModal(); toast(t("saved")); navigate("leads");
      } catch (err) { alert(err.message); }
    });
  });
}

// ====================================================================
// Clients list
// ====================================================================
async function viewClients(v) {
  // Switched-off customers are listed with everybody else by default — that is
  // how one is found again to be switched back on — and can be filtered to
  // either side when the office wants only the book it is still working.
  const stOpts = [["", t("all_statuses")], ["active", t("active")], ["inactive", t("inactive")]];
  v.innerHTML = `<div class="page-head"><h2>${t("clients_title")}</h2>
    <div style="display:flex;gap:8px;align-items:center">
      <select id="cl-status">${stOpts.map(([val, lbl]) =>
        `<option value="${val}">${esc(lbl)}</option>`).join("")}</select>
      ${can("clients.create") ? `<button class="btn" id="add-client">+ ${t("new_client")}</button>` : ""}</div></div>
    <div class="panel" id="clients-list">${t("loading")}</div>`;
  if ($("add-client")) $("add-client").addEventListener("click", () => clientForm());
  const render = async (page) => {
    const st = $("cl-status") ? $("cl-status").value : "";
    const d = await API.get(`/clients?page=${page}&limit=${PAGE_SIZE}` + (st ? `&status=${st}` : ""));
    const rows = d.items;
    $("clients-list").innerHTML =
      `<table><thead><tr><th>${t("company_name_en")}</th><th>${t("contact_person")}</th>
        <th>${t("phone")}</th><th>${t("city")}</th><th>${t("status")}</th></tr></thead>
      <tbody>${rows.map(c => `<tr class="clickable${isOff(c) ? " row-off" : ""}" data-id="${c.id}">
        <td><strong>${esc(localized(c, "name"))}</strong></td>
        <td>${esc(c.contact_person)}</td><td>${esc(c.phone)}</td>
        <td>${esc(c.city)}</td><td>${statusBadge(c.status)}</td></tr>`).join("") ||
        `<tr><td colspan="5" class="empty">${t("none")}</td></tr>`}</tbody></table>` + pagerHTML(d);
    $("clients-list").querySelectorAll("tr[data-id]").forEach(tr =>
      tr.addEventListener("click", () => navigate("client", { id: tr.dataset.id })));
    wirePager($("clients-list"), d, render);
  };
  if ($("cl-status")) $("cl-status").addEventListener("change", () => render(1));
  render(1);
}

function clientForm(c, after) {
  const isEdit = !!c; c = c || {};
  openModal(isEdit ? t("edit") : t("new_client"), `<form id="cf"><div class="form-grid">
    ${field(t("company_name_en"), "name_en", { value: c.name_en })}
    ${field(t("company_name_ar"), "name_ar", { value: c.name_ar })}
    ${field(t("contact_person"), "contact_person", { value: c.contact_person })}
    ${field(t("phone"), "phone", { value: c.phone })}
    ${field(t("email"), "email", { value: c.email })}
    ${field(t("city"), "city", { value: c.city })}
    ${field(t("address_en"), "address_en", { value: c.address_en, cls: "full" })}
    ${field(t("address_ar"), "address_ar", { value: c.address_ar, cls: "full" })}
    ${field(t("notes"), "notes", { value: c.notes, textarea: true, cls: "full" })}
    ${can("finance.view") || can("invoices.edit") ? `<div class="field full">
      <label><input type="checkbox" id="cf-dunning" ${(isEdit ? c.dunning !== 0 : true) ? "checked" : ""}>
        ${t("client_dunning")}</label>
      <div class="muted small">${t("client_dunning_hint")}</div></div>` : ""}
    </div><div class="form-actions"><button type="button" class="btn secondary" id="cf-cancel">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("cf-cancel").addEventListener("click", closeModal);
    root.querySelector("#cf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      // Checkboxes aren't values — formData() only reads .value.
      if ($("cf-dunning")) d.dunning = $("cf-dunning").checked ? "1" : "0";
      try {
        const saved = isEdit ? await API.put("/clients/" + c.id, d) : await API.post("/clients", d);
        if (handledOffline(saved)) return;
        closeModal(); toast(t("saved"));
        if (isEdit) {
          patchClientCache(saved);
          if (after) { after(saved); return; }
          navigate("client", { id: saved.id });
          return;
        }
        cache.clients = await API.get("/clients");
        navigate("client", { id: saved.id });
      } catch (err) { alert(err.message); }
    });
  });
}

// ====================================================================
// Client folder (detail)
// ====================================================================
// The six facts in the company panel. Its own builder so that editing the
// company redraws THE PANEL from what was saved, instead of the folder.
// One branch row of the company folder, so a save can rebuild just that row.
function folderSiteRowHTML(s) {
  return `<tr data-site="${s.id}"${isOff(s) ? ` class="row-off"` : ""}><td>${esc(s.name)}</td><td>${esc(s.address)}</td><td>${esc(areaOf(s) || s.area || "—")}</td>
        <td>${branchScheduleHTML(s)}</td>
        <td>${statusBadge(s.status || "active")}</td>
        <td class="row-actions"><button class="link-btn sm" data-editsite="${s.id}">✏️ ${t("edit")}</button>
        ${statusToggleBtn(s, "site")}
        <button class="link-btn danger sm" data-rmsite="${s.id}">${t("delete")}</button></td></tr>`;
}

function companyKvHTML(c) {
  return `
          <div>${t("contact_person")}</div><div>${esc(c.contact_person) || "—"}</div>
          <div>${t("phone")}</div><div>${esc(c.phone) || "—"}</div>
          <div>${t("email")}</div><div>${esc(c.email) || "—"}</div>
          <div>${t("city")}</div><div>${esc(c.city) || "—"}</div>
          <div>${t("address_en")}</div><div>${esc(localized(c, "address")) || "—"}</div>
          <div>${t("notes")}</div><div>${esc(c.notes) || "—"}</div>`;
}

async function viewClientFolder(v, arg) {
  const id = (arg && arg.id) || (role() === "client" ? API.user.client_id : null);
  if (!id) { v.innerHTML = `<div class="empty">${t("none")}</div>`; return; }
  const c = await API.get("/clients/" + id);
  const fin = c.finance;
  v.innerHTML = `
    ${role() !== "client" ? `<div class="breadcrumb" id="bc">← ${t("clients_title")}</div>` : ""}
    <div class="page-head"><h2 id="cf-title">${esc(localized(c, "name"))}
      ${isOff(c) ? ` ${statusBadge("inactive")}` : ""}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn sm" id="client-analytics-btn">📊 ${t("view_analytics")}</button>
        ${can("clients.edit") ? `<button class="btn secondary sm" id="edit-client">${t("edit")}</button>` : ""}
        ${can("clients.edit") ? `<button class="btn ${isOff(c) ? "" : "danger "}sm" id="client-status-btn">${
          t(isOff(c) ? "reactivate" : "deactivate")}</button>` : ""}</div></div>
    ${isOff(c) ? `<div class="panel muted">${t("client_inactive_hint")}</div>` : ""}
    <div class="grid-2">
      <div class="panel"><h3>${t("company_folder")}</h3>
        <div class="kv" id="cf-kv">${companyKvHTML(c)}</div></div>
      ${fin ? `<div class="panel"><div class="section-title"><h3>${t("finance")}</h3>
        <button class="btn secondary sm" id="stmt-btn">📄 ${t("statement")}</button></div>
        <div class="cards" style="grid-template-columns:1fr 1fr;">
          <div class="stat-card"><div class="v" style="font-size:18px">${money(fin.total_invoiced)}</div><div class="l">${t("total_invoiced")}</div></div>
          <div class="stat-card"><div class="v" style="font-size:18px">${money(fin.total_paid)}</div><div class="l">${t("total_paid")}</div></div>
          <div class="stat-card danger"><div class="v" style="font-size:18px">${money(fin.outstanding)}</div><div class="l">${t("outstanding")}</div></div>
        </div>
        <table style="margin-top:8px"><thead><tr><th>${t("invoice_no")}</th><th>${t("total")}</th><th>${t("status")}</th></tr></thead>
        <tbody>${fin.invoices.map(i => `<tr class="clickable" data-inv="${i.id}"><td>${esc(i.number)}</td><td>${money(i.total)}</td><td>${statusBadge(i.status)}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">${t("none")}</td></tr>`}</tbody></table>
      </div>` : ""}
    </div>

    ${can("clients.edit") ? `<div class="panel"><div class="section-title"><h3>${t("sites")}</h3><button class="btn sm" id="add-site">+ ${t("add_site")}</button></div>
      <table><thead><tr><th>${t("site_name")}</th><th>${t("address_en")}</th><th>${t("area")}</th>
        <th>${t("visiting_schedule")}</th><th>${t("status")}</th><th></th></tr></thead>
      <tbody id="sites-body">${(c.sites || []).map(folderSiteRowHTML).join("")
        || `<tr><td colspan="6" class="empty">${t("none")}</td></tr>`}</tbody></table></div>` : ""}

    <div class="panel"><div class="section-title"><h3>${t("recent_visits")}</h3>
      ${can("visits.create") ? `<button class="btn sm" id="add-visit">+ ${t("new_visit")}</button>` : ""}</div>
      ${visitsTable(c.recent_visits)}</div>

    <div class="panel"><div class="section-title"><h3>🗺️ ${t("maps")}</h3>
      ${can("maps.create") ? `<button class="btn sm" id="add-map">📤 ${t("upload_map")}</button>` : ""}</div>
      <div id="maps-box">${t("loading")}</div></div>

    <div class="panel"><div class="section-title"><h3>${t("attachments")}</h3>
      ${role() !== "client" ? `<button class="btn sm" id="add-photo">📎 ${t("add_attachment")}</button>` : ""}</div>
      <div id="photos" class="photo-grid"></div></div>`;

  if ($("bc")) $("bc").addEventListener("click", () => navigate("clients"));
  loadClientMaps(c);
  if ($("add-map")) $("add-map").addEventListener("click", () => uploadMapDialog(c));
  if ($("client-analytics-btn")) $("client-analytics-btn").addEventListener("click", () => navigate("client-analytics", { id: c.id }));
  if ($("stmt-btn")) $("stmt-btn").addEventListener("click", () => statementDialog(c));
  if ($("edit-client")) $("edit-client").addEventListener("click", () => clientForm(c, (saved) => {
    // What an edit can change on this screen is the name at the top and the six
    // facts in the panel. The finance figures, the branches, the visits and the
    // attachments are untouched by it, so they are left alone.
    Object.assign(c, saved);
    if ($("cf-title")) {
      $("cf-title").innerHTML = `${esc(localized(c, "name"))}${
        isOff(c) ? ` ${statusBadge("inactive")}` : ""}`;
    }
    if ($("cf-kv")) $("cf-kv").innerHTML = companyKvHTML(c);
  }));
  if ($("add-visit")) $("add-visit").addEventListener("click", () => visitForm({ client_id: c.id }));
  wireVisitRows(v);
  v.querySelectorAll("tr[data-inv]").forEach(tr => tr.addEventListener("click", () => navigate("invoice", { id: tr.dataset.inv })));
  // Adding a branch adds a ROW the folder has never held, so that one still
  // reloads the folder. Editing one is what the audit measured, and it now
  // costs the PUT and nothing else.
  if ($("add-site")) $("add-site").addEventListener("click", () => siteForm(c.id));
  const patchFolderSite = (saved) => {
    const arr = c.sites || [];
    const i = arr.findIndex(x => String(x.id) === String(saved && saved.id));
    if (i < 0) { navigate("client", { id: c.id }); return; }
    arr[i] = withAreaName(saved, arr[i]);
    swapRow(v.querySelector(`#sites-body tr[data-site="${saved.id}"]`),
            folderSiteRowHTML(arr[i]), wireFolderSiteRow);
  };
  // A branch already in the book has to be reachable, not just deletable —
  // everything the scheduler reads (area, window, days, frequency) is typed here.
  function wireFolderSiteRow(tr) {
    tr.querySelectorAll("[data-editsite]").forEach(b => b.addEventListener("click", () =>
      siteForm(c.id, (c.sites || []).find(s => String(s.id) === b.dataset.editsite),
               patchFolderSite)));
    tr.querySelectorAll("[data-rmsite]").forEach(b => b.addEventListener("click", async () => {
      if (confirm(t("confirm_delete"))) {
        const r = await API.del("/sites/" + b.dataset.rmsite);
        if (handledOffline(r, b.closest("tr"))) return;
        navigate("client", { id: c.id });
      }
    }));
    wireStatusToggles(tr, (kind, id) => (c.sites || []).find(x => String(x.id) === String(id)),
                      () => navigate("client", { id: c.id }));
  }
  v.querySelectorAll("#sites-body tr[data-site]").forEach(wireFolderSiteRow);
  if ($("client-status-btn")) $("client-status-btn").addEventListener("click", () => {
    const back = () => navigate("client", { id: c.id });
    if (isOff(c)) reactivate("client", c.id, back); else deactivateDialog("client", c, back);
  });

  renderPhotos("client", c.id, c.photos);
  if ($("add-photo")) $("add-photo").addEventListener("click", () => uploadPhotoDialog("client", c.id, () => navigate("client", { id: c.id })));
}

// What the automatic scheduler knows about a branch: when it opens, which days,
// and how often it needs a visit. Read on the Locations list and in the client's
// own folder, so the office sees the whole book without opening a form per branch.
// Two scrollbars, one position. The rail above the table is an empty box the
// width of the table; moving either moves the other, so the office can reach
// Friday from the top of the page instead of hunting for the window's own
// scrollbar under two hundred rows. The branch name is frozen in place (CSS)
// so a row never becomes anonymous halfway across.
function wireBoardScroll(v, tries) {
  const rail = v.querySelector("#bs-rail");
  const inner = v.querySelector("#bs-rail-in");
  const table = v.querySelector(".bs-table");
  // installTableScroll() puts every wide table in its own .table-scroll box.
  // THAT is the element that scrolls — the one whose scrollbar sits under two
  // hundred rows. The rail drives it; adding a second scroller of our own here
  // would just nest one inside the other and neither would move.
  //
  // It is installed by a MutationObserver, so on the first paint the box does
  // not exist yet and this used to give up in silence — the rail was drawn and
  // did nothing. Wait for it instead.
  const box = table && table.closest(".table-scroll");
  if (!rail || !inner || !table) return;
  if (!box) {
    if ((tries || 0) < 20) requestAnimationFrame(() => wireBoardScroll(v, (tries || 0) + 1));
    return;
  }
  const measure = () => {
    // Measure the SCROLLER, not the table: the table is width:100% and its
    // cells overflow it, so its own box under-reports. box.scrollWidth is what
    // the scrollbar is actually sized against.
    inner.style.width = box.scrollWidth + "px";
    // No overflow, no furniture: a board that fits shows neither rail nor hint.
    const wide = box.scrollWidth > box.clientWidth + 2;
    rail.style.display = wide ? "" : "none";
    v.querySelector(".bs-hint").style.display = wide ? "" : "none";
    box.classList.toggle("bs-scrolled", box.scrollLeft > 0);
  };
  let syncing = false;
  const follow = (from, to) => {
    if (syncing) return;
    syncing = true;
    to.scrollLeft = from.scrollLeft;
    box.classList.toggle("bs-scrolled", box.scrollLeft > 0);
    syncing = false;
  };
  box.addEventListener("scroll", () => follow(box, rail));
  rail.addEventListener("scroll", () => follow(rail, box));
  // Shift+wheel is the habit people already have on wide tables; make it work
  // whichever way the browser reports the wheel.
  box.addEventListener("wheel", (e) => {
    if (!e.shiftKey || !e.deltaY) return;
    box.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  measure();
  window.addEventListener("resize", measure);
  // Rows appear and disappear as the office filters, and the table can grow a
  // column when a day is ticked open.
  const body = v.querySelector("#bs-body");
  if (body) new MutationObserver(measure).observe(body, { childList: true, subtree: true });
}

// A month, for the branch cycle, is four roster weeks — the same arithmetic the
// server does. The office types EITHER unit; only the monthly figure is stored.
const WEEKS_PER_MONTH = 4;
// MONTHS. The office asked for the week option to be taken away — "I will do
// the shifts per month, so delete the per-week option in the branch schedule
// and make it per month" — so every frequency on screen is now visits a MONTH,
// which is also how the figure has always been stored. The column survives
// because a branch entered years ago still carries its answer and an import
// may still say "week"; nothing on screen offers the choice any more, and
// anything still marked weekly reads as the monthly number it really is.
// The branch's frequency as the office reads it: the stored monthly number,
// quartered when this branch is kept in weeks. Trimmed of float dust so a
// branch on 1 a week shows "1", not "0.9999999".
function freqValue(b) {
  return Math.round((+(b && b.visits_per_month) || 0) * 100) / 100;
}
// What a body should carry. Always the monthly figure, and always marked as
// such, so a branch stops being read in weeks the first time it is saved.
const freqBody = (n) => ({ visits_per_month: n, freq_unit: "month" });

function branchScheduleHTML(s) {
  const n = freqValue(s);
  if (!n) return `<span class="muted small">${t("not_on_cycle")}</span>`;
  // A window that closes before it opens is the night shift (22:00–02:00), and
  // only the part before midnight can be booked on the day itself — worth a
  // mark, because it is the difference between the hours entered and the hours
  // the roster can use.
  const night = s.service_from && s.service_to && s.service_to <= s.service_from;
  const win = (s.service_from || s.service_to)
    ? `${esc(s.service_from || "…")}–${esc(s.service_to || "…")}${
        night ? ` <span class="sd-night" title="${esc(t("overnight_hint"))}">🌙</span>` : ""}`
    : `<span class="muted">${t("any_time")}</span>`;
  const ds = s.service_days || [];
  // A day with its own hours is marked and carries them in its tooltip — the
  // exception is what the office needs to spot, not the rule.
  const chips = ds.length
    ? AVAIL_DAYS.filter(x => ds.some(d => d.weekday === x.wd)).map(x => {
        const d = ds.find(y => y.weekday === x.wd);
        const own = d.start_time || d.end_time;
        const hrs = `${d.start_time || s.service_from || "…"}–${d.end_time || s.service_to || "…"}`
          + (d.agent_name ? ` · ${d.agent_name}` : "");
        return `<span class="sd-chip${own || d.agent_name ? " sd-chip-own" : ""}" title="${
          esc(hrs)}">${t("wd_" + x.k)}${own || d.agent_name ? "*" : ""}</span>`;
      }).join("")
    : `<span class="muted small">${t("days_any")}</span>`;
  const mins = +s.visit_minutes > 0 ? ` · ${hoursMins(s.visit_minutes)}` : "";
  // Whose standing shift this branch is, when it is anybody's — the office
  // needs to see that at a glance, because it is the reason nobody else is
  // ever sent here.
  const his = s.preferred_agent_name
    ? `<div class="muted small">👤 ${esc(s.preferred_agent_name)}</div>` : "";
  return `<div>${win} · <strong>${n}×</strong> ${
    t("per_month")}${mins}</div>
    <div class="sd-chips">${chips}</div>${his}`;
}

async function siteForm(clientId, site, after) {
  const s = site || {};
  const isEdit = !!site;
  await loadAreas();          // the area picker needs the list
  await loadRosterAgents();   // and so does "this branch is his"
  // Which days this branch already accepts, by weekday, so the grid prefills.
  const openDays = {};
  (s.service_days || []).forEach(d => { openDays[d.weekday] = d; });
  // Saturday-first for the office; the STORED weekday is Python's Mon=0 and
  // the two meet only here, exactly as on the availability board.
  const dayGrid = AVAIL_DAYS.map(x => {
    const on = openDays[x.wd];
    return `<label class="sd-day${on ? " sd-on" : ""}" data-wd="${x.wd}">
      <span class="sd-tick"><input type="checkbox" class="sd-wd" data-wd="${x.wd}"${
        on ? " checked" : ""}> ${t("wd_" + x.k)}</span>
      <span class="sd-hours"${on ? "" : ' style="display:none"'}>
        <input type="text" class="sd-from hhmm" data-wd="${x.wd}" maxlength="5"
          inputmode="numeric" autocomplete="off" value="${esc((on && on.start_time) || "")}">
        <input type="text" class="sd-to hhmm" data-wd="${x.wd}" maxlength="5"
          inputmode="numeric" autocomplete="off" value="${esc((on && on.end_time) || "")}">
        <select class="sd-agent" data-wd="${x.wd}">${
          agentOptions(on && on.agent_id, t("agent_as_usual"))}</select>
      </span></label>`;
  }).join("");
  openModal(isEdit ? t("edit") : t("add_site"), `<form id="sf">
    ${field(t("site_name"), "name", { value: s.name })}
    ${field(t("address_en"), "address", { value: s.address })}
    <div class="field"><label>${t("area")}</label>
      <select name="area_id">${areaOptions(s.area_id, t("area_none"))}</select></div>
    <div class="form-grid">
      ${field(t("service_from"), "service_from", { value: s.service_from || "", attrs: HHMM_ATTRS })}
      ${field(t("service_to"), "service_to", { value: s.service_to || "", attrs: HHMM_ATTRS })}
      ${field(t("visits_per_month"), "freq_n",
              { value: freqValue(s), attrs: 'type="number" min="0" max="56" step="0.5"' })}
      ${field(t("visit_minutes"), "visit_minutes",
              { value: s.visit_minutes ?? "", attrs: 'type="number" min="10" max="480" step="5" placeholder="—"' })}
    </div>
    <div class="field"><label>${t("preferred_agent")}</label>
      <select name="preferred_agent_id">${
        agentOptions(s.preferred_agent_id, t("agent_any"))}</select>
      <div class="muted small">${t("preferred_agent_hint")}</div></div>
    <div class="field"><label>${t("service_days_lbl")}</label>
      <div class="sd-grid">${dayGrid}</div>
      <p class="muted small">${t("service_days_hint")}</p></div>
    <p class="muted small">${t("service_window_hint")}</p>
    <div class="field"><label>${esc(t("coordinates"))} <span class="muted small">(${esc(t("coords_hint"))})</span></label>
      <div style="display:flex;gap:6px">
        <input type="text" name="lat" placeholder="lat" value="${esc(s.lat ?? "")}" style="flex:1" />
        <input type="text" name="lng" placeholder="lng" value="${esc(s.lng ?? "")}" style="flex:1" />
        <button type="button" class="btn secondary sm" id="sf-geo">📍 ${esc(t("use_my_location"))}</button>
      </div>
      <input type="text" id="sf-paste" placeholder="${esc(t("paste_maps_link"))}"
             value="${esc(s.map_url || "")}" style="margin-top:6px;width:100%" />
      <input type="hidden" name="map_url" value="${esc(s.map_url || "")}" />
      <div class="muted small" id="sf-paste-msg">${s.map_url
        ? `<a href="${esc(s.map_url)}" target="_blank" rel="noopener">${t("open_in_maps")}</a>` : ""}</div>
      <div class="muted small">${t("paste_maps_hint")}</div></div>
    <div class="form-actions"><button type="button" class="btn secondary" id="sf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("sf-x").addEventListener("click", closeModal);
    wireTimeInputs(root);       // the service-window boxes type like every other hh:mm
    // Ticking a day reveals its hours. Leaving them blank means "the usual
    // window", so the per-day boxes show that window as their placeholder and
    // follow it as it is typed — the office only fills in the odd day out.
    const usualFrom = root.querySelector("[name=service_from]");
    const usualTo = root.querySelector("[name=service_to]");
    const echoUsual = () => {
      root.querySelectorAll(".sd-from").forEach(el => {
        el.placeholder = normHHMM(usualFrom.value) || t("any_time");
      });
      root.querySelectorAll(".sd-to").forEach(el => {
        el.placeholder = normHHMM(usualTo.value) || t("any_time");
      });
    };
    echoUsual();
    [usualFrom, usualTo].forEach(el => el.addEventListener("input", echoUsual));
    root.querySelectorAll(".sd-wd").forEach(cb => cb.addEventListener("change", () => {
      const cell = cb.closest(".sd-day");
      cell.classList.toggle("sd-on", cb.checked);
      cell.querySelector(".sd-hours").style.display = cb.checked ? "" : "none";
    }));
    const latI = root.querySelector("[name=lat]"), lngI = root.querySelector("[name=lng]");
    // paste a "lat,lng" or a Google Maps link -> fill the coordinate fields
    // WHAT THE OFFICE PASTES IS NOT ONE FORMAT. A desktop URL carries the pin
    // in it and is read here, instantly. The phone's Share button gives
    // `maps.app.goo.gl/xxxx`, which carries NOTHING — that one has to be
    // followed, and only the server can follow it (Google sends no CORS
    // header). So: read locally on every keystroke, and when the box is left
    // with a link we could not read, ask the server to open it.
    const pasteBox = root.querySelector("#sf-paste");
    const pasteMsg = root.querySelector("#sf-paste-msg");
    const urlField = root.querySelector("[name=map_url]");
    const showPin = (url) => {
      urlField.value = url || "";
      pasteMsg.innerHTML = url
        ? `✅ <a href="${esc(url)}" target="_blank" rel="noopener">${t("open_in_maps")}</a>`
        : "✅ " + t("pin_saved");
    };
    pasteBox.addEventListener("input", (e) => {
      const ll = parseLatLng(e.target.value);
      if (ll) { latI.value = ll[0]; lngI.value = ll[1]; showPin(isMapUrl(e.target.value) ? e.target.value.trim() : ""); }
    });
    let lastAsked = "";
    const followLink = async () => {
      const raw = pasteBox.value.trim();
      if (!raw || raw === lastAsked || parseLatLng(raw)) return;
      if (!isMapUrl(raw)) { pasteMsg.textContent = t("paste_maps_bad"); return; }
      lastAsked = raw;
      pasteMsg.textContent = t("paste_maps_looking");
      try {
        const r = await API.post("/geo/resolve", { url: raw });
        latI.value = r.lat; lngI.value = r.lng;
        showPin(r.url || raw);
      } catch (err) { pasteMsg.textContent = "⚠️ " + err.message; }
    };
    pasteBox.addEventListener("change", followLink);
    pasteBox.addEventListener("blur", followLink);
    $("sf-geo").addEventListener("click", () => {
      if (!navigator.geolocation) { alert(t("geo_unsupported")); return; }
      $("sf-geo").textContent = "…";
      navigator.geolocation.getCurrentPosition(
        (p) => { latI.value = p.coords.latitude.toFixed(6); lngI.value = p.coords.longitude.toFixed(6); $("sf-geo").textContent = "📍 " + t("use_my_location"); },
        () => { alert(t("geo_failed")); $("sf-geo").textContent = "📍 " + t("use_my_location"); });
    });
    root.querySelector("#sf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      // The hh:mm boxes accept "9" or "930"; normalise before they reach the API.
      d.service_from = normHHMM(d.service_from) || null;
      d.service_to = normHHMM(d.service_to) || null;
      // The frequency goes up in whichever unit it was typed in, and says so —
      // the server stores one monthly figure either way.
      Object.assign(d, freqBody(d.freq_n || 0));
      delete d.freq_n;
      // formData() reads .value only, so the day ticks are collected by hand.
      // Sending the key ALWAYS matters: an empty list is how the office says
      // "no fixed days" and clears the ones that were there.
      d.service_days = [...root.querySelectorAll(".sd-wd:checked")].map(cb => {
        const wd = cb.dataset.wd;
        const pick = (sel) => normHHMM(root.querySelector(`${sel}[data-wd="${wd}"]`).value) || null;
        const who = root.querySelector(`.sd-agent[data-wd="${wd}"]`);
        return { weekday: Number(wd), start_time: pick(".sd-from"), end_time: pick(".sd-to"),
                 agent_id: (who && who.value) || null };
      });
      // A REFUSED SAVE HAS TO SAY SO. This was the only form in the CRM whose
      // save was not wrapped: the server's answer ("that area does not exist",
      // "visits per month must be a number") was thrown into the console and
      // the office was left looking at a dialog that had simply stopped doing
      // anything. Every other form alerts; so does this one now.
      let saved;
      try {
        saved = isEdit ? await API.put(`/sites/${s.id}`, d)
                       : await API.post(`/clients/${clientId}/sites`, d);
      } catch (err) { alert(err.message); return; }
      if (handledOffline(saved)) return;
      closeModal();
      // The saved row goes to the caller so the screen can put THAT row back
      // instead of re-reading every branch it holds.
      if (after) after(saved); else navigate("client", { id: clientId });
    });
  });
}

// Parse "lat,lng" or a Google Maps URL into [lat, lng] (mirrors the server).
// Is this a Google Maps link at all? The same allow-list the server keeps —
// the office sometimes pastes a WhatsApp forward or a name by mistake, and
// saying so on the spot beats a pin that silently never appears.
function isMapUrl(text) {
  const v = (text || "").trim();
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const h = new URL(v).hostname.toLowerCase();
    return ["maps.app.goo.gl", "goo.gl", "maps.google.com", "www.google.com",
            "google.com", "g.co"].includes(h);
  } catch (e) { return false; }
}
// The last day of the calendar month a date falls in.
function endOfMonth(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${last.getFullYear()}-${p(last.getMonth() + 1)}-${p(last.getDate())}`;
}
function parseLatLng(text) {
  if (!text) return null;
  const pats = [/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/, /[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/, /^\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/];
  for (const p of pats) {
    const m = text.match(p);
    if (m) { const la = +m[1], ln = +m[2]; if (la >= -90 && la <= 90 && ln >= -180 && ln <= 180) return [la, ln]; }
  }
  return null;
}

// ---- photos ----
// Classify an attachment by its file extension so non-images render as a
// download link rather than a broken <img>.
function attachKind(name) {
  const ext = (name || "").toLowerCase().split(".").pop();
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "xls" || ext === "xlsx") return "excel";
  return "file";
}
// Render images + document attachments into a grid (defaults to #photos; pass
// containerId to target another grid, e.g. report attachments).
function renderPhotos(entityType, entityId, photos, containerId) {
  const box = $(containerId || "photos");
  if (!box) return;
  if (!photos || !photos.length) { box.innerHTML = `<div class="empty">${t("no_photos")}</div>`; return; }
  const canRemove = role() !== "client";
  box.innerHTML = photos.map(p => {
    const rm = canRemove ? `<button class="rm" data-rmphoto="${p.id}">✕</button>` : "";
    const bp = Number(p.is_business_plan) ? `<span class="badge b-active" style="margin-inline-start:4px">${t("business_plan")}</span>` : "";
    // The comment, and ONLY the comment — never the name the phone gave the
    // file. An attachment with nothing written under it prints nothing, and
    // says so here so it can be filled in.
    //
    // ✎ IS A CORNER BUTTON ON THE PICTURE, beside ✕, NOT a pencil in the text.
    // As a `link-btn sm` it measured TEN PIXELS WIDE — fine with a mouse, and
    // effectively untappable with a thumb, which is exactly why rewording a
    // comment "only worked on the desktop". The caption line opens the same
    // dialog, so there are two ways in and both are finger-sized. The two
    // handlers never double-fire: the button sits OUTSIDE the caption box.
    const ed = canRemove
      ? `<button type="button" class="ed" data-edcap="${p.id}" title="${esc(t("edit_comment"))}" aria-label="${esc(t("edit_comment"))}">✎</button>` : "";
    // The caption line is the BIG target: text-sized, so it stays legible and
    // tappable at any zoom — including the app's tablet path, where the CRM is
    // laid out at 900px and scaled down and a 26px corner button lands on the
    // glass as about ten. The pencil at the end of the line is a glyph, not a
    // button, so it cannot fire the dialog twice.
    const capPen = canRemove ? `<span class="cap-pen" aria-hidden="true">✎</span>` : "";
    const cap = `<div class="cap"${canRemove ? ` data-edcap="${p.id}" title="${esc(t("edit_comment"))}"` : ""}>${p.caption ? esc(p.caption)
      : `<span class="muted">${esc(t("no_comment"))}</span>`}${bp}${capPen}</div>`;
    if (attachKind(p.filename) === "image") {
      return `<div class="photo-item"><img src="/uploads/${esc(p.filename)}" alt="${esc(p.caption || "")}" />${rm}${ed}${cap}</div>`;
    }
    const icon = attachKind(p.filename) === "pdf" ? "📄" : attachKind(p.filename) === "excel" ? "📊" : "📎";
    return `<div class="photo-item file-item">
      <a class="file-link" href="/uploads/${esc(p.filename)}" target="_blank" rel="noopener" download="${esc(p.original_name || "")}">
        <span class="file-icon">${icon}</span><span class="file-name">${esc(p.original_name || p.filename)}</span></a>${rm}${ed}${cap}</div>`;
  }).join("");
  box.querySelectorAll("[data-rmphoto]").forEach(b => b.addEventListener("click", async () => {
    if (confirm(t("confirm_delete"))) { const r = await API.del("/photos/" + b.dataset.rmphoto); if (handledOffline(r, b.closest(".photo-item"))) return; navigate(currentView, { id: entityId }); }
  }));
  // Rewording a picture after the fact — a comment typed in a hurry in the
  // field, or one that was never typed at all. A small dialog rather than
  // prompt(): the Android WebView answers prompt() with null and the edit
  // would silently do nothing there.
  box.querySelectorAll("[data-edcap]").forEach(b => b.addEventListener("click", () => {
    const pic = (photos || []).find(x => String(x.id) === String(b.dataset.edcap)) || {};
    openModal(t("edit_comment"), `<form id="cpf">
        ${field(t("comment"), "caption", { value: pic.caption || "" })}
        <div class="form-actions"><button type="button" class="btn secondary" id="cpf-x">${t("cancel")}</button>
        <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
      root.querySelector("#cpf-x").addEventListener("click", closeModal);
      root.querySelector("#cpf").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          const saved = await API.put("/photos/" + pic.id, { caption: root.querySelector("[name=caption]").value });
          closeModal();
          // Repaint this grid from the list it was drawn with, so the whole
          // screen does not have to be rebuilt to change one line of text.
          pic.caption = (saved && saved.caption) || "";
          renderPhotos(entityType, entityId, photos, containerId);
        } catch (err) { alert(err.message); }
      });
    });
  }));
}
function uploadPhotoDialog(entityType, entityId, after) {
  // Photos taken in-app. They sit beside anything picked from the gallery and
  // upload together, so an engineer can shoot the evidence without leaving the
  // form. The camera panel and the form share one modal — the form stays
  // mounted underneath so a half-typed comment survives a trip to the camera.
  const shots = [];
  const canShoot = !cameraBlockedReason();
  openModal(t("add_attachment"), `
    <div id="pf-cam" class="qr-scan hidden">
      <div class="qr-view"><video id="pf-video" playsinline muted autoplay></video></div>
      <div class="muted small" id="pf-camhint">${t("camera_shoot_hint")}</div>
      <div class="form-actions"><button type="button" class="btn secondary" id="pf-camx">${t("done")}</button>
        <button type="button" class="btn" id="pf-shot">📸 ${t("capture")}</button></div>
    </div>
    <form id="pf">
    <div class="field"><label>${t("files")}</label>
      <input type="file" name="file" accept="image/*,.pdf,.xls,.xlsx" multiple />
      <div class="muted small">${t("attach_hint")}</div></div>
    ${canShoot ? `<button type="button" class="btn secondary sm" id="pf-camopen">📷 ${t("take_photo")}</button>` : ""}
    <div id="pf-list" class="cap-list"></div>
    <div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
      <input type="checkbox" name="business_plan" style="width:auto"> ${t("business_plan")}</label></div>
    <div class="form-actions"><button type="button" class="btn secondary" id="pf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("upload")}</button></div></form>`, (root) => {
    $("pf-x").addEventListener("click", closeModal);

    const strip = root.querySelector("#pf-list");
    // EVERY PICTURE GETS ITS OWN WORDS. One comment box per file, filled in
    // before the upload, because a batch used to take the single comment typed
    // for the batch and print it under all of them. The box starts EMPTY — the
    // name the phone or the laptop gave the file is shown beside it so you can
    // tell one from another, but it is never used as the comment.
    let chosen = [];                    // files picked from the device
    const caps = new Map();             // File -> the comment typed for it
    // One preview URL per file, minted once and revoked on removal — a
    // re-render must not leak a fresh blob URL for a photo it already showed.
    const previews = new Map();
    const isImage = (f) => /^image\//.test(f.type || "") || attachKind(f.name) === "image";
    const preview = (f) => {
      if (!previews.has(f) && isImage(f)) previews.set(f, URL.createObjectURL(f));
      return previews.get(f);
    };
    const drop = (f) => {
      const url = previews.get(f);
      if (url) URL.revokeObjectURL(url);
      previews.delete(f); caps.delete(f);
    };
    const allFiles = () => chosen.concat(shots);
    const renderShots = () => {
      const list = allFiles();
      if (!list.length) { strip.innerHTML = ""; return; }
      strip.innerHTML = `<div class="muted small">${esc(t("attach_caption_hint"))}</div>` +
        list.map((f, i) => {
          const url = preview(f);
          const thumb = url ? `<img src="${url}" alt="">`
            : `<span class="cap-icon">${attachKind(f.name) === "pdf" ? "📄"
                : attachKind(f.name) === "excel" ? "📊" : "📎"}</span>`;
          return `<div class="cap-row">
            <span class="cap-thumb">${thumb}</span>
            <span class="cap-fields">
              <input type="text" data-cap="${i}" placeholder="${esc(t("comment"))}" value="${esc(caps.get(f) || "")}">
              <span class="muted small">${esc(f.name || "")}</span>
            </span>
            <button type="button" class="shot-x" data-rmshot="${i}" title="${esc(t("remove"))}">✕</button>
          </div>`;
        }).join("");
      strip.querySelectorAll("[data-cap]").forEach(inp => inp.addEventListener("input", () => {
        caps.set(allFiles()[Number(inp.dataset.cap)], inp.value);
      }));
      strip.querySelectorAll("[data-rmshot]").forEach(b => b.addEventListener("click", () => {
        const gone = allFiles()[Number(b.dataset.rmshot)];
        const si = shots.indexOf(gone);
        if (si >= 0) shots.splice(si, 1); else chosen = chosen.filter(f => f !== gone);
        drop(gone);
        renderShots();
      }));
    };
    // Picking files replaces the previous pick, exactly as the file input does.
    root.querySelector("[name=file]").addEventListener("change", (e) => {
      chosen.forEach(f => { if (!shots.includes(f)) drop(f); });
      chosen = Array.from(e.target.files || []);
      renderShots();
    });

    if (canShoot) {
      const panel = root.querySelector("#pf-cam"), form = root.querySelector("#pf");
      let cam = null;
      root.querySelector("#pf-camopen").addEventListener("click", async () => {
        panel.classList.remove("hidden"); form.classList.add("hidden");
        cam = await startPhotoCamera(root.querySelector("#pf-video"), root.querySelector("#pf-camhint"));
      });
      const closeCam = () => {
        if (cam) { cam.stop(); cam = null; }
        panel.classList.add("hidden"); form.classList.remove("hidden");
      };
      root.querySelector("#pf-camx").addEventListener("click", closeCam);
      root.querySelector("#pf-shot").addEventListener("click", async () => {
        if (!cam) return;
        const file = await cam.shoot();
        if (!file) return;
        shots.push(file); renderShots();
        root.querySelector("#pf-camhint").textContent = t("shots_taken").replace("{n}", shots.length);
      });
    }

    root.querySelector("#pf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const files = allFiles();
      if (!files.length) { alert(t("attach_none")); return; }
      const businessPlan = root.querySelector("[name=business_plan]").checked;
      try {
        let queued = false;
        for (const file of files) {
          const saved = await API.uploadPhoto(entityType, entityId, file,
                                              (caps.get(file) || "").trim(), businessPlan);
          if (saved && saved.__queued) queued = true;
        }
        closeModal();
        if (queued) return;  // queued offline; oq-queued toast already shown, can't refresh
        toast(t("saved")); after && after();
      } catch (err) { alert(err.message); }
    });
  });
}

// ====================================================================
// Schedule / visits
// ====================================================================
// `actions` adds the per-row Edit / Delete buttons (schedule page only — the
// client's own visit list stays read-only).
// ONE VISIT ROW. Its own builder because a save now rebuilds the row that
// changed and leaves the other twenty-four alone — the audit of 2026-08-25
// measured the old way (re-read the whole page of visits, 21 KB) at 315 ms.
// `data-start` is what keeps the list in date order after an edit without
// asking the server for the order again.
function visitRowHTML(v, canEdit, canDel) {
  return `<tr class="clickable" data-visit="${v.id}" data-start="${esc(v.scheduled_start || "")}">
      <td>${fmtDateTime(v.scheduled_start)}</td>
      <td>${esc(localized(v, "client") || "")}</td>
      <td>${esc(v.site_name || v.location || "—")}</td>
      <td>${esc(localized(v, "service") || "—")}</td>
      <td>${esc(v.agent_name || "—")}</td>
      <td>${statusBadge(v.status)}</td>
      ${canEdit || canDel ? `<td><div class="row-actions">
        ${canEdit ? `<button class="link-btn sm" data-editvisit="${v.id}">${t("edit")}</button>` : ""}
        ${canDel ? `<button class="link-btn sm danger" data-delvisit="${v.id}">${t("delete")}</button>` : ""}
      </div></td>` : ""}</tr>`;
}
// The names a saved visit does not carry. The save answers with ids; the names
// beside them are read from the lists this page already holds, which is what
// was just chosen in the form — never the row's old value.
function visitDisplay(saved, before, extras) {
  const v = Object.assign({}, before || {}, saved);
  const cl = (cache.clients || []).find(c => String(c.id) === String(saved.client_id));
  if (cl) { v.client_en = cl.name_en; v.client_ar = cl.name_ar; }
  const ag = (cache.agents || []).find(a => String(a.id) === String(saved.agent_id));
  v.agent_name = saved.agent_id ? (ag ? ag.full_name : (before || {}).agent_name) : null;
  const sv = (cache.services || []).find(x => String(x.id) === String(saved.service_type_id));
  if (!saved.service_type_id) { v.service_en = null; v.service_ar = null; }
  else if (sv) { v.service_en = sv.name_en; v.service_ar = sv.name_ar; }
  // The branch name comes from the picker the office just used, so a visit
  // moved to another branch does not keep the old branch's name.
  if (extras && "site_name" in extras) v.site_name = extras.site_name;
  else if (String((before || {}).site_id || "") !== String(saved.site_id || "")) v.site_name = null;
  return v;
}

function visitsTable(visits, actions) {
  if (!visits || !visits.length) return `<div class="empty">${t("none")}</div>`;
  const canEdit = actions && can("visits.edit"), canDel = actions && can("visits.delete");
  return `<table><thead><tr><th>${t("scheduled_start")}</th><th>${t("client")}</th>
    <th>${t("location_lbl")}</th><th>${t("service")}</th><th>${t("agent")}</th><th>${t("status")}</th>
    ${canEdit || canDel ? "<th></th>" : ""}</tr></thead>
    <tbody>${visits.map(v => visitRowHTML(v, canEdit, canDel)).join("")}</tbody></table>`;
}
// onChange is called after an edit or a delete so the list can refresh itself.
// A list that would rather put the ONE row back can pass `hooks` instead:
// {patched(saved, before, extras), removed(id)}. Both run only after the server
// has confirmed the write — there is nothing optimistic here. `root` may be a
// whole table or a single <tr>, so a row that has just been swapped can be
// given its handlers back on its own.
function wireVisitRows(root, onChange, hooks) {
  const each = (sel, fn) => {
    if (root.matches && root.matches(sel)) fn(root);
    root.querySelectorAll(sel).forEach(fn);
  };
  each("tr[data-visit]", tr =>
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-editvisit],[data-delvisit]")) return;   // row action, not the row
      navigate("visit", { id: tr.dataset.visit });
    }));
  each("[data-editvisit]", b => b.addEventListener("click", async () => {
    try {
      const visit = await API.get("/visits/" + b.dataset.editvisit);
      visitForm(null, { visit, after: (saved, extras) => {
        if (hooks && hooks.patched && saved && saved.id) hooks.patched(saved, visit, extras);
        else (onChange || reNavigate)();
      } });
    } catch (err) { alert(err.message); }
  }));
  each("[data-delvisit]", b => b.addEventListener("click", async () => {
    if (!confirm(t("delete_visit_confirm"))) return;
    try {
      const r = await API.del("/visits/" + b.dataset.delvisit);
      if (handledOffline(r, b.closest("tr"))) return;
      toast(t("visit_deleted"));
      if (hooks && hooks.removed) hooks.removed(b.dataset.delvisit);
      else (onChange || reNavigate)();
    } catch (err) { alert(err.message); }
  }));
}

async function viewSchedule(v, arg) {
  const statuses = ["", "scheduled", "in_progress", "completed", "cancelled"];
  // An incoming filter (My Team's "view" opens one engineer's day) is applied
  // to the toolbar before the first fetch, so the screen shows what was asked
  // for AND says why — the controls are left free to change afterwards.
  const pre = arg || {};
  v.innerHTML = `<div class="page-head"><h2>${t("schedule_title")}</h2>
    ${can("visits.create") ? `<button class="btn" id="add-visit">+ ${t("new_visit")}</button>` : ""}</div>
    <div class="toolbar">
      <label>${t("status")}: <select id="f-status">${statuses.map(s => `<option value="${s}">${s ? t(statusKey(s)) : t("all")}</option>`).join("")}</select></label>
      ${hasAgentList() ? `<label>${t("agent")}: <select id="f-agent"><option value="">${t("all")}</option>${cache.agents.map(a => `<option value="${a.id}">${esc(a.full_name)}</option>`).join("")}</select></label>` : ""}
      <label>${t("from")}: <input type="date" id="f-from"></label>
      <label>${t("to")}: <input type="date" id="f-to"></label>
      <label>${t("sort_order")}: <select id="f-sort">
        <option value="asc">${t("sort_soonest")}</option>
        <option value="desc">${t("sort_latest")}</option></select></label>
    </div>
    <div class="panel" id="visit-list">${t("loading")}</div>`;
  // What the toolbar is asking for, so a row that has just been edited out of
  // the current filter stops showing instead of sitting there contradicting it.
  const matchesFilters = (x) => {
    const st = $("f-status").value, ag = $("f-agent") ? $("f-agent").value : "";
    const from = $("f-from").value, to = $("f-to").value;
    const day = String(x.scheduled_start || "").slice(0, 10);
    if (st && x.status !== st) return false;
    if (ag && String(x.agent_id || "") !== String(ag)) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  };
  let shown = null;                       // the page currently on screen
  const canEditVisits = role() !== "client" && can("visits.edit");
  const canDelVisits = role() !== "client" && can("visits.delete");
  // After an edit the row is moved to where its new date belongs, so the order
  // stays true without asking the server for it — which way round that is now
  // depends on the toolbar (soonest first by default, latest first on request).
  const sortDir = () => ($("f-sort") && $("f-sort").value) || "asc";
  const placeByDate = (tr) => {
    if (!tr || !tr.parentElement) return;
    const body = tr.parentElement, key = String(tr.dataset.start || "");
    const asc = sortDir() !== "desc";
    const after = [...body.querySelectorAll("tr[data-visit]")]
      .find(x => x !== tr && (asc ? String(x.dataset.start || "") > key
                                  : String(x.dataset.start || "") < key));
    if (after) body.insertBefore(tr, after); else body.appendChild(tr);
  };
  const dropRow = (tr, page, deleted) => {
    if (!tr) return;
    const body = tr.parentElement;
    tr.remove();
    // A delete is one visit fewer in the book; a row filtered off the screen is
    // not, so only the first touches the count.
    if (deleted && shown) {
      shown.total = Math.max(0, (shown.total || 1) - 1);
      // One visit fewer can also be one page fewer — the pager is arithmetic on
      // a total this page already knows, not a reason to ask the server again.
      shown.pages = Math.max(1, Math.ceil(shown.total / PAGE_SIZE));
      const pager = $("visit-list").querySelector(".pager");
      if (pager) {
        const box = document.createElement("div");
        box.innerHTML = pagerHTML(shown);
        if (box.firstElementChild) {
          pager.replaceWith(box.firstElementChild);
          wirePager($("visit-list"), shown, refresh);
        } else pager.remove();
      }
    }
    if (body && !body.querySelector("tr[data-visit]")) refresh(page);
  };
  const hooksFor = (page) => ({
    patched: (saved, before, extras) => {
      const merged = visitDisplay(saved, before, extras);
      const tr = $("visit-list").querySelector(`tr[data-visit="${merged.id}"]`);
      if (!tr) { refresh(page); return; }
      // A visit moved to another DAY may belong on another page of this list,
      // and no local edit can know that — so that one case reloads the page.
      const dayMoved = String((before || {}).scheduled_start || "").slice(0, 10)
                    !== String(merged.scheduled_start || "").slice(0, 10);
      if (dayMoved && shown && (shown.pages || 1) > 1) { refresh(page); return; }
      if (!matchesFilters(merged)) { dropRow(tr, page, false); return; }
      placeByDate(swapRow(tr, visitRowHTML(merged, canEditVisits, canDelVisits),
                          (el) => wireVisitRows(el, () => refresh(page), hooksFor(page))));
    },
    removed: (id) => dropRow($("visit-list").querySelector(`tr[data-visit="${id}"]`), page, true),
  });
  async function refresh(page = 1) {
    const qp = [`page=${page}`, `limit=${PAGE_SIZE}`];
    if ($("f-status").value) qp.push("status=" + $("f-status").value);
    if ($("f-agent") && $("f-agent").value) qp.push("agent=" + $("f-agent").value);
    if ($("f-from").value) qp.push("from=" + $("f-from").value);
    if ($("f-to").value) qp.push("to=" + $("f-to").value);
    qp.push("sort=" + sortDir());
    const d = await API.get("/visits?" + qp.join("&"));
    shown = d;
    $("visit-list").innerHTML = visitsTable(d.items, role() !== "client") + pagerHTML(d);
    wireVisitRows($("visit-list"), () => refresh(page), hooksFor(page));
    wirePager($("visit-list"), d, refresh);
  }
  ["f-status", "f-agent", "f-from", "f-to", "f-sort"].forEach(id => { if ($(id)) $(id).addEventListener("change", () => refresh(1)); });
  if ($("add-visit")) $("add-visit").addEventListener("click", () => visitForm(null, { after: () => refresh(1) }));
  if (pre.agent && $("f-agent")) $("f-agent").value = pre.agent;
  if (pre.from) $("f-from").value = pre.from;
  if (pre.to) $("f-to").value = pre.to;
  refresh(1);
}

// ====================================================================
// Smart Dispatch — drag-drop board, geographic route optimization, SLA
// ====================================================================
function shiftDate(d, delta) { const x = new Date(d + "T00:00:00"); x.setDate(x.getDate() + delta); return ymd(x); }

// Board state: which day, which shift is being dispatched, and whether we're
// looking at that one day or the whole roster week.
const _dp = { date: null, shift: "", scope: "day", roster: null };

// "HH:MM" -> minutes past midnight.
function hhmmMin(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(s || "");
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

// Does a visit's time-of-day fall inside a shift's hours? Shifts that run past
// midnight (16:00–00:00, 22:00–06:00) wrap, so the window is the union of the
// two ends rather than a simple range. A shift with no hours never excludes.
function inShiftWindow(time, from, to) {
  const t = hhmmMin(time), a = hhmmMin(from), b = hhmmMin(to);
  if (a === null || b === null) return true;
  if (t === null) return true;
  if (a === b) return true;                   // a round-the-clock shift
  return b > a ? (t >= a && t < b) : (t >= a || t < b);
}

function dpShiftType() {
  if (!_dp.shift || !_dp.roster) return null;
  return _dp.roster.types.find(ty => String(ty.id) === String(_dp.shift)) || null;
}

// The days the board covers: one date, or the whole Sat–Fri roster week.
function dpDays() {
  if (_dp.scope === "week" && _dp.roster) return _dp.roster.days;
  return [_dp.date];
}

async function viewDispatch(v, arg) {
  if (!cache.agents.length) { try { cache.agents = await API.get("/agents"); } catch (e) {} }
  _dp.date = (arg && arg.date) || ymd(new Date());
  _dp.shift = (arg && arg.shift) || "";
  _dp.scope = (arg && arg.scope) || "day";
  _dp.area = (arg && arg.area) || "";
  _dp.agent = (arg && arg.agent) || "";
  await loadAreas();          // the filter needs them even without shifts.view
  // The roster drives the shift filter. Dispatchers without shifts.view simply
  // get the board as it was before shifts existed.
  _dp.roster = null;
  if (can("shifts.view")) {
    try {
      _dp.roster = await API.get("/shifts/week?start=" + _dp.date);
      if (_dp.roster && _dp.roster.areas) cache.areas = _dp.roster.areas;
    } catch (e) {}
  }
  const shiftOpts = _dp.roster
    ? `<select id="dp-shift"><option value="">${t("all_shifts")}</option>
        ${_dp.roster.types.filter(ty => !ty.is_off).map(ty =>
          `<option value="${ty.id}" ${String(ty.id) === String(_dp.shift) ? "selected" : ""}>${
            esc(shiftLabel(ty))}${shiftHours(ty.start_time, ty.end_time) ? ` (${esc(shiftHours(ty.start_time, ty.end_time))})` : ""}</option>`).join("")}
       </select>
       <select id="dp-scope">
         <option value="day" ${_dp.scope === "day" ? "selected" : ""}>${t("this_day")}</option>
         <option value="week" ${_dp.scope === "week" ? "selected" : ""}>${t("this_week")}</option>
         <option value="month" ${_dp.scope === "month" ? "selected" : ""}>${t("this_month")}</option>
       </select>` : "";
  // ONE MAN, OR EVERYBODY. The filter holds across day, week and month, so
  // stepping through the weeks keeps showing the same engineer's work.
  const engOpts = `<select id="dp-eng"><option value="">${t("all_engineers")}</option>
      ${(cache.agents || []).map(a => `<option value="${a.id}"${
        String(a.id) === String(_dp.agent) ? " selected" : ""}>${esc(a.full_name)}</option>`).join("")}
     </select>`;
  // Narrowing to one area shows that area's jobs beside the people out there:
  // whoever is rostered onto it, plus anyone whose shift ties them to no area
  // at all and who can therefore take work anywhere.
  const areaOpts = (cache.areas || []).length
    ? `<select id="dp-area"><option value="">${t("all_areas")}</option>
        ${(cache.areas || []).map(a => `<option value="${a.id}"${
          String(a.id) === String(_dp.area) ? " selected" : ""}>${esc(areaLabel(a))}</option>`).join("")}
       </select>` : "";
  const step = _dp.scope === "week" ? 7 : 1;   // the month steps by itself below
  v.innerHTML = `<div class="page-head"><h2>${t("nav_dispatch")}</h2>
    <div class="dp-filters" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${engOpts}${shiftOpts}${areaOpts}
      <button class="btn secondary sm" id="dp-prev">${t("prev")}</button>
      <input type="date" id="dp-date" value="${_dp.date}">
      <button class="btn secondary sm" id="dp-next">${t("next")}</button>
      <button class="btn secondary sm" id="dp-today">${t("today")}</button>
      <button class="btn secondary sm" id="dp-print">🖨 ${t("cal_print")}</button></div></div>
    <div id="dp-sla"></div>
    <p class="muted small">${IS_TOUCH ? t("dispatch_hint_touch")
      : (_dp.shift ? t("dispatch_shift_hint") : t("dispatch_hint"))}</p>
    <div id="dp-board" class="dispatch-board">${t("loading")}</div>`;
  const go = (patch) => navigate("dispatch", Object.assign(
    { date: _dp.date, shift: _dp.shift, scope: _dp.scope, area: _dp.area,
      agent: _dp.agent }, patch));
  const hop = (dir) => {
    if (_dp.scope !== "month") return go({ date: shiftDate(_dp.date, dir * step) });
    const d = new Date(_dp.date + "T00:00:00");
    d.setDate(1); d.setMonth(d.getMonth() + dir);
    go({ date: ymd(d) });
  };
  $("dp-prev").addEventListener("click", () => hop(-1));
  $("dp-next").addEventListener("click", () => hop(1));
  $("dp-today").addEventListener("click", () => go({ date: ymd(new Date()) }));
  $("dp-date").addEventListener("change", (e) => go({ date: e.target.value }));
  if ($("dp-shift")) $("dp-shift").addEventListener("change", (e) => go({ shift: e.target.value }));
  if ($("dp-scope")) $("dp-scope").addEventListener("change", (e) => go({ scope: e.target.value }));
  if ($("dp-area")) $("dp-area").addEventListener("change", (e) => go({ area: e.target.value }));
  if ($("dp-eng")) $("dp-eng").addEventListener("change", (e) => go({ agent: e.target.value }));
  $("dp-print").addEventListener("click", dpPrintDialog);
  loadSlaStrip();
  await renderBoard();
}

async function loadSlaStrip(targetId = "dp-sla") {
  const box = $(targetId);
  if (!box) return;
  let sla;
  // The SLA strip reads the service contracts. A role without them (either
  // supervising role) simply does not get the strip — asking anyway would only
  // earn a 403.
  if (!can("contracts.view")) return;
  try { sla = await API.get("/dispatch/sla"); } catch (e) { return; }
  const c = sla.counts;
  const chip = (n, cls, label) => `<span class="sla-chip ${cls}">${n} ${label}</span>`;
  const rows = sla.items.filter(r => r.status !== "ok");
  box.innerHTML = `<div class="panel sla-strip">
    <div class="sla-head"><strong>📡 ${t("sla_tracking")}</strong>
      ${chip(c.overdue, "sla-overdue", t("sla_overdue"))}
      ${chip(c.due_soon, "sla-due", t("sla_due_soon"))}
      ${chip(c.ok, "sla-ok", t("sla_on_track"))}
      ${rows.length ? `<button class="link-btn sm" id="sla-toggle">${t("view")}</button>` : ""}</div>
    <div id="sla-list" class="hidden">${rows.map(r => `<div class="sla-row ${r.status === "overdue" ? "sla-overdue" : "sla-due"}" data-client="${r.client_id}">
      <span><strong>${esc(localized(r, "client"))}</strong>${r.site_name ? " — " + esc(r.site_name) : ""}</span>
      <span class="muted small">${t("freq_" + r.frequency)} · ${r.last_service ? t("last_service") + ": " + fmtDate(r.last_service) : t("never_serviced")}${r.days_overdue > 0 ? " · " + r.days_overdue + " " + t("days_overdue") : ""}</span>
    </div>`).join("") || `<div class="muted small">${t("none")}</div>`}</div></div>`;
  if ($("sla-toggle")) $("sla-toggle").addEventListener("click", () => $("sla-list").classList.toggle("hidden"));
  box.querySelectorAll(".sla-row[data-client]").forEach(r =>
    r.addEventListener("click", () => navigate("client-analytics", { id: r.dataset.client })));
}

// THE MONTH, AS A MATRIX. A month of the office's book is 823 visits and
// 708 KB of visit records — GPS, notes, bilingual area names, none of which a
// grid needs. So the server counts, and what arrives is one small cell per
// engineer per day: how many calls, and the first and last hour.
//
// IT IS MEANT TO BE READ, NOT SQUINTED AT. The table used to be stretched to
// the width of the screen — thirty-one columns sharing whatever space there
// was — so on a laptop every hour printed at nine pixels on top of the next,
// and on a phone the hours were dropped altogether. Now each day column is
// given the width its two lines actually need and the BOX scrolls instead:
// sideways through the days, down through the men, with the names and the
// dates pinned where they can still be seen. Two ways of laying the same
// month out are offered, because which reads better depends on how many
// engineers are on the book: ENGINEERS DOWN (a man a row, the month across)
// or DAYS DOWN (a day a row, the names above).
const DG_LAYOUT_KEY = "dpMonthLayout";
function dgLayout() {
  return localStorage.getItem(DG_LAYOUT_KEY) === "day" ? "day" : "eng";
}
const DG_WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const dgWd = (iso) => DG_WD[new Date(iso + "T00:00:00").getDay()];
const dgDayNum = (iso) => Number(iso.slice(8, 10));
// 08:00 → 08, 08:30 → 8:30. The minutes only earn their room when they say
// something, which is what lets both ends of the day sit in one narrow column.
function dgHour(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ""));
  if (!m) return esc(String(s || ""));
  return m[2] === "00" ? m[1].padStart(2, "0") : String(Number(m[1])) + ":" + m[2];
}
// How full the day is, as one of five shades — the same scale in both layouts
// and on paper.
const dgBusy = (c) => (c ? Math.min(4, Math.ceil(c.count / 2)) : 0);
function dgCellHtml(e, day, c) {
  return `<td class="dg-cell l${dgBusy(c)}" data-agent="${e.id}" data-date="${day}" tabindex="0"
      title="${esc(e.full_name)} · ${day}${c ? ` · ${c.count} · ${c.first}–${c.last}` : ""}">${
      c ? `<b>${c.count}</b><span class="dg-t">${dgHour(c.first)}–${dgHour(c.last)}</span>` : ""}</td>`;
}

// A man a row, the month running across. What the office has always read.
function dgTableEng(g, cells, tot) {
  const head = g.days.map(day => {
    const wd = dgWd(day);
    return `<th class="dg-d${wd === "fri" ? " dg-rest" : ""}" title="${esc(fmtDate(day))}">
      <i>${t("wdi_" + wd)}</i><b>${dgDayNum(day)}</b></th>`;
  }).join("");
  const rows = g.engineers.map(e => {
    const tds = g.days.map(day => dgCellHtml(e, day, cells[e.id + "|" + day])).join("");
    return `<tr><th class="dg-name"><div class="dg-nrow"
        ><span class="dg-nm" title="${esc(e.full_name)}">${esc(e.full_name)}</span
        ><span class="dg-tot">${tot.byAgent[e.id] || 0}</span></div></th>${tds}</tr>`;
  }).join("");
  const feet = g.days.map(day =>
    `<td class="dg-sum${dgWd(day) === "fri" ? " dg-rest" : ""}">${tot.byDay[day] || 0}</td>`).join("");
  return `<table class="dg dg-by-eng">
      <thead><tr><th class="dg-name dg-corner">${t("dg_col_eng")}</th>${head}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th class="dg-name dg-corner"><div class="dg-nrow"
        ><span class="dg-nm">${t("total")}</span><span class="dg-tot">${tot.all}</span></div></th>${feet}</tr></tfoot>
    </table>`;
}

// A day a row, the names above. The month then reads DOWN the screen — the
// direction every other page scrolls — and a phone shows a whole day at once.
function dgTableDay(g, cells, tot) {
  const head = g.engineers.map(e =>
    `<th class="dg-eng-h" title="${esc(e.full_name)}"><span class="dg-nm">${esc(e.full_name)}</span
      ><span class="dg-tot">${tot.byAgent[e.id] || 0}</span></th>`).join("");
  const rows = g.days.map(day => {
    const wd = dgWd(day);
    const tds = g.engineers.map(e => dgCellHtml(e, day, cells[e.id + "|" + day])).join("");
    return `<tr class="${wd === "fri" ? "dg-rest-row" : ""}">
      <th class="dg-name dg-dayh"><div class="dg-nrow"
        ><span class="dg-nm"><b>${dgDayNum(day)}</b> ${t("wd_" + wd)}</span
        ><span class="dg-tot">${tot.byDay[day] || 0}</span></div></th>${tds}</tr>`;
  }).join("");
  return `<table class="dg dg-by-day">
      <thead><tr><th class="dg-name dg-corner">${t("date")}</th>${head}</tr></thead>
      <tbody>${rows}</tbody></table>`;
}

async function renderMonthBoard() {
  let board = $("dp-board");
  if (!board) return;
  const first = _dp.date.slice(0, 8) + "01";
  const d = new Date(first + "T00:00:00");
  const last = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const q = `from=${first}&to=${last}`
    + (_dp.agent ? `&agent=${_dp.agent}` : "") + (_dp.area ? `&area=${_dp.area}` : "");
  let g;
  try { g = await API.get("/dispatch/grid?" + q); }
  catch (e) { board.innerHTML = `<div class="empty">${esc(e.message || t("error"))}</div>`; return; }
  // The month takes a moment to count, and in that moment he may have moved on
  // — stepped to the next month, or off the board altogether. So the board is
  // taken again after the wait: if it has been replaced, the one we started
  // with is a detached node and drawing into it would wire buttons nobody can
  // ever see (and throw on the way).
  board = $("dp-board");
  if (!board) return;
  const cells = {};
  g.cells.forEach(c => { cells[c.agent_id + "|" + c.date] = c; });
  _dp.engineers = g.engineers;      // the move sheet's picker reads this
  _dp.grid = g;                     // and the printer reads it rather than re-count
  // Counted once, then shown on both edges of whichever layout is on screen:
  // what each man is carrying this month, and what each day is carrying.
  const tot = { byAgent: {}, byDay: {}, all: 0 };
  g.cells.forEach(c => {
    tot.byAgent[c.agent_id] = (tot.byAgent[c.agent_id] || 0) + c.count;
    tot.byDay[c.date] = (tot.byDay[c.date] || 0) + c.count;
    tot.all += c.count;
  });
  const lay = dgLayout();
  const tools = `<div class="dg-tools">
      <div class="cal-modes">
        <button type="button" class="btn sm ${lay === "eng" ? "" : "secondary"}" data-dglay="eng">${t("dg_layout_eng")}</button>
        <button type="button" class="btn sm ${lay === "day" ? "" : "secondary"}" data-dglay="day">${t("dg_layout_day")}</button>
      </div>
      <span class="muted small dg-count">${t("dg_month_total")
        .replace("{n}", tot.all).replace("{m}", g.engineers.length)}</span>
    </div>`;
  // The board is a flex row of engineer columns on the day and week views; the
  // matrix is one block that scrolls inside itself, and a flex item would be
  // squeezed to a fraction of the screen (which is how the month came to be
  // dealt out over 649 pixels of a 1440-pixel laptop).
  board.classList.add("dg-month");
  board.innerHTML = tools
    + `<div class="dg-wrap">${lay === "day" ? dgTableDay(g, cells, tot) : dgTableEng(g, cells, tot)}</div>
    <p class="muted small">${IS_TOUCH ? t("dispatch_month_hint_touch") : t("dispatch_month_hint")}</p>`;
  board.querySelectorAll("[data-dglay]").forEach(b => b.addEventListener("click", () => {
    localStorage.setItem(DG_LAYOUT_KEY, b.dataset.dglay);
    renderMonthBoard();
  }));
  // THE WHOLE MONTH ON ONE SHEET. The board scrolls; paper does not, so the
  // printed matrix is laid out sideways and sized to the page — every engineer,
  // every day, nothing cropped at the fold.
  // A CELL OPENS; A VISIT MOVES. The month stays a count and two times until
  // it is asked — only the cell you open fetches its own visits, so the matrix
  // is as light collapsed as it was before.
  board.querySelectorAll(".dg-cell").forEach(td => {
    const open = () => toggleCell(td);
    td.addEventListener("click", (ev) => {
      if (ev.target.closest(".dg-pop")) return;   // clicks inside the list are its own
      open();
    });
    td.addEventListener("keydown", (ev) => { if (ev.key === "Enter") open(); });
    // Every cell is a place a visit can be dropped, including an empty one.
    td.addEventListener("dragover", (ev) => { ev.preventDefault(); td.classList.add("dg-over"); });
    td.addEventListener("dragleave", () => td.classList.remove("dg-over"));
    td.addEventListener("drop", async (ev) => {
      ev.preventDefault(); td.classList.remove("dg-over");
      let m;
      try { m = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch (e) { return; }
      if (!m || !m.visit) return;
      if (String(m.agent) === td.dataset.agent && m.date === td.dataset.date) return;
      await moveOneVisit(m.visit, td.dataset.agent, td.dataset.date);
    });
  });
}

// THE MONTH AS A SHEET OF PAPER — one landscape page carrying every engineer
// against every day of the month, with the same shading the screen uses and
// the totals down both edges. A PURE FUNCTION of the grid the server already
// sent, so it can be asked for a document and read in a test, with no printer
// anywhere near the machine.
function monthDocHtml(o) {
  const ar = LANG === "ar";
  const S = SETTINGS || {};
  const days = o.days || [];
  const engineers = o.engineers || [];
  const cells = {};
  (o.cells || []).forEach(c => { cells[c.agent_id + "|" + c.date] = c; });
  const byAgent = {}, byDay = {};
  let all = 0;
  (o.cells || []).forEach(c => {
    byAgent[c.agent_id] = (byAgent[c.agent_id] || 0) + c.count;
    byDay[c.date] = (byDay[c.date] || 0) + c.count;
    all += c.count;
  });
  // The day columns share whatever the names leave, so a 28-day month and a
  // 31-day month both fill the page instead of trailing off it.
  const dayW = ((100 - 15) / Math.max(1, days.length)).toFixed(3) + "%";
  const head = days.map(day => {
    const wd = dgWd(day);
    return `<th class="d${wd === "fri" ? " rest" : ""}"><i>${t("wdi_" + wd)}</i><br>${dgDayNum(day)}</th>`;
  }).join("");
  const rows = engineers.map(e => {
    const tds = days.map(day => {
      const c = cells[e.id + "|" + day];
      return `<td class="c l${dgBusy(c)}${dgWd(day) === "fri" ? " rest" : ""}">${c
        ? `<b>${c.count}</b><i>${dgHour(c.first)}–${dgHour(c.last)}</i>` : ""}</td>`;
    }).join("");
    return `<tr><th class="n">${esc(e.full_name)}<span>${byAgent[e.id] || 0}</span></th>${tds}</tr>`;
  }).join("");
  const feet = days.map(day => `<td class="s">${byDay[day] || 0}</td>`).join("");
  const scope = [o.agent ? o.agent.full_name : "", o.area ? areaLabel(o.area) : ""]
    .filter(Boolean).map(esc).join(" · ");
  return `<!doctype html><html dir="${ar ? "rtl" : "ltr"}"><head><meta charset="utf-8">
    <title>${esc(t("dg_month_sheet"))}</title><style>
    @page { size: A4 landscape; margin: 8mm; }
    body { font: 8.5px/1.25 -apple-system, "Segoe UI", Tahoma, sans-serif; color: #111; margin: 0; }
    header { display: flex; justify-content: space-between; align-items: flex-end;
             border-bottom: 1.5px solid #111; padding-bottom: 4px; margin-bottom: 5px; }
    header h1 { margin: 0; font-size: 12px; }
    header .meta { color: #555; font-size: 9px; text-align: ${ar ? "left" : "right"}; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
    th, td { border: .4px solid #b9b9b9; padding: .5px 1px; text-align: center; vertical-align: middle; }
    th.d { width: ${dayW}; font-size: 8px; font-weight: 600; background: #eef1f2; padding: 2px 0; }
    th.d i { font-style: normal; color: #666; font-size: 6.5px; }
    th.d.rest { background: #dfe4e6; }
    th.n { width: 15%; text-align: ${ar ? "right" : "left"}; font-size: 8.5px; font-weight: 600;
           padding: 1px 4px; white-space: nowrap; overflow: hidden; }
    th.n span { float: ${ar ? "left" : "right"}; color: #555; font-weight: 400; }
    td.c { height: 14px; }
    td.c b { display: block; font-size: 8.5px; line-height: 1; }
    td.c i { font-style: normal; font-size: 6px; color: #444; letter-spacing: -.02em;
             direction: ltr; unicode-bidi: isolate; }
    td.c.rest.l0 { background: #f3f5f6; }
    td.c.l1 { background: #e7f1f2; } td.c.l2 { background: #cfe4e6; }
    td.c.l3 { background: #b0d3d7; } td.c.l4 { background: #90c2c8; }
    td.s, tfoot th.n { background: #eef1f2; font-weight: 700; font-size: 8.5px; }
    footer { margin-top: 6px; color: #777; font-size: 7.5px;
             display: flex; justify-content: space-between; }
    @media print { * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; } }
    </style></head><body onload="window.print()">
    <header><h1>${esc(S.company_name || t("app_name"))} — ${esc(t("dg_month_sheet"))}</h1>
      <div class="meta">${esc(fmtDate(o.from))} → ${esc(fmtDate(o.to))}${scope ? ` · ${scope}` : ""}<br>
        ${t("dg_month_total").replace("{n}", all).replace("{m}", engineers.length)}</div>
    </header>
    <table><thead><tr><th class="n">${esc(t("dg_col_eng"))}</th>${head}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th class="n">${esc(t("total"))}<span>${all}</span></th>${feet}</tr></tfoot>
    </table>
    <footer><span>${esc(t("dg_sheet_key"))}</span><span>${esc(new Date().toLocaleString())}</span></footer>
    </body></html>`;
}

// THE BOARD, ON PAPER. Two sheets, because the board answers two questions and
// only one of them fits in a grid cell: HOW MUCH is each man carrying (the
// matrix — a whole month on one landscape page) and WHERE is he going. His
// words: "in live i can stop on it but in pdf i have to see the locations
// too". So the second sheet is every call of the period with its hour, its
// customer, its BRANCH and its patch, engineer by engineer — the same sheet
// the Calendar prints, fed from whatever the board is showing: this day, this
// week or this month, and the engineer and area the filters are set to.
async function dpPrintDialog() {
  const month = _dp.scope === "month";
  let from, to;
  if (month) {
    from = _dp.date.slice(0, 8) + "01";
    const d = new Date(from + "T00:00:00");
    to = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  } else {
    const days = dpDays();
    from = days[0];
    to = days[days.length - 1];
  }
  openModal(t("cal_print"), `<form id="dp-pf" class="form-grid">
      <div class="field full"><label>${t("dp_print_what")}</label>
        <select name="what">
          <option value="list">${t("dp_print_list")}</option>
          ${month ? `<option value="grid">${t("dp_print_grid")}</option>` : ""}
        </select></div>
      <div class="field full"><label style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" name="split" style="width:auto"${month ? " checked" : ""}>
        ${t("dp_print_split")}</label></div>
      <p class="muted small full">${esc(fmtDate(from))} → ${esc(fmtDate(to))}</p>
      <div class="modal-actions full">
        <button class="btn" type="submit" data-act="print">🖨 ${t("cal_print")}</button>
        <button class="btn secondary" type="submit" data-act="xlsx">⤓ ${t("export_excel")}</button>
        <button class="btn secondary" type="submit" data-act="csv">⤓ ${t("export_csv")}</button>
      </div>
    </form>`);
  // WHICH BUTTON WAS PRESSED. A form has one submit event however many buttons
  // it carries, so the pressed one is read from the submitter (and from the
  // last focused button on the browsers that do not report it).
  const pf = $("dp-pf");
  let act = "print";
  pf.querySelectorAll("[data-act]").forEach(b =>
    b.addEventListener("click", () => { act = b.dataset.act; }));
  pf.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const what = f.what.value, split = f.split.checked;
    const how = (ev.submitter && ev.submitter.dataset.act) || act;
    closeModal();
    const stem = (s) => String(s).replace(/\s+/g, "-");
    try {
      if (what === "grid") {
        const g = await dpGridForPrint(from, to);
        if (how === "print") return printHtmlDoc(monthDocHtml(g));
        return dpSaveRows(dpGridRows(g), `${stem(t("dg_month_sheet"))}-${from}_${to}`, how);
      }
      const data = await dpPrintData(from, to);
      if (!data) return alert(t("dp_print_empty"));
      if (how === "print") {
        return printHtmlDoc(scheduleDocHtml({ from, to, agents: data.agents,
          visits: data.visits, posts: data.posts, heading: t("dp_sheet_title"),
          note: data.scope, compact: !split }));
      }
      dpSaveRows(dpVisitRows(data, from, to),
                 `${stem(t("dp_sheet_title"))}-${from}_${to}`, how);
    } catch (e) { alert(e.message || t("error")); }
  });
}

// The matrix the month board already counted, unless the printer is asking for
// a period the board has not counted — then it asks the server for it.
async function dpGridForPrint(from, to) {
  let g = _dp.grid;
  if (!g || !g.days || !g.days.length || g.days[0] !== from || g.days[g.days.length - 1] !== to) {
    g = await API.get(`/dispatch/grid?from=${from}&to=${to}`
      + (_dp.agent ? `&agent=${_dp.agent}` : "") + (_dp.area ? `&area=${_dp.area}` : ""));
  }
  return { from, to, engineers: g.engineers, days: g.days, cells: g.cells,
           agent: (cache.agents || []).find(a => String(a.id) === String(_dp.agent)),
           area: (cache.areas || []).find(a => String(a.id) === String(_dp.area)) };
}

// Every call in the period, engineer by engineer, with where it is — the facts
// behind both the printed sheet and the downloaded one. Only the men who
// actually have work are included: a day's board would otherwise deal out
// twenty-five sheets saying "nothing".
async function dpPrintData(from, to) {
  const [vis, posts] = await Promise.all([
    API.get(`/visits?from=${from}&to=${to}` + (_dp.agent ? `&agent=${_dp.agent}` : "")),
    can("shifts.view") ? API.get("/fixed-assignments").catch(() => ({ items: [] }))
                       : Promise.resolve({ items: [] }),
  ]);
  let visits = Array.isArray(vis) ? vis : (vis.items || []);
  // The area filter is a promise the board makes; paper keeps it.
  if (_dp.area) visits = visits.filter(v => String(v.area_id || "") === String(_dp.area));
  let postList = (posts.items || []).filter(p =>
    (!_dp.area || String(p.area_id || "") === String(_dp.area))
    && (!_dp.agent || String(p.primary_agent_id) === String(_dp.agent)
        || String(p.relief_agent_id) === String(_dp.agent)));
  // Who gets a section: whoever holds work in the period. The name comes from
  // the engineer list when it is loaded and from the visit itself when it is
  // not, so a sheet never prints a bare id.
  const names = {};
  (cache.agents || []).forEach(a => { names[String(a.id)] = a.full_name; });
  const ids = [];
  const want = (id, fallback) => {
    if (!id) return;
    const k = String(id);
    if (_dp.agent && k !== String(_dp.agent)) return;
    if (!names[k]) names[k] = fallback || k;
    if (!ids.includes(k)) ids.push(k);
  };
  visits.forEach(v => want(v.agent_id, v.agent_name));
  postList.forEach(p => { want(p.primary_agent_id); want(p.relief_agent_id); });
  if (!ids.length) return null;
  const agents = ids.map(id => ({ id, full_name: names[id] }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  const scope = [
    _dp.area ? areaLabel((cache.areas || []).find(a => String(a.id) === String(_dp.area)) || {}) : "",
    _dp.shift ? shiftLabel(dpShiftType() || {}) : "",
  ].filter(Boolean).join(" · ");
  return { agents, visits, posts: postList, scope };
}

// THE SAME CALLS AS A TABLE. Print gives him paper; this gives him a file he
// can keep, sort and send — one row per call, with the branch on it. Fixed
// posts ride along, marked as what they are, exactly as they do on the sheet.
//
// Headings and rows are kept APART, as a list and a list of lists, rather than
// as objects keyed by heading: a day column called "1" would be a numeric key,
// and JavaScript quietly sorts those in front of every other key — which is how
// the first draft of this printed a month starting at the 1st and ending with
// the engineer's name.
function dpVisitRows(data, from, to) {
  const heads = [t("agent"), t("date"), t("weekday"), t("from"), t("to"),
                 t("customer"), t("location"), t("area"), t("status")];
  const days = [];
  for (let d = new Date(from + "T00:00:00"); ymd(d) <= to; d.setDate(d.getDate() + 1)) {
    days.push(ymd(new Date(d)));
  }
  const rows = [];
  data.agents.forEach(a => {
    const mine = data.visits.filter(v => String(v.agent_id || "") === String(a.id))
      .sort((x, y) => String(x.scheduled_start).localeCompare(String(y.scheduled_start)));
    days.forEach(iso => {
      const wd = t("wd_" + dgWd(iso));
      postsForDay(data.posts, a.id, iso).forEach(p => rows.push([
        a.full_name, iso, wd, p.from_time || "", p.to_time || "",
        p.client_en || "", p.site_name || "", areaOf(p) || "", t("fixed_post"),
      ]));
      mine.filter(v => (v.scheduled_start || "").slice(0, 10) === iso).forEach(v => rows.push([
        a.full_name, iso, wd,
        (v.scheduled_start || "").slice(11, 16), (v.scheduled_end || "").slice(11, 16),
        localized(v, "client") || "", v.site_name || v.location || "",
        localized(v, "area") || "", t("st_" + v.status) || v.status || "",
      ]));
    });
  });
  return { heads, rows };
}

// The matrix as a table: a row per engineer, a column per day, the counts as
// real numbers so a spreadsheet can add them up.
function dpGridRows(g) {
  const cells = {};
  (g.cells || []).forEach(c => { cells[c.agent_id + "|" + c.date] = c; });
  const days = g.days || [];
  const heads = [t("agent")].concat(days.map(d => String(dgDayNum(d))), [t("total")]);
  const rows = (g.engineers || []).map(e => {
    let total = 0;
    const counts = days.map(day => {
      const c = cells[e.id + "|" + day];
      total += c ? c.count : 0;
      return c ? c.count : 0;
    });
    return [e.full_name].concat(counts, [total]);
  });
  return { heads, rows };
}

// Saved the way every other export in the app is saved: a real .xlsx workbook
// (numbers stay numbers, Arabic survives) or plain CSV with the byte-order mark
// Excel wants. Both are built here rather than asked of the server, so the file
// is exactly what the sheet shows — same filters, same posts, same order.
function dpSaveRows(table, name, how) {
  if (!table.rows.length) return alert(t("dp_print_empty"));
  if (how === "csv") return saveBlob(tableToCsv(table), name + ".csv");
  saveBlob(tableToXlsx(table, t("dp_sheet_title")), name + ".xlsx");
}

function tableToCsv(table) {
  const q = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = [table.heads.map(q).join(",")]
    .concat(table.rows.map(r => r.map(q).join(","))).join("\r\n");
  // The BOM is what makes Excel read the Arabic instead of mojibake.
  return new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
}

// A minimal OOXML workbook — the same shape server.py's build_xlsx writes, in
// the browser, on top of the zip writer the report bundles already use.
function tableToXlsx(table, sheetName) {
  const col = (i) => { let n = "", x = i + 1;
    while (x) { const rem = (x - 1) % 26; n = String.fromCharCode(65 + rem) + n; x = Math.floor((x - 1) / 26); }
    return n; };
  const xesc = (v) => String(v).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  const cell = (ref, val) => (typeof val === "number" && isFinite(val))
    ? `<c r="${ref}"><v>${val}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xesc(val == null ? "" : val)}</t></is></c>`;
  const xml = ['<row r="1">' + table.heads.map((h, i) => cell(col(i) + "1", h)).join("") + "</row>"]
    .concat(table.rows.map((r, n) => `<row r="${n + 2}">`
      + r.map((v, i) => cell(col(i) + (n + 2), v)).join("") + "</row>"));
  const enc = new TextEncoder();
  const files = [
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + "</Types>"],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + "</Relationships>"],
    ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets><sheet name="${xesc(String(sheetName || "Export")).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + "</Relationships>"],
    ["xl/worksheets/sheet1.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + "<sheetData>" + xml.join("") + "</sheetData></worksheet>"],
  ].map(([name, data]) => ({ name, data: enc.encode(data) }));
  return new Blob([zipStore(files)],
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// Open a cell into the day's own visits — a compact list, fetched only when
// asked, each row draggable on its own.
async function toggleCell(td) {
  const openAlready = td.querySelector(".dg-pop");
  document.querySelectorAll(".dg-pop").forEach(p => p.remove());
  document.querySelectorAll(".dg-cell.dg-open").forEach(c => c.classList.remove("dg-open"));
  if (openAlready) return;
  td.classList.add("dg-open");
  const pop = document.createElement("div");
  pop.className = "dg-pop";
  pop.innerHTML = `<div class="dg-pop-h">${t("loading")}</div>`;
  td.appendChild(pop);
  let d;
  try {
    d = await API.get(`/dispatch/cell?date=${td.dataset.date}&agent=${td.dataset.agent}`);
  } catch (e) { pop.innerHTML = `<div class="dg-pop-h">${esc(e.message || t("error"))}</div>`; return; }
  if (!d.visits.length) { pop.innerHTML = `<div class="dg-pop-h">${t("none")}</div>`; return; }
  pop.innerHTML = `<div class="dg-pop-h">${esc(fmtDate(d.date))}
      <button type="button" class="link-btn sm dg-openday">${t("open_day")}</button></div>
    ${d.visits.map(v => `<div class="dg-v b-${v.status}" draggable="true"
        data-visit="${v.id}" data-agent="${d.agent_id}" data-date="${d.date}"
        data-name="${esc(v.site_name)}" title="${esc(v.site_name)}">
        <span class="dg-v-t">${esc(v.time)}</span>
        <span class="dg-v-n">${esc(v.site_name)}</span>${IS_TOUCH
          ? `<button type="button" class="dp-move" aria-label="${t("move_visit")}"
              title="${t("move_visit")}">⇄</button>` : ""}</div>`).join("")}`;
  pop.querySelector(".dg-openday").addEventListener("click", (ev) => {
    ev.stopPropagation();
    navigate("dispatch", { date: td.dataset.date, scope: "day",
      shift: _dp.shift, area: _dp.area, agent: td.dataset.agent });
  });
  // The matrix scrolls inside its own box, so a list opened near an edge can
  // sit half outside it — bring it into view rather than leaving him to hunt.
  if (pop.scrollIntoView) pop.scrollIntoView({ block: "nearest", inline: "nearest" });
  pop.querySelectorAll(".dg-v").forEach(row => {
    row.addEventListener("click", (ev) => ev.stopPropagation());
    const mv = row.querySelector(".dp-move");
    if (mv) mv.addEventListener("click", (ev) => {
      ev.stopPropagation();
      dpMoveCellSheet(Number(row.dataset.visit), row.dataset.agent,
                      row.dataset.date, row.dataset.name);
    });
    row.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("text/plain", JSON.stringify(
        { visit: Number(row.dataset.visit), agent: row.dataset.agent, date: row.dataset.date }));
      ev.dataTransfer.effectAllowed = "move";
    });
  });
}

// One visit, to another engineer or another day. The server checks it against
// the planner's own rules and refuses with the real reason, so what the board
// allows is exactly what the roster would drive.
async function moveOneVisit(visitId, toAgent, toDate) {
  try {
    await API.post("/dispatch/move",
      { visit_ids: [visitId], agent_id: Number(toAgent), date: toDate });
    toast(t("moved_n").replace("{n}", 1));
    await renderBoard();
  } catch (e) {
    // THE REFUSAL IS THE USEFUL PART. It names the rule that stopped the move
    // — a patch he may not work, a door shut that day, another van already
    // there — so it is shown whole, not softened into "could not save".
    alert(e.message || t("error"));
  }
}

async function renderBoard() {
  const board = $("dp-board");
  if (!board) return;
  if (_dp.scope === "month") return renderMonthBoard();
  board.classList.remove("dg-month");
  board.innerHTML = `<div class="empty">${t("loading")}</div>`;
  const days = dpDays();
  const res = await API.get(`/visits?from=${days[0]}&to=${days[days.length - 1]}`);
  const items = Array.isArray(res) ? res : (res.items || []);
  const ty = dpShiftType();

  // Who gets a column. With a shift picked, only the people actually rostered
  // on it — for the chosen day, or anywhere in the week when the board spans
  // one. Otherwise every agent, as before.
  let people = (cache.agents || []).map(a => ({ id: String(a.id), name: a.full_name }));
  if (_dp.agent) people = people.filter(p => p.id === String(_dp.agent));
  _dp.windows = null;
  // The areas each engineer is rostered onto over the days on screen. A shift
  // with no area is not a restriction, so it contributes nothing here — an
  // engineer with only such shifts covers everywhere and never mismatches.
  _dp.areas = {};
  if (_dp.roster) {
    _dp.roster.shifts.forEach(sh => {
      if (!days.includes(sh.shift_date) || !sh.area_id) return;
      if (ty && String(sh.shift_type_id) !== String(ty.id)) return;
      const list = (_dp.areas[sh.agent_id] = _dp.areas[sh.agent_id] || []);
      if (!list.some(a => String(a.id) === String(sh.area_id))) {
        list.push({ id: sh.area_id, name: areaOf(sh) || "" });
      }
    });
  }
  if (ty && _dp.roster) {
    const onDays = {};          // agent -> the days they're on this shift
    const windows = {};         // agent|day -> the hours they actually work it
    _dp.roster.shifts.forEach(s => {
      if (String(s.shift_type_id) !== String(ty.id) || !days.includes(s.shift_date)) return;
      // An agent can hold the same shift twice in a day, so count each day once.
      const seen = (onDays[s.agent_id] = onDays[s.agent_id] || []);
      if (!seen.includes(s.shift_date)) seen.push(s.shift_date);
      const k = s.agent_id + "|" + s.shift_date;
      (windows[k] = windows[k] || []).push({ from: s.from_time, to: s.to_time });
    });
    _dp.windows = windows;
    people = _dp.roster.agents.filter(a => onDays[a.id])
      .map(a => ({ id: String(a.id), name: a.full_name, days: onDays[a.id] }));
  }

  // Narrowed to one area: only that area's work, and only the people who can
  // do it — whoever is rostered onto the area, plus anyone whose shifts tie
  // them to no area at all, since they are not restricted to anywhere.
  const inArea = (vi) => !_dp.area || String(vi.area_id || "") === String(_dp.area);
  if (_dp.area) {
    // Anyone already holding work in the area stays on the board even if they
    // are not rostered onto it — that job is precisely the one to look at, and
    // hiding the column would hide it.
    const holding = new Set(items.filter(vi => vi.agent_id && inArea(vi))
                                 .map(vi => String(vi.agent_id)));
    people = people.filter(pp => {
      const mine = _dp.areas[pp.id] || [];   // object keys are strings either way
      return !mine.length || holding.has(pp.id)
             || mine.some(a => String(a.id) === String(_dp.area));
    });
  }

  // The unassigned pile is filtered to the shift's hours, so picking "Morning"
  // shows the morning jobs still waiting next to the people working mornings.
  const unassigned = items.filter(vi => !vi.agent_id).filter(inArea)
    .filter(vi => !ty || inShiftWindow((vi.scheduled_start || "").slice(11, 16), ty.start_time, ty.end_time));

  // Kept so a drop can look a visit up by id without re-fetching the board.
  _dp.byId = {};
  items.forEach(vi => { _dp.byId[String(vi.id)] = vi; });
  const cols = [{ id: "", name: "🚩 " + t("unassigned_visits") }].concat(people);
  const byAgent = { "": unassigned };
  people.forEach(c => { byAgent[c.id] = []; });
  items.forEach(vi => {
    if (!vi.agent_id || !inArea(vi)) return;
    const k = String(vi.agent_id);
    if (byAgent[k]) byAgent[k].push(vi);
  });
  Object.values(byAgent).forEach(list =>
    list.sort((a, b) => (a.scheduled_start || "").localeCompare(b.scheduled_start || "")));

  if (!people.length && (ty || _dp.area)) {
    board.innerHTML = `<div class="empty">${t(_dp.area && !ty ? "no_agents_in_area" : "no_agents_on_shift")}</div>`;
    return;
  }
  _dp.cols = cols;            // the phone's move sheet offers exactly these
  board.innerHTML = cols.map(c => dispatchColumn(c, byAgent[c.id] || [], ty)).join("");
  wireDispatchDnD();
}

function dispatchGeocoded(v) { return v.site_lat != null && v.site_lng != null ? true : !!parseLatLng(v.location); }

function dispatchColumn(col, list, ty) {
  const geo = list.filter(dispatchGeocoded).length;
  // Route optimization orders a single technician's day, so it only applies
  // when the board is showing one.
  const optBtn = (col.id && list.length > 1 && _dp.scope === "day")
    ? `<button class="btn secondary sm" data-optimize="${col.id}">🧭 ${t("optimize")}</button>` : "";
  // How many of the week's days this person is on the selected shift.
  const onNote = (col.days && _dp.scope === "week")
    ? `<span class="dp-shift-days">${col.days.length} ${t("days_on_shift")}</span>` : "";
  const areas = (col.id && _dp.areas) ? (_dp.areas[col.id] || []) : [];
  const areaNote = areas.length
    ? `<span class="dp-area">📌 ${areas.map(a => esc(a.name)).join(" · ")}</span>` : "";
  // Nothing to drop with on a phone, so an empty column says what it is.
  const cards = list.map(v => dispatchCard(v, ty)).join("")
    || `<div class="dp-empty">${IS_TOUCH ? t("none") : t("drop_here")}</div>`;
  return `<div class="dp-col"><div class="dp-col-head">
      <strong>${esc(col.name)}</strong>
      <span class="muted small">${list.length} · 📍${geo}/${list.length}</span>${onNote}${areaNote}${optBtn}</div>
    <div class="dp-col-body" data-agent="${col.id}">${cards}</div></div>`;
}

// Whether an engineer covers a visit's area on the days on screen. Unknown
// either way — the engineer has no area on their shift, or the visit's branch
// has none — is NOT a mismatch: an area nobody set is not a rule to break.
function areaMismatch(agentId, visit) {
  if (!agentId || !visit || !visit.area_id) return false;
  const covered = (_dp.areas || {})[agentId] || [];
  if (!covered.length) return false;
  return !covered.some(a => String(a.id) === String(visit.area_id));
}

function dispatchCard(v, ty) {
  const loc = v.site_name || v.location || "";
  const time = (v.scheduled_start || "").slice(11, 16);
  // Across a week the day matters as much as the time.
  const day = (_dp.scope === "week" && v.scheduled_start)
    ? new Date(v.scheduled_start.slice(0, 10) + "T00:00:00")
      .toLocaleDateString(LANG === "ar" ? "ar" : "en-GB", { weekday: "short", day: "numeric" }) : "";
  // Already-assigned work that sits outside the shift being dispatched. Judged
  // against the hours this agent actually works that day when we know them —
  // a trimmed 08:00–10:00 morning is stricter than Morning's standard hours.
  const wins = _dp.windows && _dp.windows[v.agent_id + "|" + (v.scheduled_start || "").slice(0, 10)];
  const out = ty && v.agent_id && (wins && wins.length
    ? !wins.some(w => inShiftWindow(time, w.from, w.to))
    : !inShiftWindow(time, ty.start_time, ty.end_time));
  const offArea = areaMismatch(String(v.agent_id || ""), v);
  const flags = [out ? t("outside_shift_hours") : "", offArea ? t("out_of_area") : ""].filter(Boolean).join(" · ");
  return `<div class="dp-card b-${v.status}${out ? " dp-out" : ""}${offArea ? " dp-off" : ""}" draggable="true" data-visit="${v.id}"
      ${flags ? `title="${esc(flags)}"` : ""}>
    <div class="dp-card-top"><span class="dp-time">${day ? esc(day) + " " : ""}${time || "—"}${out ? " ⏰" : ""}</span>
      <span class="badge b-${v.status}">${t(statusKey(v.status))}</span>${IS_TOUCH
        ? `<button type="button" class="dp-move" aria-label="${t("move_visit")}"
            title="${t("move_visit")}">⇄</button>` : ""}</div>
    <div class="dp-client">${esc(localized(v, "client"))}</div>
    ${loc ? `<div class="muted small">${dispatchGeocoded(v) ? "📍" : "⚠️"} ${esc(loc)}</div>` : ""}
    ${areaOf(v) ? `<div class="dp-card-area${offArea ? " dp-off-area" : ""}">${offArea ? "🚩" : "📌"} ${esc(areaOf(v))}</div>` : ""}</div>`;
}

function wireDispatchDnD() {
  let dragId = null;
  document.querySelectorAll(".dp-card").forEach(card => {
    card.addEventListener("dragstart", (e) => { dragId = card.dataset.visit; card.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("click", () => navigate("visit", { id: card.dataset.visit }));
  });
  document.querySelectorAll(".dp-col-body").forEach(body => {
    body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("dp-over"); });
    body.addEventListener("dragleave", () => body.classList.remove("dp-over"));
    body.addEventListener("drop", async (e) => {
      e.preventDefault(); body.classList.remove("dp-over");
      if (dragId == null) return;
      const id = dragId; dragId = null;
      await assignVisitTo(id, body.dataset.agent || null);
    });
  });
  // ⇄ on a card: the same move, made with one thumb (see dpMoveSheet).
  document.querySelectorAll(".dp-card .dp-move").forEach(b =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      dpMoveSheet(b.closest(".dp-card").dataset.visit);
    }));
  document.querySelectorAll("[data-optimize]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation(); optimizeRoute(b.dataset.optimize, _dp.date);
  }));
}

// Hand one visit to a column (an engineer, or "" for the unassigned pile).
// The drop and the phone's ⇄ both end here, so both get the out-of-area
// question, the double-booking check and the server's own refusal.
async function assignVisitTo(id, target) {
  // Handing a job to someone who isn't covering that area today is allowed
  // — a real day needs the exception — but it is never done by accident.
  if (target && areaMismatch(String(target), _dp.byId && _dp.byId[id])) {
    const v = _dp.byId[id];
    const covers = (_dp.areas[target] || []).map(a => a.name).join(" · ");
    if (!confirm(t("out_of_area_confirm")
          .replace("{visit}", areaOf(v))
          .replace("{covers}", covers))) { await renderBoard(); return; }
  }
  try {
    const saved = await postVisitWithConflictCheck({ agent_id: target || null }, id);
    if (!saved) return;
    if (handledOffline(saved)) return;
    await renderBoard(); loadSlaStrip();
  } catch (err) { alert(err.message); }
}

// A DRAG A THUMB CAN DO. HTML5 drag-and-drop never fires on a touch screen,
// which left the whole board unusable in the phone app. So on a phone every
// visit carries ⇄: it opens the board's OWN columns as a list, and picking one
// runs the drop's code unchanged. Desktop keeps the drag exactly as it was.
function dpMoveSheet(visitId) {
  const v = (_dp.byId || {})[String(visitId)];
  const cur = String((v && v.agent_id) || "");
  const cols = _dp.cols || [];
  openModal(t("move_visit"), `
    ${v ? `<p class="mv-what"><strong>${esc(localized(v, "client"))}</strong>${
      v.site_name ? ` <span class="muted">— ${esc(v.site_name)}</span>` : ""}</p>` : ""}
    <div class="mv-list">${cols.map(c => `<button type="button" class="mv-opt${
      String(c.id) === cur ? " mv-cur" : ""}" data-to="${c.id}">
        <span>${esc(c.name)}</span>${String(c.id) === cur
          ? `<span class="muted small">${t("move_current")}</span>` : ""}</button>`).join("")}</div>`,
    (body) => body.querySelectorAll(".mv-opt").forEach(b =>
      b.addEventListener("click", async () => {
        const to = b.dataset.to;
        closeModal();
        if (String(to) === cur) return;
        await assignVisitTo(String(visitId), to || null);
      })));
}

// The month moves a visit in two dimensions — another engineer, another day —
// so its sheet asks for both, then goes through the same /dispatch/move the
// drag used, rules and refusals included.
function dpMoveCellSheet(visitId, fromAgent, fromDate, name) {
  const eng = _dp.engineers || [];
  openModal(t("move_visit"), `
    ${name ? `<p class="mv-what"><strong>${esc(name)}</strong></p>` : ""}
    <div class="field"><label>${t("engineer")}</label>
      <select id="mv-eng">${eng.map(e => `<option value="${e.id}"${
        String(e.id) === String(fromAgent) ? " selected" : ""}>${esc(e.full_name)}</option>`).join("")}</select></div>
    <div class="field"><label>${t("date")}</label>
      <input type="date" id="mv-date" value="${fromDate}"></div>
    <div class="form-actions">
      <button type="button" class="btn secondary" id="mv-x">${t("cancel")}</button>
      <button type="button" class="btn" id="mv-go">${t("move_visit")}</button></div>`, () => {
    $("mv-x").addEventListener("click", closeModal);
    $("mv-go").addEventListener("click", async () => {
      const to = $("mv-eng").value, when = $("mv-date").value;
      if (!when) return;
      closeModal();
      if (String(to) === String(fromAgent) && when === fromDate) return;
      await moveOneVisit(visitId, to, when);
    });
  });
}

async function optimizeRoute(agentId, date) {
  let res;
  try { res = await API.post("/dispatch/optimize", { agent_id: agentId, date, apply: false }); }
  catch (err) { alert(err.message); return; }
  if (!res.order.length) { alert(t("no_visits_to_optimize")); return; }
  const orderList = res.order.map(o => `<li><strong>${(o.scheduled_start || "").slice(11, 16) || "—"}</strong> ${esc(localized(o, "client"))}${o.site_name ? ` <span class="muted">(${esc(o.site_name)})</span>` : ""}${o.lat == null ? " ⚠️" : ""}</li>`).join("");
  openModal(`🧭 ${t("optimize_route")}`, `
    <div class="opt-summary">
      <div><div class="muted small">${t("distance_before")}</div><strong>${res.km_before} km</strong></div>
      <div><div class="muted small">${t("distance_after")}</div><strong>${res.km_after} km</strong></div>
      <div class="opt-saved"><div class="muted small">${t("distance_saved")}</div><strong>${res.km_saved} km</strong></div>
    </div>
    ${res.ungeocoded ? `<p class="muted small">⚠️ ${res.ungeocoded} ${t("ungeocoded_note")}</p>` : ""}
    ${!res.has_start ? `<p class="muted small">${t("no_start_note")}</p>` : ""}
    <ol class="opt-order">${orderList}</ol>
    <div class="form-actions"><button type="button" class="btn secondary" id="opt-x">${t("cancel")}</button>
    <button type="button" class="btn" id="opt-apply">✅ ${t("apply_route")}</button></div>`, () => {
    $("opt-x").addEventListener("click", closeModal);
    $("opt-apply").addEventListener("click", async () => {
      try { await API.post("/dispatch/optimize", { agent_id: agentId, date, apply: true }); }
      catch (err) { alert(err.message); return; }
      closeModal(); await renderBoard(); toast(t("route_applied"));
    });
  });
}

// ====================================================================
// Visit requests — client self-service "request a visit" + staff inbox
// ====================================================================
async function viewRequests(v) {
  const isClient = role() === "client";
  const canAct = can("requests.edit");
  const rows = await API.get("/visit-requests");
  v.innerHTML = `<div class="page-head"><h2>${t("nav_requests")}</h2>
    ${can("requests.create") && isClient ? `<button class="btn" id="req-add">+ ${t("request_visit")}</button>` : ""}</div>
    <div class="panel" id="req-list">${requestsTable(rows, isClient, canAct)}</div>`;
  if ($("req-add")) $("req-add").addEventListener("click", requestForm);
  wireRequestRows(v);
}

function requestsTable(rows, isClient, canAct) {
  if (!rows.length) return `<div class="empty">${t("no_requests")}</div>`;
  const badge = s => `<span class="badge b-${s === "approved" ? "completed" : s === "declined" ? "cancelled" : "scheduled"}">${t("rq_" + s)}</span>`;
  const head = `<tr><th>${t("date_requested")}</th>${isClient ? "" : `<th>${t("client")}</th>`}<th>${t("location_lbl")}</th>
    <th>${t("preferred_date")}</th><th>${t("notes")}</th><th>${t("status")}</th><th></th></tr>`;
  const body = rows.map(r => `<tr>
    <td>${fmtDate(r.created_at)}</td>
    ${isClient ? "" : `<td>${esc(localized(r, "client"))}</td>`}
    <td>${esc(r.site_name || "—")}</td>
    <td>${r.preferred_date ? fmtDate(r.preferred_date) : "—"}</td>
    <td>${esc((r.note || "").slice(0, 60)) || "—"}</td>
    <td>${badge(r.status)}</td>
    <td>${(canAct && r.status === "pending")
      ? `${can("visits.create") ? `<button class="btn sm" data-approve="${r.id}">✅ ${t("approve")}</button> ` : ""}<button class="btn secondary sm" data-decline="${r.id}">${t("decline")}</button>`
      : (r.visit_id ? `<button class="link-btn sm" data-open="${r.visit_id}">${t("view")}</button>` : "")}</td>
  </tr>`).join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function wireRequestRows(root) {
  root.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => navigate("visit", { id: b.dataset.open })));
  root.querySelectorAll("[data-approve]").forEach(b => b.addEventListener("click", () => approveRequestDialog(b.dataset.approve)));
  root.querySelectorAll("[data-decline]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("confirm_decline"))) return;
    try { await API.post(`/visit-requests/${b.dataset.decline}/decline`, {}); navigate("requests"); }
    catch (e) { alert(e.message); }
  }));
}

async function requestForm() {
  const cid = API.user.client_id;
  openModal(`📨 ${t("request_visit")}`, `<form id="rqf">
    <div class="field"><label>${t("location_lbl")}</label><select name="site_id" id="rqf-site"><option value="">${t("loading")}…</option></select></div>
    ${field(t("preferred_date"), "preferred_date", { type: "date" })}
    ${field(t("notes"), "note", { textarea: true })}
    <div class="form-actions"><button type="button" class="btn secondary" id="rqf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("submit_request")}</button></div></form>`, async (root) => {
    $("rqf-x").addEventListener("click", closeModal);
    await loadSiteOptions(cid, $("rqf-site"), "", t("none"));
    root.querySelector("#rqf").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const saved = await API.post("/visit-requests", formData(root));
        if (handledOffline(saved)) return;
        closeModal(); toast(t("request_sent")); navigate("requests");
      } catch (err) { alert(err.message); }
    });
  });
}

function approveRequestDialog(id) {
  const agentOpts = [{ v: "", l: t("none") }].concat((cache.agents || []).map(a => ({ v: a.id, l: a.full_name })));
  const svcOpts = [{ v: "", l: t("none") }].concat((cache.services || []).map(s => ({ v: s.id, l: localized(s, "name") })));
  openModal(`✅ ${t("approve_request")}`, `<form id="apr"><div class="form-grid">
    ${dateTimeFields(t("scheduled_start"), "scheduled_start")}
    ${field(t("agent"), "agent_id", { options: agentOpts })}
    ${field(t("service"), "service_type_id", { options: svcOpts })}
    </div><p class="muted small">${t("approve_hint")}</p>
    <div class="form-actions"><button type="button" class="btn secondary" id="apr-x">${t("cancel")}</button>
    <button class="btn" type="submit">✅ ${t("approve")}</button></div></form>`, (root) => {
    $("apr-x").addEventListener("click", closeModal);
    wireTimeInputs(root);
    root.querySelector("#apr").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      d.scheduled_start = readDateTime(root, d, "scheduled_start");
      if (d.scheduled_start) d.scheduled_start = d.scheduled_start.replace("T", " ") + ":00";
      try { await API.post(`/visit-requests/${id}/approve`, d); closeModal(); toast(t("request_approved_msg")); navigate("requests"); }
      catch (err) { alert(err.message); }
    });
  });
}

// ====================================================================
// Agent "My Day" — today's route as an ordered list, with a map toggle
// ====================================================================
function coordsOf(v) {
  if (v.site_lat != null && v.site_lng != null) return [v.site_lat, v.site_lng];
  return parseLatLng(v.location);
}
function haversineKm(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLa = (b[0] - a[0]) * r, dLn = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function routeKmJs(pts) { let s = 0; for (let i = 0; i < pts.length - 1; i++) s += haversineKm(pts[i], pts[i + 1]); return s; }

// Capture the device GPS position (10s timeout). Resolves null when denied or
// unavailable so a check-in still goes through with just the timestamp.
function getGPS() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => res(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}
// Check the agent in/out of a visit (kind: "checkin" | "checkout"), stamping
// GPS + the tap time ("at" survives offline queueing so a replayed check-in
// keeps the real moment, not the sync moment).
async function doCheckin(visitId, kind) {
  const gps = await getGPS();
  if (!gps) toast(t("checkin_no_gps"));
  return API.post(`/visits/${visitId}/${kind}`, { ...(gps || {}), at: localStamp(new Date()) });
}

// ====================================================================
// ENGINEER AVAILABILITY — the whole team on one screen.
// The office was explicit that this must NOT be per-engineer: "make sure I
// give you all engineers and their available hours, not engineer one by one,
// to not be any mistakes in schedules." So the page loads everybody, is edited
// in place, and saves once. It is the input the automatic scheduler reads.
// ====================================================================
// The roster week runs Saturday-first; the STORED weekday is Python's Mon=0,
// and the two are only reconciled here, at the point of display.
const AVAIL_DAYS = [
  { wd: 5, k: "sat" }, { wd: 6, k: "sun" }, { wd: 0, k: "mon" }, { wd: 1, k: "tue" },
  { wd: 2, k: "wed" }, { wd: 3, k: "thu" }, { wd: 4, k: "fri" },
];

async function viewAvailability(v) {
  const d = await API.get("/agent-availability");
  const areas = d.areas || [];
  const zoneName = {};
  (d.zones || []).forEach(z => { zoneName[z.id] = localized(z, "name"); });
  // AREAS, GROUPED BY THE ZONE THEY BELONG TO, with one tick for the whole
  // zone. The owner: "i will assign a zone or a specific area." Twenty-eight
  // loose checkboxes per engineer is the thing that makes this board a chore;
  // a zone is how he thinks about the west of the city, and ticking it should
  // be one gesture. What is STORED is still the areas — the zone tick is a
  // shortcut, so nothing the planner reads changes shape, and it shows as
  // ticked again whenever every area under it is.
  const groups = [];
  (d.zones || []).forEach(z => {
    const mine = areas.filter(a => a.zone_id === z.id);
    if (mine.length) groups.push({ id: z.id, name: localized(z, "name"), areas: mine });
  });
  const loose = areas.filter(a => !a.zone_id || !zoneName[a.zone_id]);
  if (loose.length) groups.push({ id: null, name: t("zone_none"), areas: loose });
  const areaChecks = (e) => groups.map(g => {
    const on = new Set(e.area_ids || []);
    const all = g.areas.every(a => on.has(a.id));
    const head = g.id === null && groups.length === 1 ? "" : `<label class="chk-item av-zonehead">
        <input type="checkbox" class="av-zone" data-eng="${e.id}" data-zone="${g.id ?? ""}"${
          all ? " checked" : ""}${g.id === null ? " disabled" : ""}>
        <strong>${esc(g.name)}</strong></label>`;
    // WHICH DAYS he works each patch. Named days are the exception — a patch
    // that is a journey rather than a commute — so the row is only BUILT when
    // the area is ticked, and every day left blank means "any day he works".
    const named = e.area_days || {};
    return `<div class="av-zonegrp">${head}${g.areas.map(a => `<div class="av-areaitem">
        <label class="chk-item">
        <input type="checkbox" class="av-area" data-eng="${e.id}" data-zone="${g.id ?? ""}"
          value="${a.id}"${on.has(a.id) ? " checked" : ""}>
        <span>${esc(localized(a, "name"))}</span></label>
        <span class="av-areadays"${on.has(a.id) ? "" : ' style="display:none"'}
              title="${esc(t("area_days_hint"))}">${AVAIL_DAYS.map(x => `<label>
          <input type="checkbox" class="av-ad" data-eng="${e.id}" data-area="${a.id}"
            data-wd="${x.wd}"${(named[String(a.id)] || []).includes(x.wd) ? " checked" : ""}
            >${t("wd_" + x.k).slice(0, 2)}</label>`).join("")}</span>
        </div>`).join("")}</div>`;
  }).join("");
  // ONE ROW PER STRETCH HE WORKS. A man may work 08:00-12:00 and again
  // 16:00-20:00 with the middle of the day his own; the ordinary case is one
  // row and looks exactly as it always did.
  const hourRow = (eid, wd, win) => `<div class="av-win">
        <input type="text" class="av-from hhmm" data-eng="${eid}" data-wd="${wd}"
          maxlength="5" placeholder="${esc(t("any_time"))}" value="${esc((win && win.start_time) || "")}">
        <input type="text" class="av-to hhmm" data-eng="${eid}" data-wd="${wd}"
          maxlength="5" placeholder="${esc(t("any_time"))}" value="${esc((win && win.end_time) || "")}">
        <button type="button" class="btn-icon av-drop" data-eng="${eid}" data-wd="${wd}"
          title="${esc(t("remove_time"))}" aria-label="${esc(t("remove_time"))}">&times;</button>
      </div>`;
  const dayCells = (e) => AVAIL_DAYS.map(x => {
    const wins = (e.days && e.days[String(x.wd)]) || [];
    const on = wins.length > 0;
    return `<td class="av-day${on ? " av-on" : ""}">
      <label class="chk-item"><input type="checkbox" class="av-wd" data-eng="${e.id}"
        data-wd="${x.wd}"${on ? " checked" : ""}> ${t("wd_" + x.k)}</label>
      <div class="av-hours"${on ? "" : ' style="display:none"'}>
        <div class="av-wins" data-eng="${e.id}" data-wd="${x.wd}">${
          (on ? wins : [null]).map(w => hourRow(e.id, x.wd, w)).join("")}</div>
        <button type="button" class="btn-link av-add" data-eng="${e.id}"
          data-wd="${x.wd}">+ ${esc(t("add_time"))}</button>
      </div></td>`;
  }).join("");
  const rows = d.engineers.map(e => `<tr data-row="${e.id}">
      <td><strong>${esc(e.full_name)}</strong>${SUPERVISOR_ROLES.includes(e.role)
        ? ` <span class="badge">${t("role_" + e.role)}</span>` : ""}
        <div class="av-areas"><div class="muted small">${t("areas_allowed")}</div>
          <div class="chk-grid">${areaChecks(e)}</div></div></td>
      ${dayCells(e)}</tr>`).join("");
  v.innerHTML = `<div class="page-head"><h2>${t("nav_availability")}</h2>
      <button class="btn" id="av-save">${t("save")}</button></div>
    <p class="muted small">${t("availability_hint")}</p>
    ${!areas.length ? `<div class="empty">${t("no_areas_yet")}</div>` : ""}
    <div class="panel"><table class="av-table"><thead><tr><th>${t("agent")}</th>
      ${AVAIL_DAYS.map(x => `<th>${t("wd_" + x.k)}</th>`).join("")}</tr></thead>
      <tbody>${rows || `<tr><td colspan="8" class="empty">${t("no_agents_to_roster")}</td></tr>`}</tbody>
      </table></div>
    <div class="form-actions"><button class="btn" id="av-save2">${t("save")}</button></div>`;
  // (the hour boxes are wired per row, in wireWindowRow below, so a row added
  //  later behaves exactly like the ones that came with the page)
  // A zone tick is every area under it; unticking one area lets the zone go.
  v.addEventListener("change", (e) => {
    const z = e.target.closest(".av-zone");
    if (z) {
      v.querySelectorAll(
        `.av-area[data-eng="${z.dataset.eng}"][data-zone="${z.dataset.zone}"]`)
        .forEach(cb => {
          cb.checked = z.checked;
          const days = cb.closest(".av-areaitem") &&
                       cb.closest(".av-areaitem").querySelector(".av-areadays");
          if (days) {
            days.style.display = z.checked ? "" : "none";
            if (!z.checked) days.querySelectorAll("input").forEach(x => { x.checked = false; });
          }
        });
      return;
    }
    const a = e.target.closest(".av-area");
    if (!a) return;
    // Ticking a patch reveals its days; untick it and any days named for it go
    // with it, so nothing is left pointing at a patch he no longer works.
    const item = a.closest(".av-areaitem");
    if (item) {
      const days = item.querySelector(".av-areadays");
      if (days) {
        days.style.display = a.checked ? "" : "none";
        if (!a.checked) days.querySelectorAll("input").forEach(cb => { cb.checked = false; });
      }
    }
    if (!a.dataset.zone) return;
    const peers = [...v.querySelectorAll(
      `.av-area[data-eng="${a.dataset.eng}"][data-zone="${a.dataset.zone}"]`)];
    const head = v.querySelector(
      `.av-zone[data-eng="${a.dataset.eng}"][data-zone="${a.dataset.zone}"]`);
    if (head) head.checked = peers.every(cb => cb.checked);
  });
  // Ticking a day reveals its hours; leaving them blank means "all day", which
  // is the normal case for a company that does not clock its people.
  v.querySelectorAll(".av-wd").forEach(cb => cb.addEventListener("change", () => {
    const cell = cb.closest(".av-day");
    cell.classList.toggle("av-on", cb.checked);
    cell.querySelector(".av-hours").style.display = cb.checked ? "" : "none";
  }));
  // ADD ANOTHER STRETCH, or take one away. The last row never disappears —
  // a worked day with no hours at all means "any hour", which is what an
  // empty pair has always meant.
  v.querySelectorAll(".av-add").forEach(b => b.addEventListener("click", () => {
    const box = v.querySelector(
      `.av-wins[data-eng="${b.dataset.eng}"][data-wd="${b.dataset.wd}"]`);
    if (!box || box.querySelectorAll(".av-win").length >= 6) return;
    const row = box.lastElementChild.cloneNode(true);
    row.querySelectorAll("input").forEach(i => { i.value = ""; });
    box.appendChild(row);
    wireWindowRow(row);
  }));
  const wireWindowRow = (row) => {
    // TYPE 1, GET 01:00 — in every row, not just the first. The page used to
    // tidy the hours once, at render, so a stretch added afterwards had no
    // handler on it and the office had to type the full "01:00" by hand.
    // Wiring the row itself covers the ones that were there and the ones added.
    wireTimeInputs(row);
    const x = row.querySelector(".av-drop");
    if (x) x.addEventListener("click", () => {
      const box = row.parentElement;
      if (box.querySelectorAll(".av-win").length > 1) row.remove();
      else row.querySelectorAll("input").forEach(i => { i.value = ""; });
    });
  };
  v.querySelectorAll(".av-win").forEach(wireWindowRow);
  const save = async () => {
    // One payload for everybody — the whole point of the screen.
    const people = d.engineers.map(e => {
      const days = {};
      v.querySelectorAll(`.av-wd[data-eng="${e.id}"]`).forEach(cb => {
        if (!cb.checked) return;
        const wd = cb.dataset.wd;
        // Every stretch typed for that day, in the order they appear.
        const wins = [...v.querySelectorAll(
          `.av-wins[data-eng="${e.id}"][data-wd="${wd}"] .av-win`)].map(row => ({
            start_time: normHHMM(row.querySelector(".av-from").value) || null,
            end_time: normHHMM(row.querySelector(".av-to").value) || null,
          }));
        days[wd] = wins.length ? wins : [{ start_time: null, end_time: null }];
      });
      // Only patches with days actually ticked are sent; anything else means
      // "any day he works", which is stored as nothing at all.
      const areaDays = {};
      [...v.querySelectorAll(`.av-ad[data-eng="${e.id}"]:checked`)].forEach(c => {
        (areaDays[c.dataset.area] = areaDays[c.dataset.area] || []).push(Number(c.dataset.wd));
      });
      return {
        id: e.id,
        area_ids: [...v.querySelectorAll(`.av-area[data-eng="${e.id}"]:checked`)]
          .map(c => Number(c.value)),
        area_days: areaDays,
        days,
      };
    });
    try {
      const saved = await API.put("/agent-availability", { engineers: people });
      if (handledOffline(saved)) return;
      toast(t("saved"));
    } catch (err) { alert(err.message); }
  };
  $("av-save").addEventListener("click", save);
  $("av-save2").addEventListener("click", save);
}

// ====================================================================
// BRANCH SCHEDULE BOARD — when every branch opens, on one screen.
// The mirror of the availability board, for the customer's side of the
// appointment. The office has ~150 branches and the alternative is opening a
// dialog for each, which is the very thing they asked to escape. So: one row
// per branch, one save, a "fill all shown" for the common case where a whole
// area keeps the same hours, and a filter that scopes both.
// ====================================================================
// FIXED ASSIGNMENTS / RESIDENT POSTS. Hours the company has already sold to
// one site — a man resident at a factory all day. Deliberately NOT the
// availability board: availability is when a man CAN work, a post is time
// already spoken for, and the roster subtracts the second from the first
// before it places anything.
async function viewFixedPosts(v) {
  const [d, agents, siteRows] = await Promise.all([
    API.get("/fixed-assignments"), API.get("/agents"), API.get("/sites"),
  ]);
  // THE BRANCHES COME FROM /sites, which carries its customer's name with it.
  // (The customer list does NOT carry its branches, which is why this picker
  // was empty and offered nothing but "none".)
  const sites = (Array.isArray(siteRows) ? siteRows : siteRows.items || [])
    .filter(x => x.status !== "inactive" && x.client_status !== "inactive")
    .map(x => ({ id: x.id,
                 name: `${localized({ name_en: x.client_en, name_ar: x.client_ar }, "name")} — ${x.name}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const WD = [{ w: 5, k: "sat" }, { w: 6, k: "sun" }, { w: 0, k: "mon" },
              { w: 1, k: "tue" }, { w: 2, k: "wed" }, { w: 3, k: "thu" },
              { w: 4, k: "fri" }];
  const dayNames = (list) => (list || []).length
    ? WD.filter(x => list.includes(x.w)).map(x => t("wd_" + x.k)).join(" ") : "—";
  const rows = (d.items || []).map(p => `<tr data-id="${p.id}">
      <td><strong>${esc(p.site_name)}</strong><div class="muted small">${esc(localized(p, "client"))}</div></td>
      <td>${esc(p.primary_name || "—")}<div class="muted small">${esc(dayNames(p.primary_weekdays))}</div></td>
      <td>${esc(p.relief_name || "—")}<div class="muted small">${esc(dayNames(p.relief_weekdays))}</div></td>
      <td class="num">${esc(p.from_time)}–${esc(p.to_time)}</td>
      <td class="muted small">${esc(p.start_date || "—")} → ${esc(p.end_date || "—")}</td>
      <td>${p.active ? `<span class="badge">${t("active")}</span>`
                     : `<span class="badge muted">${t("inactive")}</span>`}</td>
      <td class="row-actions"><button class="btn secondary sm fp-edit">${t("edit")}</button>
        <button class="btn danger sm fp-del">${t("delete")}</button></td></tr>`).join("");
  v.innerHTML = `<div class="page-head"><h2>${t("nav_fixedposts")}</h2>
      <button class="btn" id="fp-new">${t("add")}</button></div>
    <p class="muted small">${t("fixedposts_hint")}</p>
    <div class="table-scroll"><table class="table">
      <thead><tr><th>${t("location")}</th><th>${t("fp_primary")}</th><th>${t("fp_relief")}</th>
        <th>${t("hours")}</th><th>${t("fp_period")}</th><th>${t("status")}</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7" class="muted">${t("none")}</td></tr>`}</tbody>
    </table></div>`;

  const form = (p) => {
    const pick = (name, list, sel) => `<select name="${name}">
        <option value="">${t("none")}</option>
        ${list.map(x => `<option value="${x.id}"${String(x.id) === String(sel) ? " selected" : ""}>${
          esc(x.name || x.full_name)}</option>`).join("")}</select>`;
    const days = (name, on) => `<div class="chk-grid">${WD.map(x =>
      `<label class="chk-item"><input type="checkbox" name="${name}" value="${x.w}"${
        (on || []).includes(x.w) ? " checked" : ""}> ${t("wd_" + x.k)}</label>`).join("")}</div>`;
    openModal(p ? t("edit") : t("add"), `<form id="fp-form" class="form-grid">
        <label>${t("location")}${pick("site_id", sites, p && p.site_id)}</label>
        <label>${t("fp_primary")}${pick("primary_agent_id", agents, p && p.primary_agent_id)}</label>
        <label>${t("fp_days")}${days("primary_weekdays", p && p.primary_weekdays)}</label>
        <label>${t("fp_relief")}${pick("relief_agent_id", agents, p && p.relief_agent_id)}</label>
        <label>${t("fp_relief_days")}${days("relief_weekdays", p && p.relief_weekdays)}</label>
        <label>${t("from")}<input name="from_time" class="hhmm" maxlength="5"
          value="${esc((p && p.from_time) || "")}" placeholder="08:00"></label>
        <label>${t("to")}<input name="to_time" class="hhmm" maxlength="5"
          value="${esc((p && p.to_time) || "")}" placeholder="16:00"></label>
        <label>${t("fp_start")}<input type="date" name="start_date" value="${esc((p && p.start_date) || "")}"></label>
        <label>${t("fp_end")}<input type="date" name="end_date" value="${esc((p && p.end_date) || "")}"></label>
        <label class="chk-item"><input type="checkbox" name="active"${
          !p || p.active ? " checked" : ""}> ${t("active")}</label>
        <div class="modal-actions"><button class="btn" type="submit">${t("save")}</button></div>
      </form>`);
    $("fp-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const picked = (name) => [...f.querySelectorAll(`input[name="${name}"]:checked`)]
        .map(x => Number(x.value));
      const body = {
        site_id: Number(f.site_id.value) || null,
        primary_agent_id: Number(f.primary_agent_id.value) || null,
        relief_agent_id: Number(f.relief_agent_id.value) || null,
        primary_weekdays: picked("primary_weekdays"),
        relief_weekdays: picked("relief_weekdays"),
        from_time: normHHMM(f.from_time.value) || null,
        to_time: normHHMM(f.to_time.value) || null,
        start_date: f.start_date.value || null,
        end_date: f.end_date.value || null,
        active: f.active.checked ? 1 : 0,
      };
      try {
        if (p) await API.put(`/fixed-assignments/${p.id}`, body);
        else await API.post("/fixed-assignments", body);
        closeModal(); toast(t("saved")); navigate("fixedposts");
      } catch (e) { alert(e.message || t("error")); }
    });
  };
  $("fp-new").addEventListener("click", () => form(null));
  v.querySelectorAll(".fp-edit").forEach(b => b.addEventListener("click", () =>
    form((d.items || []).find(x => String(x.id) === b.closest("tr").dataset.id))));
  v.querySelectorAll(".fp-del").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("confirm_delete"))) return;
    try {
      await API.del(`/fixed-assignments/${b.closest("tr").dataset.id}`);
      toast(t("deleted")); navigate("fixedposts");
    } catch (e) { alert(e.message || t("error")); }
  }));
}

async function viewBranchSchedule(v) {
  const d = await API.get("/branch-schedule");
  // The board carries its own engineer list; seed the shared cache from it so
  // `agentOptions` works here without a second round trip.
  cache.rosterAgents = d.engineers || cache.rosterAgents || [];
  const branches = d.branches || [];
  const areas = d.areas || [];
  const slotDefault = d.slot_minutes || 60;   // what a branch that says nothing gets
  // Branches whose contract asks for a different rhythm than the roster is
  // being told. Servicing one of these to the letter can still read as a
  // breach, so they are worth finding before the week is planned.
  const mismatched = branches.filter(b => b.freq_mismatch);
  // Branches the field has actually timed, where the schedule's guess is off
  // by a quarter of an hour or more.
  const mistimed = branches.filter(b => b.length_mismatch);
  // Branches below what their cycle owes for a month the roster has covered.
  const shorted = branches.filter(b => b.gap_missing);
  const dirty = new Set();
  // The companies actually present in the book, so a big customer's branches
  // can be worked through together — most offices think "Carrefour", not "Maadi".
  const clientList = [...new Map(branches.map(b =>
    [b.client_id, { id: b.client_id, name: localized(b, "client") }])).values()]
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const areaOpts = (sel) => `<option value="">${t("area_none")}</option>` + areas.map(a =>
    `<option value="${a.id}"${String(sel) === String(a.id) ? " selected" : ""}>${
      esc(localized(a, "name"))}</option>`).join("");
  // Hour boxes are only CREATED for days already ticked. With 150 branches a
  // full grid is 2,000+ inputs and the page crawls on a phone; the rest are
  // built the moment a day is ticked.
  const hoursHTML = (sid, wd, day) => `<input type="text" class="bs-from hhmm" data-b="${sid}"
      data-wd="${wd}" maxlength="5" value="${esc((day && day.start_time) || "")}">
    <input type="text" class="bs-to hhmm" data-b="${sid}" data-wd="${wd}"
      maxlength="5" value="${esc((day && day.end_time) || "")}">`;
  const rowHTML = (b) => {
    const open = {};
    (b.service_days || []).forEach(x => { open[x.weekday] = x; });
    const cells = AVAIL_DAYS.map(x => {
      const on = open[x.wd];
      return `<td class="bs-day${on ? " bs-on" : ""}" data-wd="${x.wd}">
        <label class="chk-item"><input type="checkbox" class="bs-wd" data-b="${b.id}"
          data-wd="${x.wd}"${on ? " checked" : ""}> ${t("wd_" + x.k)}</label>
        <div class="bs-hours"${on ? "" : ' style="display:none"'}>${
          on ? hoursHTML(b.id, x.wd, on) : ""}</div></td>`;
    }).join("");
    return `<tr data-b="${b.id}" data-area="${b.area_id || ""}" data-client="${b.client_id || ""}">
      <td><strong>${esc(b.name)}</strong><div class="muted small">${esc(localized(b, "client"))}</div></td>
      <td><select class="bs-area" data-b="${b.id}">${areaOpts(b.area_id)}</select></td>
      <td><input type="text" class="bs-sfrom hhmm" data-b="${b.id}" maxlength="5"
        placeholder="${esc(t("any_time"))}" value="${esc(b.service_from || "")}"></td>
      <td><input type="text" class="bs-sto hhmm" data-b="${b.id}" maxlength="5"
        placeholder="${esc(t("any_time"))}" value="${esc(b.service_to || "")}"></td>
      <td><input type="number" class="bs-vpm" data-b="${b.id}"
        min="0" max="56" step="0.5" value="${freqValue(b)}">${b.freq_mismatch
          ? `<button type="button" class="link-btn sm bs-adopt" data-b="${b.id}"
               data-vpm="${b.contract_vpm}" title="${esc(t("contract_says")
               .replace("{f}", t("freq_" + b.contract_freq) || b.contract_freq)
               .replace("{n}", b.contract_vpm))}">⚠️ ${b.contract_vpm}</button>` : ""}${
        b.gap_missing ? `<span class="bs-gap" title="${esc(gapLine(
             { missing: b.gap_missing, scheduled: b.gap_scheduled, owed: b.gap_owed })
             + " " + t("gap_month_of").replace("{m}", gapMonthLabel(b.gap_month)))
          }">⚠️ ${b.gap_scheduled}/${b.gap_owed}</span>` : ""}</td>
      <td><select class="bs-agent" data-b="${b.id}">${
        agentOptions(b.preferred_agent_id, t("agent_any"))}</select></td>
      <td><input type="number" class="bs-mins" data-b="${b.id}" min="10" max="480" step="5"
        placeholder="${slotDefault}" value="${b.visit_minutes ?? ""}">${b.length_mismatch
          ? `<button type="button" class="link-btn sm bs-measured" data-b="${b.id}"
               data-mins="${b.measured_minutes}" title="${esc(t("measured_says")
               .replace("{n}", b.measured_minutes).replace("{v}", b.measured_visits))}"
             >📏 ${b.measured_minutes}</button>` : ""}</td>
      ${cells}</tr>`;
  };
  v.innerHTML = `<div class="page-head"><h2>${t("nav_branch_schedule")}</h2>
      <button class="btn" id="bs-save">${t("save")}</button></div>
    <p class="muted small">${t("branch_schedule_hint")}</p>
    <div id="bs-cap"></div>
    <div class="toolbar">
      <label>${t("area")}: <select id="bs-filter"><option value="">${t("all_areas")}</option>
        ${areas.map(a => `<option value="${a.id}">${esc(localized(a, "name"))}</option>`).join("")}
        <option value="none">${t("area_none")}</option></select></label>
      <label>${t("client")}: <select id="bs-client"><option value="">${t("all_clients")}</option>
        ${clientList.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
        </select></label>
      <input id="bs-q" type="search" placeholder="${t("search")}…" style="max-width:240px">
      <button class="btn secondary sm" id="bs-fill">${t("fill_all_shown")}</button>
      <button class="btn secondary sm" id="bs-import">⬆️ ${t("import_branches")}</button>
      ${mismatched.length ? `<button class="btn secondary sm" id="bs-mismatch">⚠️ ${
        t("freq_mismatch_n").replace("{n}", mismatched.length)}</button>` : ""}
      ${mistimed.length ? `<button class="btn secondary sm" id="bs-mistimed">📏 ${
        t("length_mismatch_n").replace("{n}", mistimed.length)}</button>` : ""}
      ${shorted.length ? `<button class="btn secondary sm" id="bs-shorted">⚠️ ${
        t("gap_chip").replace("{n}", shorted.reduce((n, b) => n + b.gap_missing, 0))
        }</button>` : ""}
      <span class="muted small" id="bs-count"></span></div>
    <div class="panel bs-wrap">
      <!-- A rail carrying the SAME scroll position as the table, sitting above
           it. The board is wider than any laptop, and the only scrollbar was
           the page's own — at the very bottom of a 200-branch page, which is a
           long way to go to see Thursday. -->
      <div class="bs-rail" id="bs-rail"><div class="bs-rail-inner" id="bs-rail-in"></div></div>
      <table class="bs-table"><thead><tr>
      <th>${t("site_name")}</th><th>${t("area")}</th><th>${t("service_from")}</th>
      <th>${t("service_to")}</th><th>${t("visits_per_month")}</th>
      <th>${t("preferred_agent")}</th>
      <th>${t("visit_minutes")}</th>
      ${AVAIL_DAYS.map(x => `<th>${t("wd_" + x.k)}</th>`).join("")}</tr></thead>
      <tbody id="bs-body">${branches.map(rowHTML).join("")
        || `<tr><td colspan="13" class="empty">${t("none")}</td></tr>`}</tbody></table></div>
      <div class="bs-hint muted small">${t("bs_scroll_hint")}</div></div>
    <div class="form-actions"><button class="btn" id="bs-save2">${t("save")}</button></div>`;
  loadCapacity();
  wireTimeInputs(v);
  wireBoardScroll(v);
  const rows = () => [...v.querySelectorAll("#bs-body tr[data-b]")];
  const shown = () => rows().filter(r => r.style.display !== "none");
  const mark = (el) => { const id = el.dataset.b || el.closest("tr[data-b]").dataset.b; dirty.add(String(id)); };
  const count = () => { $("bs-count").textContent = `${shown().length} / ${rows().length}`; };

  // Ticking a day reveals its hours, building the boxes the first time.
  v.addEventListener("change", (e) => {
    const cb = e.target.closest(".bs-wd");
    if (!cb) return;
    const cell = cb.closest(".bs-day");
    const box = cell.querySelector(".bs-hours");
    if (cb.checked && !box.children.length) {
      box.innerHTML = hoursHTML(cb.dataset.b, cb.dataset.wd, null);
      wireTimeInputs(box);
    }
    cell.classList.toggle("bs-on", cb.checked);
    box.style.display = cb.checked ? "" : "none";
    mark(cb);
  });
  v.addEventListener("input", (e) => { if (e.target.closest("#bs-body")) mark(e.target); });
  // A <select> fires `change`, not `input` — the area picker is caught by the
  // day handler above, and the unit picker needs the same.
  v.addEventListener("change", (e) => {
    if (e.target.closest(".bs-area") || e.target.closest(".bs-agent")) mark(e.target);
  });

  const applyFilter = () => {
    const a = $("bs-filter").value, c = $("bs-client").value;
    const q = ($("bs-q").value || "").toLowerCase();
    rows().forEach(r => {
      const okA = !a || (a === "none" ? !r.dataset.area : r.dataset.area === a);
      const okC = !c || r.dataset.client === c;
      const okQ = !q || r.innerText.toLowerCase().includes(q);
      r.style.display = (okA && okC && okQ) ? "" : "none";
    });
    count();
  };
  $("bs-filter").addEventListener("change", applyFilter);
  $("bs-client").addEventListener("change", applyFilter);
  if ($("bs-mismatch")) $("bs-mismatch").addEventListener("click", () => {
    const bad = new Set(mismatched.map(b => String(b.id)));
    rows().forEach(r => { r.style.display = bad.has(r.dataset.b) ? "" : "none"; });
    count();
  });
  if ($("bs-mistimed")) $("bs-mistimed").addEventListener("click", () => {
    const bad = new Set(mistimed.map(b => String(b.id)));
    rows().forEach(r => { r.style.display = bad.has(r.dataset.b) ? "" : "none"; });
    count();
  });
  if ($("bs-shorted")) $("bs-shorted").addEventListener("click", () => {
    const bad = new Set(shorted.map(b => String(b.id)));
    rows().forEach(r => { r.style.display = bad.has(r.dataset.b) ? "" : "none"; });
    count();
  });
  // One click takes the contract's word for it — the commonest fix by far.
  v.addEventListener("click", (e) => {
    const m = e.target.closest(".bs-measured");
    if (m) {
      const r = v.querySelector(`#bs-body tr[data-b="${m.dataset.b}"]`);
      r.querySelector(".bs-mins").value = m.dataset.mins;
      dirty.add(String(m.dataset.b));
      m.remove();
      return;
    }
    const b = e.target.closest(".bs-adopt");
    if (!b) return;
    const r = v.querySelector(`#bs-body tr[data-b="${b.dataset.b}"]`);
    // The contract speaks in months, and so does the board.
    r.querySelector(".bs-vpm").value = b.dataset.vpm;
    dirty.add(String(b.dataset.b));
    b.remove();
  });
  $("bs-q").addEventListener("input", applyFilter);
  count();

  // The bulk gesture: whatever is on screen gets the same window, days and
  // frequency. It touches ONLY the visible rows — filter to an area first and
  // the rest of the book is untouched.
  $("bs-fill").addEventListener("click", () => {
    const target = shown();
    if (!target.length) return;
    fillBranchesDialog(target.length, (vals) => {
      target.forEach(r => {
        const id = r.dataset.b;
        if (vals.from != null) r.querySelector(".bs-sfrom").value = vals.from;
        if (vals.to != null) r.querySelector(".bs-sto").value = vals.to;
        if (vals.vpm != null) r.querySelector(".bs-vpm").value = vals.vpm;
        if (vals.mins != null) r.querySelector(".bs-mins").value = vals.mins;
        if (vals.days) {
          r.querySelectorAll(".bs-wd").forEach(cb => {
            const want = vals.days.includes(Number(cb.dataset.wd));
            if (cb.checked !== want) { cb.checked = want; cb.dispatchEvent(new Event("change", { bubbles: true })); }
          });
        }
        dirty.add(String(id));
      });
      toast(t("filled_n").replace("{n}", target.length));
    });
  });

  const save = async () => {
    // Only what was actually touched is sent — a save of two edits must not
    // rewrite 150 rows and bury the audit trail.
    const payload = [...dirty].map(id => {
      const r = v.querySelector(`#bs-body tr[data-b="${id}"]`);
      if (!r) return null;
      const days = [...r.querySelectorAll(".bs-wd:checked")].map(cb => {
        const wd = cb.dataset.wd;
        const pick = (sel) => {
          const el = r.querySelector(`${sel}[data-wd="${wd}"]`);
          return el ? (normHHMM(el.value) || null) : null;
        };
        return { weekday: Number(wd), start_time: pick(".bs-from"), end_time: pick(".bs-to") };
      });
      return {
        id: Number(id),
        area_id: r.querySelector(".bs-area").value || null,
        service_from: normHHMM(r.querySelector(".bs-sfrom").value) || null,
        service_to: normHHMM(r.querySelector(".bs-sto").value) || null,
        ...freqBody(r.querySelector(".bs-vpm").value || 0),
        visit_minutes: r.querySelector(".bs-mins").value || 0,
        preferred_agent_id: r.querySelector(".bs-agent").value || null,
        service_days: days,
      };
    }).filter(Boolean);
    if (!payload.length) { toast(t("nothing_to_save")); return; }
    try {
      const res = await API.put("/branch-schedule", { branches: payload });
      if (handledOffline(res)) return;
      dirty.clear();
      toast(t("saved_n").replace("{n}", res.saved));
    } catch (err) { alert(err.message); }
  };
  $("bs-save").addEventListener("click", save);
  $("bs-save2").addEventListener("click", save);
  $("bs-import").addEventListener("click", () => importBranchesDialog(
    () => navigate("branchsched")));
}

// Taking the branch list from a spreadsheet. The office types this list once,
// in Excel, long before the CRM sees it — so the CRM should read it rather than
// asking for it again a row at a time.
function importBranchesDialog(after) {
  const header = "client,branch,area,from,to,days,visits_per_month,visit_minutes,lat,lng";
  const sample = `${header}\nNile View Hotel,Main Kitchen,Maadi,09:00,17:00,"Sat,Mon,Wed",3,90,,`;
  openModal(`⬆️ ${t("import_branches")}`, `<div id="imp">
    <p class="muted small">${t("import_hint")}</p>
    <div class="form-actions" style="justify-content:flex-start">
      <input type="file" id="imp-file" accept=".csv,text/csv,text/plain">
      <button type="button" class="btn secondary sm" id="imp-template">⬇️ ${t("import_template")}</button>
    </div>
    <textarea id="imp-text" rows="6" style="width:100%;font-family:monospace;font-size:12px"
      placeholder="${esc(sample)}"></textarea>
    <div id="imp-out"></div>
    <div class="form-actions"><button type="button" class="btn secondary" id="imp-x">${t("cancel")}</button>
      <button type="button" class="btn secondary" id="imp-check">${t("import_check")}</button>
      <button type="button" class="btn" id="imp-go" style="display:none">${t("import_apply")}</button>
    </div></div>`, () => {
    $("imp-x").addEventListener("click", closeModal);
    $("imp-template").addEventListener("click", () => {
      const blob = new Blob([sample + "\n"], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "branches-template.csv";
      document.body.appendChild(a); a.click(); a.remove();
    });
    $("imp-file").addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) $("imp-text").value = await f.text();
    });
    const run = async (apply) => {
      const csv = $("imp-text").value.trim();
      if (!csv) { alert(t("import_nothing")); return; }
      try {
        const res = await API.post("/branches/import", { csv, apply });
        if (handledOffline(res)) return;
        if (res.applied) {
          closeModal();
          toast(t("import_done").replace("{c}", res.created).replace("{u}", res.updated));
          if (after) after();
          return;
        }
        const s = res.summary;
        // Rows with problems lead, because they are the only ones that need
        // doing something about — and one bad row stops the whole import.
        const bad = (res.rows || []).filter(r => r.problems && r.problems.length);
        $("imp-out").innerHTML = `<div class="auto-summary">
            <span class="sc-chip">${s.create} ${t("import_new")}</span>
            <span class="sc-chip">${s.update} ${t("import_existing")}</span>
            ${s.problems ? `<span class="sc-chip warn">${s.problems} ${t("import_bad")}</span>` : ""}
          </div>
          ${bad.length ? `<div class="auto-unplaced"><strong>⚠️ ${t("import_fix_first")}</strong>
            ${bad.slice(0, 12).map(r => `<div class="muted small">${t("import_row")
              .replace("{n}", r.row)}: ${esc(r.client || "—")} / ${esc(r.branch || "—")} — ${
              esc(r.problems.join("; "))}</div>`).join("")}</div>` : ""}`;
        $("imp-go").style.display = s.problems ? "none" : "";
      } catch (err) { alert(err.message); }
    };
    $("imp-check").addEventListener("click", () => run(false));
    $("imp-go").addEventListener("click", () => run(true));
  });
}

// ====================================================================
// WHERE WORK IS STUCK — the whole CRM as one pipeline.
// Every module can answer its own question; nobody could ask them all at once,
// so a quote nobody chased and a completed visit nobody billed sat there
// indefinitely. These are the JOINS between modules, in the order work flows,
// and every count clicks through to the screen that clears it.
// ====================================================================
const PIPELINE_STAGES = [
  { group: "pipe_winning", items: [
    { k: "leads_open", view: "leads" },
    { k: "quotes_open", view: "invoices" },
  ] },
  { group: "pipe_setup", items: [
    { k: "contracts_no_branch", view: "contracts" },
    { k: "branches_no_area", view: "locations" },
    { k: "branches_no_cycle", view: "branchsched" },
  ] },
  { group: "pipe_doing", items: [
    { k: "requests_pending", view: "requests" },
    { k: "visits_unassigned", view: "dispatch" },
    // A branch below the number its cycle owes for the month — a visit deleted
    // by hand and never replaced. Opens the worklist rather than a screen,
    // because the branch and the month are the whole of what you need.
    { k: "visits_missing_owed", view: "shifts", modal: serviceGapModal },
  ] },
  { group: "pipe_writeup", items: [
    { k: "visits_no_report", view: "reports" },
    { k: "reports_draft", view: "reports" },
  ] },
  { group: "pipe_paid", items: [
    { k: "visits_unbilled", view: "visits" },
    { k: "invoices_unpaid", view: "invoices" },
  ] },
];

async function viewPipeline(v) {
  const d = await API.get("/pipeline");
  const stuck = (n) => n > 0;
  const section = (g) => {
    const cells = g.items.filter(it => d[it.k] !== null && d[it.k] !== undefined).map(it => `
      <button class="pipe-card${stuck(d[it.k]) ? " pipe-stuck" : ""}" data-go="${it.view}"
              data-k="${it.k}">
        <span class="pipe-n">${d[it.k]}</span>
        <span class="pipe-lbl">${t("pipe_" + it.k)}</span></button>`).join("");
    return cells ? `<div class="pipe-group"><h3>${t(g.group)}</h3>
      <div class="pipe-row">${cells}</div></div>` : "";
  };
  const total = PIPELINE_STAGES.reduce((n, g) => n + g.items.reduce(
    (m, it) => m + (d[it.k] || 0), 0), 0);
  v.innerHTML = `<div class="page-head"><h2>${t("nav_pipeline")}</h2>
      <span class="muted">${total ? t("pipe_total").replace("{n}", total)
                                  : t("pipe_clear")}</span></div>
    <p class="muted small">${t("pipeline_hint")}</p>
    ${PIPELINE_STAGES.map(section).join("")}`;
  const byKey = {};
  PIPELINE_STAGES.forEach(g => g.items.forEach(it => { byKey[it.k] = it; }));
  v.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => {
    const it = byKey[b.dataset.k];
    if (it && it.modal && d[it.k]) it.modal();
    else navigate(b.dataset.go);
  }));
}

// Can this book be serviced at all? Arithmetic, not a plan — asked while the
// office is still typing rather than after 200 branches have been entered and
// the button reports half of them unplaceable.
async function loadCapacity() {
  const box = $("bs-cap");
  if (!box) return;
  let d;
  try { d = await API.get("/capacity"); } catch (e) { box.remove(); return; }
  const tot = d.totals || {};
  const over = (d.zones || []).filter(z => z.status === "over");
  const tight = (d.zones || []).filter(z => z.status === "tight");
  const uncovered = (d.areas || []).filter(a => a.uncovered);
  const bar = (z) => {
    const pct = z.supply_hours ? Math.min(100, Math.round(z.demand_hours * 100 / z.supply_hours)) : 100;
    return `<div class="cap-row">
      <span class="cap-name">${esc(localized(z, "name"))}</span>
      <span class="cap-bar"><i class="cap-${z.status}" style="width:${pct}%"></i></span>
      <span class="muted small">${z.demand_hours}h / ${z.supply_hours}h · ${
        z.engineers} ${t("engineers_lc")}</span></div>`;
  };
  box.innerHTML = `<div class="panel cap-panel">
    <div class="cap-head"><strong>${t("capacity_title")}</strong>
      <span class="muted small">${t("capacity_totals")
        .replace("{d}", tot.demand_hours).replace("{s}", tot.supply_hours)}</span></div>
    ${uncovered.length ? `<div class="warn-line">⚠️ ${t("capacity_uncovered")
      .replace("{n}", uncovered.length)}: ${uncovered.slice(0, 5)
      .map(a => esc(localized(a, "name"))).join(" · ")}</div>` : ""}
    ${over.length ? `<div class="warn-line">⚠️ ${t("capacity_over")
      .replace("{n}", over.length)}</div>` : ""}
    ${tight.length && !over.length ? `<div class="muted small">${t("capacity_tight")
      .replace("{n}", tight.length)}</div>` : ""}
    ${(d.zones || []).map(bar).join("") || `<div class="muted small">${t("capacity_no_zones")}</div>`}
    <p class="muted small">${t("capacity_hint")
      .replace("{m}", tot.slot_minutes).replace("{t}", tot.travel_minutes)}</p></div>`;
}

// The bulk fill: ask once, apply to everything on screen. Blank means "leave
// this one alone", so an office can set only the frequency across an area.
function fillBranchesDialog(n, apply) {
  openModal(t("fill_all_shown"), `<form id="bf">
    <p class="muted small">${t("fill_all_hint").replace("{n}", n)}</p>
    <div class="form-grid">
      ${field(t("service_from"), "from", { attrs: HHMM_ATTRS })}
      ${field(t("service_to"), "to", { attrs: HHMM_ATTRS })}
      ${field(t("visits_per_month"), "vpm",
              { attrs: 'type="number" min="0" max="56" step="0.5"' })}
      ${field(t("visit_minutes"), "mins", { attrs: 'type="number" min="10" max="480" step="5"' })}
    </div>
    <div class="field"><label>${t("service_days_lbl")}</label>
      <div class="sd-grid">${AVAIL_DAYS.map(x => `<label class="sd-day">
        <span class="sd-tick"><input type="checkbox" class="bf-wd" value="${x.wd}"> ${
          t("wd_" + x.k)}</span></label>`).join("")}</div>
      <label class="chk-item"><input type="checkbox" id="bf-setdays"> ${t("fill_set_days")}</label></div>
    <div class="form-actions"><button type="button" class="btn secondary" id="bf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("apply_to_shown")}</button></div></form>`, (root) => {
    $("bf-x").addEventListener("click", closeModal);
    wireTimeInputs(root);
    // Ticking any day implies "yes, set the days" — otherwise an empty tick
    // list would silently clear every branch's days.
    root.querySelectorAll(".bf-wd").forEach(cb => cb.addEventListener("change", () => {
      if (cb.checked) $("bf-setdays").checked = true;
    }));
    root.querySelector("#bf").addEventListener("submit", (e) => {
      e.preventDefault();
      const g = (sel) => root.querySelector(sel).value.trim();
      const out = {
        from: g("[name=from]") ? normHHMM(g("[name=from]")) : null,
        to: g("[name=to]") ? normHHMM(g("[name=to]")) : null,
        vpm: g("[name=vpm]") !== "" ? g("[name=vpm]") : null,
        mins: g("[name=mins]") !== "" ? g("[name=mins]") : null,
        days: $("bf-setdays").checked
          ? [...root.querySelectorAll(".bf-wd:checked")].map(c => Number(c.value)) : null,
      };
      closeModal();
      apply(out);
    });
  });
}

// ====================================================================
// MY TEAM — who a supervisor answers for today.
// For an AREA MANAGER nobody is permanently on this list: it is read from the
// roster for the date on screen, so an engineer appears under whichever manager
// holds the area they are serving that day, and moves the moment the roster
// does. For a TEAM LEADER it is their standing crew — the same faces on every
// date, with only the day's shifts and counts beside them changing.
// ====================================================================
async function viewMyTeam(v, arg) {
  const date = (arg && arg.date) || ymd(new Date());
  const d = await API.get(`/my-team?date=${date}`);
  const areas = (d.areas || []).map(a => esc(localized(a, "name"))).join(" · ");
  // The strip above the table says what this person answers for. A team leader
  // holds no areas, so telling them they hold none would be nonsense.
  const strip = isTeamLeader()
    ? `<div class="lead-areas">👷 ${t("my_team_standing")}</div>`
    : (areas ? `<div class="lead-areas">📌 ${t("my_areas")}: ${areas}</div>`
             : `<div class="lead-areas warn-line">⚠️ ${t("leader_no_areas")}</div>`);
  v.innerHTML = `<div class="page-head"><h2>${t("nav_myteam")}</h2>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn secondary sm" id="mt-prev">${t("prev")}</button>
      <input type="date" id="mt-date" value="${date}">
      <button class="btn secondary sm" id="mt-next">${t("next")}</button>
      <button class="btn secondary sm" id="mt-today">${t("today")}</button></div></div>
    ${strip}
    ${!d.members.length ? `<div class="empty">${t("team_empty")}</div>` : `
    <div class="panel"><table><thead><tr>
      <th>${t("agent")}</th><th>${t("area")}</th><th>${t("shift_lbl")}</th>
      <th>${t("visits_today_col")}</th><th>${t("reports_due_col")}</th><th></th></tr></thead>
      <tbody>${d.members.map(m => {
        const ar = (m.shifts || []).map(s => s.area_en ? esc(localized(s, "area")) : "").filter(Boolean);
        const sh = (m.shifts || []).map(s => `${esc(localized(s, "shift"))}${
          s.from_time ? ` <span class="muted small">${esc(s.from_time)}–${esc(s.to_time || "")}</span>` : ""}`);
        const done = m.visits.completed, tot = m.visits.total;
        return `<tr>
          <td><strong>${esc(m.full_name)}</strong>${SUPERVISOR_ROLES.includes(m.role)
            ? ` <span class="badge">${t("role_" + m.role)}</span>` : ""}
            ${m.phone ? `<div class="muted small">${esc(m.phone)}</div>` : ""}</td>
          <td>${[...new Set(ar)].join(" · ") || "—"}</td>
          <td>${sh.join("<br>") || "—"}</td>
          <td>${done}/${tot}${m.visits.in_progress
            ? ` <span class="badge b-in_progress">${t("st_in_progress")}</span>` : ""}</td>
          <td>${m.reports_due
            ? `<span class="badge b-overdue">${m.reports_due}</span>` : "0"}</td>
          <td><button class="link-btn sm" data-day="${m.id}">${t("view")}</button></td></tr>`;
      }).join("")}</tbody></table></div>`}`;
  $("mt-prev").addEventListener("click", () => navigate("myteam", { date: shiftDate(date, -1) }));
  $("mt-next").addEventListener("click", () => navigate("myteam", { date: shiftDate(date, 1) }));
  $("mt-today").addEventListener("click", () => navigate("myteam"));
  $("mt-date").addEventListener("change", (e) => navigate("myteam", { date: e.target.value }));
  // Straight to that engineer's day on the schedule, filtered to them.
  v.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () =>
    navigate("schedule", { agent: b.dataset.day, from: date, to: date })));
}

async function viewMyDay(v, arg) {
  const date = (arg && arg.date) || ymd(new Date());
  // My Day is MY jobs. An engineer's visit list is already scoped to them, but
  // a supervisor's takes in everything they answer for — so their own route has to ask for
  // it by name, or the screen fills up with everybody else's stops.
  const mineOnly = isLeader() ? `&agent=${API.user.id}` : "";
  const res = await API.get(`/visits?from=${date}&to=${date}${mineOnly}`);
  const items = (Array.isArray(res) ? res : (res.items || []))
    .slice().sort((a, b) => (a.scheduled_start || "").localeCompare(b.scheduled_start || ""));
  v.innerHTML = `<div class="page-head"><h2>${t("nav_myday")}</h2>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn secondary sm" id="md-prev">${t("prev")}</button>
      <input type="date" id="md-date" value="${date}">
      <button class="btn secondary sm" id="md-next">${t("next")}</button>
      <button class="btn secondary sm" id="md-today">${t("today")}</button>
      <button class="btn secondary sm" id="md-toggle">🗺️ ${t("map_view")}</button></div></div>
    <div id="md-body"></div><div id="md-map" class="hidden"></div>`;
  $("md-prev").addEventListener("click", () => navigate("myday", { date: shiftDate(date, -1) }));
  $("md-next").addEventListener("click", () => navigate("myday", { date: shiftDate(date, 1) }));
  $("md-today").addEventListener("click", () => navigate("myday"));
  $("md-date").addEventListener("change", (e) => navigate("myday", { date: e.target.value }));
  renderMyDayList(items);
  let mapShown = false;
  $("md-toggle").addEventListener("click", async () => {
    mapShown = !mapShown;
    $("md-map").classList.toggle("hidden", !mapShown);
    $("md-body").classList.toggle("hidden", mapShown);
    $("md-toggle").textContent = mapShown ? "📋 " + t("list_view") : "🗺️ " + t("map_view");
    if (mapShown) await renderMyDayMap(items);
  });
}

function renderMyDayList(items) {
  const body = $("md-body");
  if (!items.length) { body.innerHTML = `<div class="empty">${t("no_visits_today")}</div>`; return; }
  const geo = items.map(coordsOf).filter(Boolean);
  const km = geo.length > 1 ? Math.round(routeKmJs(geo)) : 0;
  const rows = items.map((vi, i) => {
    const c = coordsOf(vi);
    const dir = c ? `<a class="btn secondary sm" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${c[0]},${c[1]}">🧭 ${t("navigate")}</a>` : "";
    // Starting a visit = GPS check-in (stamps time + location, sets in_progress).
    const start = (vi.status === "scheduled" || (vi.status === "in_progress" && !vi.checkin_at))
      ? `<button class="btn sm" data-start="${vi.id}">📍 ${t("check_in")}</button>` : "";
    return `<div class="md-stop b-${vi.status}">
      <div class="md-seq">${i + 1}</div>
      <div class="md-main">
        <div class="md-time">${(vi.scheduled_start || "").slice(11, 16) || "—"} · <span class="badge b-${vi.status}">${t(statusKey(vi.status))}</span></div>
        <div class="md-client">${esc(localized(vi, "client"))}</div>
        ${(vi.site_name || vi.location) ? `<div class="muted small">${c ? "📍" : "⚠️"} ${esc(vi.site_name || vi.location)}</div>` : ""}</div>
      <div class="md-actions">${start}${dir}<button class="link-btn sm" data-open="${vi.id}">${t("view")}</button></div></div>`;
  }).join("");
  body.innerHTML = `${km ? `<p class="muted small">${t("route_distance")}: <strong>${km} km</strong> · ${items.length} ${t("stops")}</p>` : ""}${rows}`;
  body.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => navigate("visit", { id: b.dataset.open })));
  body.querySelectorAll("[data-start]").forEach(b => b.addEventListener("click", async () => {
    b.disabled = true;
    try { const s = await doCheckin(b.dataset.start, "checkin"); if (handledOffline(s)) return; navigate("visit", { id: b.dataset.start }); }
    catch (e) { alert(e.message); b.disabled = false; }
  }));
}

async function renderMyDayMap(items) {
  const box = $("md-map");
  box.innerHTML = `<div class="empty">${t("loading")}</div>`;
  let g;
  try { g = await ensureMapsApi(); } catch (e) { g = null; }
  if (!g) { box.innerHTML = `<div class="empty">🗺️ ${t("map_needs_key")}</div>`; return; }
  const pts = items.map(v => ({ v, c: coordsOf(v) })).filter(x => x.c);
  if (!pts.length) { box.innerHTML = `<div class="empty">${t("no_geocoded_today")}</div>`; return; }
  box.innerHTML = `<div id="md-canvas" style="height:62vh;border-radius:12px;border:1px solid var(--line)"></div>`;
  const map = new g.maps.Map($("md-canvas"), { zoom: 11, center: { lat: pts[0].c[0], lng: pts[0].c[1] }, mapTypeControl: false, streetViewControl: false });
  const bounds = new g.maps.LatLngBounds(), path = [];
  pts.forEach((p, i) => {
    const pos = { lat: p.c[0], lng: p.c[1] };
    new g.maps.Marker({ position: pos, map, label: String(i + 1), title: localized(p.v, "client") });
    bounds.extend(pos); path.push(pos);
  });
  new g.maps.Polyline({ path, map, strokeColor: "#1f74d6", strokeWeight: 3, strokeOpacity: .85 });
  map.fitBounds(bounds);
}

// ---- central reports list (admin/owner: all reports, filterable + printable) ----
function reportsTable(rows, forPrint, picked) {
  if (!rows || !rows.length) return `<div class="empty">${t("none")}</div>`;
  const cb = !forPrint && picked;
  const head = `<tr>${cb ? `<th class="cb-col"><input type="checkbox" id="rf-all"><span class="pc-only">${t("select_all")}</span></th>` : ""}
    <th>${t("scheduled_start")}</th><th>${t("client")}</th><th>${t("location_lbl")}</th>
    <th>${t("agent")}</th><th>${t("status")}</th><th>${t("summary")}</th></tr>`;
  const body = rows.map(r => {
    const stB = `<span class="badge b-${r.status === "complete" ? "completed" : "draft"}">${t(r.status === "complete" ? "report_complete" : "report_draft")}</span>`;
    const attr = forPrint ? "" : `class="clickable" data-visit="${r.visit_id}"`;
    const box = cb ? `<td class="cb-col"><input type="checkbox" class="rep-cb" data-visit="${r.visit_id}"${picked.has(String(r.visit_id)) ? " checked" : ""}></td>` : "";
    return `<tr ${attr}>${box}<td>${fmtDateTime(r.scheduled_start)}</td><td>${esc(localized(r, "client") || "")}</td>
      <td>${esc(r.site_name || "—")}</td><td>${esc(r.agent_name || "—")}</td>
      <td>${stB}</td><td>${esc((r.summary || "").slice(0, 70))}</td></tr>`;
  }).join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// How many reports one bundle may carry. Each printable page drags its photos
// and signatures along, so an unbounded "all" would hand a phone more than it
// can build. Past this the newest N are taken and the user is told.
const REPORT_BATCH_MAX = 50;

// ---- ZIP (stored, no compression) --------------------------------------
// A download is one file per report, and handing over many files at once means
// a zip. Stored rather than deflated: no library to vendor, and the pages are
// mostly already-compressed embedded photos, which deflate cannot shrink.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) {          // [{name, data:Uint8Array}] -> Blob
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  files.forEach(f => {
    const name = enc.encode(f.name);          // flag 0x0800 = the name is UTF-8
    const crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);   // 1980-01-01
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true); cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, size, true); cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + size;
  });
  const centralSize = central.reduce((a, c) => a + c.length, 0);
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true);
  eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true);
  eo.setUint32(12, centralSize, true); eo.setUint32(16, offset, true);
  return new Blob(parts.concat(central, [new Uint8Array(eo.buffer)]), { type: "application/zip" });
}
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// A bundled page is opened from a folder, with no login and no server behind
// it, so every picture has to travel inside the file. Downscaled on the way in
// — a phone camera's 4000px original is pointless at 170px on a page, and
// fifty of them would be a bundle nobody can email.
const PIXEL_GONE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const IMG_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
                   gif: "image/gif", webp: "image/webp" };
const _inlineCache = new Map();
function uploadAsDataUrl(url, maxPx = 1100) {
  if (!_inlineCache.has(url)) {
    _inlineCache.set(url, (async () => {
      const bytes = await fetchUploadBytes(url);
      // The type has to be stated: a Blob with no type fails to decode, and
      // the bytes came back as a bare ArrayBuffer. Decoded through an <img>
      // rather than createImageBitmap, which older Android WebViews lack.
      const ext = (url.split(".").pop() || "").toLowerCase();
      const blob = new Blob([bytes], { type: IMG_MIME[ext] || "image/jpeg" });
      const objUrl = URL.createObjectURL(blob);
      try {
        const img = await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => rej(new Error("decode failed"));
          im.src = objUrl;
        });
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        const scale = Math.min(1, maxPx / Math.max(w, h));
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(w * scale));
        cv.height = Math.max(1, Math.round(h * scale));
        const cx = cv.getContext("2d");
        cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
        cx.drawImage(img, 0, 0, cv.width, cv.height);
        return cv.toDataURL("image/jpeg", 0.78);
      } finally { URL.revokeObjectURL(objUrl); }
    })().catch(() => PIXEL_GONE));
  }
  return _inlineCache.get(url);
}
// Every /uploads/ reference becomes a data URI — including the ones that could
// not be read, which become a blank pixel rather than a broken link back to a
// server the file can no longer reach.
async function inlineUploads(html) {
  const urls = [...new Set(html.match(/\/uploads\/[A-Za-z0-9_.\-]+/g) || [])];
  for (const u of urls) {
    const data = await uploadAsDataUrl(u);
    html = html.split('"' + u + '"').join('"' + data + '"');
  }
  return html;
}

// Load whole reports (visit detail + the devices scanned on it) for a list of
// visit ids, a few at a time rather than all at once, so a phone on site isn't
// asked to open a hundred connections. A report that fails to load is skipped
// rather than losing the whole batch.
async function fetchReportDocs(ids, onProgress) {
  const out = new Array(ids.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < ids.length) {
      const i = next++;
      try {
        const [visit, fu] = await Promise.all([
          API.get(`/visits/${ids[i]}?lang=${LANG}`),
          API.get(`/visits/${ids[i]}/followup`).catch(() => ({ groups: {} })),
        ]);
        out[i] = { visit, groups: fu.groups || {} };
      } catch (e) { out[i] = null; }
      if (onProgress) onProgress(++done, ids.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  return out.filter(Boolean);
}

// A file name that reads as the report it holds, and that a filesystem accepts.
function reportFileBase(visit) {
  const date = (visit.completed_at || visit.scheduled_start || "").slice(0, 10);
  const client = (localized(visit, "client") || "").replace(/[\\/:*?"<>|]+/g, " ").trim();
  return [date, client.replace(/\s+/g, "-").slice(0, 60),
          String(visit.id).padStart(5, "0")].filter(Boolean).join("_");
}

// Each report as its own printable page, all of them handed over in one zip.
// The pages carry their pictures inside them and do NOT print themselves on
// open — fifty files that each raise a print dialog would be unusable.
async function downloadReportPages(ids, btn) {
  const capped = ids.length > REPORT_BATCH_MAX;
  if (capped) ids = ids.slice(0, REPORT_BATCH_MAX);
  const enc = new TextEncoder();
  const docs = await fetchReportDocs(ids, (d, n) => { btn.textContent = `${t("pdf_preparing")} ${d}/${n}`; });
  if (!docs.length) { toast(t("none")); return; }
  const files = [];
  for (let i = 0; i < docs.length; i++) {
    btn.textContent = `${t("bundling")} ${i + 1}/${docs.length}`;
    const { visit, groups } = docs[i];
    const title = `${t("service_report")} #${String(visit.id).padStart(5, "0")}` +
      (localized(visit, "client") ? " - " + localized(visit, "client") : "");
    const html = await inlineUploads(reportsDocHtml([reportSheetHtml(visit, groups)], title, false));
    files.push({ name: reportFileBase(visit) + ".html", data: enc.encode(html) });
  }
  saveBlob(zipStore(files), "reports-pages.zip");
  if (capped) toast(`${t("pdf_batch_cap")} ${REPORT_BATCH_MAX}`);
}
async function viewReports(v) {
  const stats = ["", "complete", "draft"];
  const clientOpts = `<option value="">${t("all")}</option>` +
    cache.clients.map(c => `<option value="${c.id}">${esc(clientLabel(c))}</option>`).join("");
  const agentSel = hasAgentList()
    ? `<label>${t("agent")}: <select id="rf-agent"><option value="">${t("all")}</option>${cache.agents.map(a => `<option value="${a.id}">${esc(a.full_name)}</option>`).join("")}</select></label>` : "";
  // Deleting a report rides on visits.delete — by default the owner's and the
  // manager's alone (an engineer, a team leader and an area manager all have
  // visits.edit and none of them has this).
  const canDelReports = role() !== "client" && can("visits.delete");
  v.innerHTML = `<div class="page-head"><h2>${t("nav_reports")}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${canDelReports ? `<button class="btn sm danger hidden" id="rf-del">🗑 ${t("delete_selected")}</button>` : ""}
        <button class="btn sm" id="rf-dl">⬇ ${t("download")}</button>
      </div></div>
    <div class="toolbar">
      <label>${t("client")}: <select id="rf-client">${clientOpts}</select></label>
      <label>${t("location_lbl")}: <select id="rf-site"><option value="">${t("all")}</option></select></label>
      ${agentSel}
      <label>${t("status")}: <select id="rf-status">${stats.map(s => `<option value="${s}">${s ? t(s === "complete" ? "report_complete" : "report_draft") : t("all")}</option>`).join("")}</select></label>
      <label>${t("from")}: <input type="date" id="rf-from"></label>
      <label>${t("to")}: <input type="date" id="rf-to"></label>
      <label>${t("sort_order")}: <select id="rf-sort">
        <option value="asc">${t("sort_soonest")}</option>
        <option value="desc">${t("sort_latest")}</option></select></label>
    </div>
    <div class="panel" id="rep-list">${t("loading")}</div>`;
  const val = (id) => ($(id) && $(id).value) || "";
  function buildQuery(paged) {
    const p = [`lang=${LANG}`];   // summaries shown in the current CRM language
    if (paged) p.push(`page=${paged}`, `limit=${PAGE_SIZE}`);
    if (val("rf-client")) p.push("client=" + val("rf-client"));
    if (val("rf-site")) p.push("site=" + val("rf-site"));
    if (val("rf-agent")) p.push("agent=" + val("rf-agent"));
    if (val("rf-status")) p.push("status=" + val("rf-status"));
    if (val("rf-from")) p.push("from=" + val("rf-from"));
    if (val("rf-to")) p.push("to=" + val("rf-to"));
    p.push("sort=" + (val("rf-sort") || "asc"));
    return p.join("&");
  }
  // Ticked reports, kept across pages and filter changes so a batch can be
  // gathered from more than one page of results.
  const picked = new Set();
  function updatePicked() {
    const n = picked.size;
    $("rf-dl").innerHTML = `⬇ ${t("download")}${n ? ` (${n})` : ""}`;
    // Nothing ticked, nothing to delete — the button is not there to be
    // pressed by accident, it appears with the first tick.
    const del = $("rf-del");
    if (del) {
      del.classList.toggle("hidden", n === 0);
      del.innerHTML = `🗑 ${t("delete_selected")} (${n})`;
    }
  }
  async function refresh(page = 1) {
    const d = await API.get("/reports?" + buildQuery(page));
    const box = $("rep-list");
    box.innerHTML = reportsTable(d.items, false, picked) + pagerHTML(d);
    box.querySelectorAll("tr[data-visit]").forEach(tr =>
      tr.addEventListener("click", () => navigate("report", { id: tr.dataset.visit })));
    box.querySelectorAll(".rep-cb").forEach(cb => {
      // The row itself opens the report; ticking it must not navigate away.
      cb.addEventListener("click", e => e.stopPropagation());
      cb.addEventListener("change", () => {
        if (cb.checked) picked.add(cb.dataset.visit); else picked.delete(cb.dataset.visit);
        updatePicked();
      });
    });
    if ($("rf-all")) $("rf-all").addEventListener("change", e => {
      box.querySelectorAll(".rep-cb").forEach(cb => {
        cb.checked = e.target.checked;
        if (cb.checked) picked.add(cb.dataset.visit); else picked.delete(cb.dataset.visit);
      });
      updatePicked();
    });
    wirePager($("rep-list"), d, refresh);
    updatePicked();
  }
  $("rf-client").addEventListener("change", async () => {
    const cid = val("rf-client"), sel = $("rf-site");
    if (!cid) { sel.innerHTML = `<option value="">${t("all")}</option>`; refresh(1); return; }
    await loadSiteOptions(cid, sel, "", t("all"));
    if (sel.dataset.hasSites === "1") sel.insertAdjacentHTML("beforeend", `<option value="none">${t("unassigned")}</option>`);
    refresh(1);
  });
  ["rf-site", "rf-agent", "rf-status", "rf-from", "rf-to", "rf-sort"].forEach(id => {
    if ($(id)) $(id).addEventListener("change", () => refresh(1));
  });
  // Delete the ticked reports. One request each rather than a batch endpoint:
  // the ticks survive paging, so the list can hold a handful from three pages,
  // and a failure halfway through has to say WHICH one stopped it — the rest
  // stay ticked so the office can see what is still there.
  if ($("rf-del")) $("rf-del").addEventListener("click", async () => {
    const ids = [...picked];
    if (!ids.length) return;
    if (!confirm(t("delete_reports_confirm").replace("{n}", ids.length))) return;
    let done = 0;
    for (const id of ids) {
      try {
        await API.del(`/visits/${id}/report`);
        picked.delete(id);
        done++;
      } catch (err) { alert(err.message); break; }
    }
    if (done) toast(t("reports_deleted").replace("{n}", done));
    updatePicked();
    refresh(1);
  });
  const filterSubtitle = () =>
    [val("rf-client") && $("rf-client").selectedOptions[0].text,
     val("rf-site") && $("rf-site").selectedOptions[0].text,
     $("rf-agent") && val("rf-agent") && $("rf-agent").selectedOptions[0].text]
    .filter(Boolean).join(" · ") || t("all");
  const printList = async () => {
    const res = await API.get("/reports?" + buildQuery(0));   // no page -> full list
    const rows = Array.isArray(res) ? res : (res.items || []);
    analyticsReportDoc(t("nav_reports"), filterSubtitle(), `<div class="panel">${reportsTable(rows, true)}</div>`);
  };
  // Every download is one file per report, bundled in a zip. What varies is
  // the shape of each file — a printable page, or the data as a sheet.
  $("rf-dl").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    let ids = [...picked];
    if (!ids.length) {           // nothing ticked -> everything the filters match
      const res = await API.get("/reports?" + buildQuery(0));
      const rows = Array.isArray(res) ? res : (res.items || []);
      if (!rows.length) { toast(t("none")); return; }
      ids = rows.map(r => String(r.visit_id));
    }
    const scope = picked.size ? `${picked.size} ${t("selected")}` : `${t("all")} (${ids.length})`;
    const qs = "?ids=" + ids.join(",");
    const label = btn.innerHTML;
    const run = async (fn) => {
      btn.disabled = true;
      try { await fn(); } catch (err) { alert(err.message); }
      finally { btn.disabled = false; btn.innerHTML = label; }
    };
    const opt = (id, icon, title, hint) => `<button type="button" class="btn secondary exp-opt" data-dl="${id}">
      <span class="exp-ic">${icon}</span><span><strong>${title}</strong><br><span class="muted small">${hint}</span></span></button>`;
    openModal(`${t("download")} — ${scope}`, `<div class="export-opts">
        ${opt("pages", "🖨️", t("dl_pages"), t("dl_pages_hint"))}
        ${opt("xlsx", "📊", t("dl_excel"), t("dl_excel_hint"))}
        ${opt("csv", "📄", t("dl_csv"), t("dl_csv_hint"))}
        ${opt("list", "📋", t("print_list"), t("dl_list_hint"))}
      </div><p class="muted small">${t("dl_zip_note")}</p>
      <div class="form-actions"><button type="button" class="btn secondary" id="dl-x">${t("cancel")}</button></div>`,
      (root) => {
        $("dl-x").addEventListener("click", closeModal);
        root.querySelectorAll("[data-dl]").forEach(b => b.addEventListener("click", () => {
          const kind = b.dataset.dl;
          closeModal();
          if (kind === "list") return printList();
          if (kind === "pages") return run(() => downloadReportPages(ids, btn));
          run(() => downloadZip(`/api/export/reports-bundle.${kind}.zip${qs}`, `reports-${kind}.zip`));
        }));
      });
  });
  refresh(1);
}

// Transportation. A trip is now written down as where it went from and where
// to; the old fixed vehicle list is kept only to read back trips logged before
// that (their keys were stored, and are still displayed localized).
const TRANSPORT_VEHICLES = ["company_car", "own_car", "motorcycle", "taxi", "bus", "truck", "other"];
const vehicleLabel = (k) => k ? (TRANSPORT_VEHICLES.includes(k) ? t("veh_" + k) : k) : "—";
// One-line description of a trip, falling back to the legacy vehicle.
function tripLabel(e) {
  const route = [e.from_place, e.to_place].filter(Boolean).join(" → ");
  return route || vehicleLabel(e.vehicle || e.transport_vehicle);
}

// Report fields, in document order. area=multi-line. Materials are numbers.
// Editable in the office's report document. Condition and recommendations are
// picked from the office's lists in the field, but stay editable here as text
// — this is the desk where a filed report gets corrected.
const REPORT_TEXT_FIELDS = [
  { n: "summary", area: true }, { n: "condition", area: true },
  { n: "recommendations", area: true },
];
// Retired from the report form. Still shown here when an older report carries
// them, read-only, so history reads as it was filed.
const REPORT_LEGACY_FIELDS = ["pests_found", "findings", "spare_parts_changed", "branch_issue"];
const REPORT_MAT_FIELDS = ["lamps_used", "cables_used", "transformers_used", "light_sheets_used",
  "fipronil_ml", "imidacloprid_gm", "baits_count", "glo_pieces", "flybase_bags"];

// Read-only on-screen tables of the device follow-up data captured by QR scans
// on this visit, grouped by device type (mirrors the printed follow-up form).
// Returns "" when nothing was scanned.
function reportFollowupHtml(groups) {
  const order = DEVICE_SECTION_ORDER;
  return order.filter(ty => (groups[ty] || []).length).map(ty => {
    const fields = deviceColumns(ty);
    const head = `<th>${t("code")}</th><th>${t("label")}</th><th>${t("status")}</th>`
      + fields.map(f => `<th>${esc(t("df_" + f.key))}</th>`).join("");
    const rows = groups[ty].map(r => `<tr>
      <td><strong>${esc(r.code)}</strong></td><td>${esc(r.label || "—")}</td>
      <td>${t("mst_" + r.status)}</td>
      ${fields.map(f => `<td>${detailCellHtml(ty, f, r.details)}</td>`).join("")}
    </tr>`).join("");
    return `<div class="rdoc-fu"><h4>${esc(t("sec_" + ty))}</h4>
      <table class="rdoc-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join("");
}

// The device types a report walks through, in the order they are printed.
const DEVICE_SECTION_ORDER = ["bait_station", "fly_trap", "glue_station", "light_trap"];

// Single-report document view, opened ONLY from the Reports sidebar list.
// Looks like a printable report, is editable, and shows only fields that have
// content (empty fields are tucked behind a "show all fields" toggle so they can
// still be added). New design — intentionally distinct from the certificate.
async function viewReportDoc(v, arg) {
  const id = arg && arg.id;
  // Load the report already translated into the current CRM language for
  // display/printing. Edits are dirty-tracked so untouched (translated) fields
  // are never saved back over the agent's original text.
  const visit = await API.get(`/visits/${id}?lang=${LANG}`);
  const rep = visit.report || {};
  const clk = visitClock(visit);   // what the header says about start and end
  // Device follow-up captured by QR scans on this visit (best-effort).
  const followup = await API.get(`/visits/${id}/followup`).catch(() => ({ groups: {} }));
  const fuHtml = reportFollowupHtml(followup.groups || {});
  const photos = visit.photos || [];
  const has = (val) => val !== null && val !== undefined && String(val).trim() !== "";
  const textRow = (f) => {
    const val = rep[f.n] || "";
    const input = f.area ? `<textarea data-rep="${f.n}" rows="3">${esc(val)}</textarea>`
                         : `<input type="text" data-rep="${f.n}" value="${esc(val)}">`;
    return `<div class="rdoc-row" data-empty="${has(val) ? "0" : "1"}"><label>${esc(t(f.n))}</label>${input}</div>`;
  };
  // History only. Materials are logged as usage on the visit now (which is what
  // comes off the engineer's issued balance), so these counters are shown where
  // an old report has them and can no longer be typed into — a number entered
  // here would be counted a second time against the same materials.
  const matRow = (k) => {
    const val = rep[k] || "";
    if (!(Number(val) > 0)) return "";
    return `<div class="rdoc-row" data-empty="0"><label>${esc(t(k))}</label>
      <div>${esc(val)}</div></div>`;
  };
  const sig = (f, label) => f ? `<div class="rdoc-sig"><img src="/uploads/${esc(f)}"><div class="ln">${esc(label)}</div></div>` : "";
  const chemRows = (visit.chemicals || []).map(cu =>
    `<tr><td>${esc(localized(cu, "name"))}</td><td>${cu.quantity} ${esc(cu.unit || "")}</td>
     <td>${esc(usageMethod(cu))}</td><td>${esc(usageEquip(cu))}</td>
     <td>${esc(cu.area_treated || "—")}</td></tr>`).join("");

  // Retired text fields read like the material counters do: shown only where an
  // older report carries them, and no longer typed into.
  const legacyRow = (k) => {
    const val = rep[k] || "";
    if (!has(val)) return "";
    return `<div class="rdoc-row" data-empty="0"><label>${esc(t(k))}</label>
      <div>${esc(val).replace(/\n/g, "<br>")}</div></div>`;
  };
  const allRows = [...REPORT_TEXT_FIELDS.map(textRow), ...REPORT_LEGACY_FIELDS.map(legacyRow),
                   ...REPORT_MAT_FIELDS.map(matRow)].join("");
  // Internal transportation trips — shown read-only here, and deliberately
  // absent from printReportDoc and every client-facing view. Edited from the
  // visit page's report section.
  const trips = role() === "client" ? [] : (visit.transport || []);
  const tripTotal = trips.reduce((s, e) => s + (Number(e.cost) || 0), 0);
  const transRows = !trips.length ? "" : `
    <div class="rdoc-row" data-empty="0"><label>🚕 ${t("transport_invoice")}
        <span class="muted small">(${t("transport_internal_short")})</span></label>
      <div>${trips.map(e => `${esc(tripLabel(e))} — ${money(e.cost)}`).join("<br>")}
        ${trips.length > 1 ? `<br><strong>${t("transport_total")}: ${money(tripTotal)}</strong>` : ""}</div></div>`;
  const statusBadgeHtml = `<span class="badge b-${rep.status === "complete" ? "completed" : "draft"}">${t(rep.status === "complete" ? "report_complete" : "report_draft")}</span>`;
  // Attachments flagged "Business plan" on the visit are surfaced on the report.
  const bpPhotos = (visit.photos || []).filter(p => Number(p.is_business_plan));

  v.innerHTML = `
    <div class="breadcrumb" id="bc">← 📋 ${t("nav_reports")}</div>
    <div class="page-head"><h2>${t("report")} — ${esc(localized(visit, "client"))}</h2>
      <div style="display:flex;gap:8px;align-items:center">
        <label class="muted small"><input type="checkbox" id="rd-showall"> ${t("show_all_fields")}</label>
        <button class="btn sm secondary" id="rd-print">🖨️ ${t("print")}</button>
        ${can("visits.edit") ? `<button class="btn sm" id="rd-save">💾 ${t("save")}</button>` : ""}</div></div>
    <div class="rdoc" id="rdoc">
      <div class="rdoc-head">
        <div><div class="rdoc-title">${t("service_report")}</div>
          <div class="rdoc-no">#${String(visit.id).padStart(5, "0")} · ${fmtDateTime(visit.completed_at || visit.scheduled_start)}</div></div>
        ${statusBadgeHtml}
      </div>
      <div class="rdoc-meta">
        <div><span>${t("client")}</span><b>${esc(localized(visit, "client") || "—")}</b></div>
        <div><span>${t("location_lbl")}</span><b>${esc(visit.site_name || visit.location || "—")}</b></div>
        <div><span>${t("agent")}</span><b>${esc(visit.agent_name || "—")}</b></div>
        <div><span>${t("service")}</span><b>${esc(localized(visit, "service") || "—")}</b></div>
        ${visit.visit_number ? `<div><span>${t("visit_number")}</span><b>${esc(visit.visit_number)}</b></div>` : ""}
        <div class="times">
          ${clk.start ? `<div><span>${clk.startActual ? t("visit_started_at") : t("scheduled_start")}</span><b>${fmtDateTime(clk.start)}</b></div>` : ""}
          ${clk.end ? `<div><span>${clk.endActual ? t("visit_ended_at") : t("scheduled_end")}</span><b>${fmtDateTime(clk.end)}</b></div>` : ""}
          ${clk.mins != null ? `<div><span>${t("duration")}</span><b>${esc(fmtHours(clk.mins))}</b></div>` : ""}
        </div>
      </div>
      <div class="rdoc-body">${transRows}${allRows}</div>
      <div class="rdoc-extra" data-empty="${fuHtml ? "0" : "1"}">
        <h3 class="rdoc-sec">🏷️ ${t("followup_report")}</h3>
        ${fuHtml || `<div class="empty">${t("followup_nothing")}</div>`}</div>
      <div class="rdoc-extra" data-empty="${photos.length ? "0" : "1"}">
        <h3 class="rdoc-sec" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span>📷 ${t("photos")}</span>
          ${can("visits.edit") ? `<button type="button" class="btn sm secondary" id="rd-addphoto">📎 ${t("add_attachment")}</button>` : ""}</h3>
        <div id="report-photos" class="photo-grid"></div></div>
      ${chemRows ? `<h3 class="rdoc-sec">${t("chemicals_applied")}</h3>
        <table class="rdoc-table"><thead><tr><th>${t("name_en")}</th><th>${t("quantity")}</th>
          <th>${t("application_method")}</th><th>${t("application_equipment")}</th>
          <th>${t("area_treated")}</th></tr></thead>
        <tbody>${chemRows}</tbody></table>` : ""}
      ${bpPhotos.length ? `<h3 class="rdoc-sec">📎 ${t("business_plan")}</h3>
        <div id="report-bp-files" class="photo-grid"></div>` : ""}
      ${(rep.customer_signature || rep.technician_signature) ? `<div class="rdoc-sigs">
        ${sig(rep.customer_signature, rep.customer_name || t("customer_signature"))}
        ${sig(rep.technician_signature, visit.agent_name || t("technician_signature"))}</div>` : ""}
    </div>`;

  if (bpPhotos.length) renderPhotos("visit", id, bpPhotos, "report-bp-files");
  renderPhotos("visit", id, photos, "report-photos");
  if ($("rd-addphoto")) $("rd-addphoto").addEventListener("click",
    () => uploadPhotoDialog("visit", id, () => navigate("report", { id })));
  $("bc").addEventListener("click", () => navigate("reports"));
  // Empty fields/sections are hidden by default; the toggle reveals them (e.g.
  // to fill a blank field, or to see the empty follow-up/photos capture areas).
  const applyShowAll = () => {
    const show = $("rd-showall").checked;
    $("rdoc").querySelectorAll('[data-empty="1"]').forEach(el => el.classList.toggle("hidden", !show));
  };
  applyShowAll();
  $("rd-showall").addEventListener("change", applyShowAll);
  // mark a field dirty once the user actually edits it (so we only save changes,
  // never the auto-translated text of fields they left alone)
  $("rdoc").querySelectorAll("[data-rep]").forEach(el =>
    el.addEventListener("input", () => { el.dataset.dirty = "1"; }));
  $("rd-print").addEventListener("click", () => printReportDoc(visit, followup.groups || {}));
  if ($("rd-save")) $("rd-save").addEventListener("click", async () => {
    const d = {};
    $("rdoc").querySelectorAll('[data-rep][data-dirty="1"]').forEach(el => { d[el.dataset.rep] = el.value; });
    if (!Object.keys(d).length) { toast(t("saved")); return; }   // nothing changed
    const saved = await API.post(`/visits/${id}/report`, d);   // no status -> keeps draft/complete
    if (handledOffline(saved)) return;
    toast(t("saved")); navigate("report", { id });
  });
}

// Printable PDF of one report — a clean, NEW layout (not the certificate).
// Renders only the fields that have content.
// Popup-proof printing: render a full HTML document into a hidden same-page
// iframe and let its own onload auto-print fire there — instead of window.open,
// which pop-up blockers and the Android WebView routinely block. Replaces the
// old `window.open("","_blank") + document.write` dance everywhere.
function printHtmlDoc(doc) {
  // Android app: WebViews don't implement window.print(), so hand the document
  // to the native bridge (see PrintBridge in MainActivity.java) which renders it
  // and routes to Android's PrintManager.
  if (window.PestPrint && typeof window.PestPrint.printHtml === "function") {
    try { window.PestPrint.printHtml(doc); return; } catch (e) { /* fall back to iframe */ }
  }
  const prev = document.getElementById("print-frame");
  if (prev) prev.remove();
  const ifr = document.createElement("iframe");
  ifr.id = "print-frame";
  ifr.setAttribute("aria-hidden", "true");
  // Off-screen rather than zero-sized: the report document measures itself
  // before printing (pcFitPhotos), and a frame with no width at all gives it
  // nothing to measure. Parked far to the left, so nothing is ever visible.
  ifr.style.cssText = "position:fixed;left:-10000px;top:0;width:900px;height:1200px;border:0;opacity:0";
  document.body.appendChild(ifr);
  const idoc = ifr.contentWindow.document;
  idoc.open(); idoc.write(doc); idoc.close();   // inline auto-print script runs here
  // Clean the frame up later so they don't pile up (print dialog is async).
  setTimeout(() => { const f = document.getElementById("print-frame"); if (f === ifr) ifr.remove(); }, 120000);
}
// WHEN THE VISIT STARTED AND WHEN IT ENDED, for the printed report and the
// certificate. The real answer is the engineer's check-in/check-out stamps; a
// visit written up without them falls back to the booked window, and says so by
// carrying `actual:false` — the caller labels those "Scheduled", never as the
// time someone was actually on site.
function visitClock(visit) {
  // WHEN HE FINISHED, FOR A VISIT WITH NO CHECK-OUT. Submitting the report is
  // the engineer saying he is done, and the server stamps that on its own Cairo
  // clock — so for a completed visit it is a real finish time, not a booked
  // one. The server now also writes checkout_at at that moment, but every
  // report filed before 2026-09-06 has only completed_at, and those sheets
  // printed the BOOKED end (a visit worked to 02:42 printed 03:00). Only
  // trusted when it actually falls after the arrival: one engineer's phone was
  // an hour fast, so a handful of old rows were stamped "finished" before they
  // were stamped "started".
  const finished = (visit.status === "completed" && visit.completed_at
    && (!visit.checkin_at || visit.completed_at >= visit.checkin_at))
    ? visit.completed_at : null;
  const startActual = !!visit.checkin_at, endActual = !!(visit.checkout_at || finished);
  const start = visit.checkin_at || visit.scheduled_start;
  const end = visit.checkout_at || finished || visit.scheduled_end;
  // A duration is only worth printing when both ends are the same KIND of time.
  // A real arrival measured against the booked finish is not how long anyone
  // was there, and nobody reading it would know that.
  let mins = null;
  if (start && end && startActual === endActual) {
    const a = new Date(String(start).replace(" ", "T"));
    const b = new Date(String(end).replace(" ", "T"));
    if (!isNaN(a) && !isNaN(b) && b > a) mins = Math.round((b - a) / 60000);
  }
  return { start, end, mins, startActual, endActual };
}

// The printable body of ONE report — the sheet only, with no document shell,
// so a single report and a batch of them render through exactly the same
// layout (see reportsPrintDoc below).
function reportSheetHtml(visit, fuGroups) {
  const ar = LANG === "ar";
  const S = SETTINGS || {};
  const rep = visit.report || {};
  const clk = visitClock(visit);   // start / end / duration, printed in the header
  // Device follow-up (QR scans) as print tables, reusing the report styles.
  const fuOrder = DEVICE_SECTION_ORDER;
  const fuHtml = fuOrder.filter(ty => ((fuGroups || {})[ty] || []).length).map(ty => {
    const fields = deviceColumns(ty);
    const head = `<th>${esc(t("code"))}</th><th>${esc(t("label"))}</th><th>${esc(t("status"))}</th>`
      + fields.map(f => `<th>${esc(t("df_" + f.key))}</th>`).join("");
    const rows = fuGroups[ty].map(r => `<tr><td>${esc(r.code)}</td><td>${esc(r.label || "—")}</td>`
      + `<td>${esc(t("mst_" + r.status))}</td>`
      + fields.map(f => `<td>${detailCellHtml(ty, f, r.details)}</td>`).join("") + `</tr>`).join("");
    return `<h4 class="fusec">${esc(t("sec_" + ty))}</h4>
      <table class="data"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }).join("");
  const compName = (ar ? S.company_name_ar : S.company_name_en) || S.company_name_en || "Company";
  const compAddr = (ar ? S.address_ar : S.address_en) || S.address_en || "";
  const logoHtml = S.logo ? `<img src="/uploads/${esc(S.logo)}" style="height:46px">` : `<div style="font-size:32px">🐜</div>`;
  const has = (x) => x !== null && x !== undefined && String(x).trim() !== "";
  const row = (label, val) => has(val) ? `<tr><td class="l">${esc(label)}</td><td>${esc(val).replace(/\n/g, "<br>")}</td></tr>` : "";
  // Condition and recommendations are a LIST — each line was ticked off the
  // office's own list — so they print numbered, which is how a branch is walked
  // through them ("number 7 is the one to fix first").
  const listRow = (label, val) => has(val) ? `<tr><td class="l">${esc(label)}</td>
    <td><ol class="wl">${splitOptionValue(val).map(l => `<li>${esc(l)}</li>`).join("")}</ol></td></tr>` : "";
  const matRows = REPORT_MAT_FIELDS.filter(k => Number(rep[k]) > 0)
    .map(k => `<tr><td class="l">${esc(t(k))}</td><td>${esc(rep[k])}</td></tr>`).join("");
  const chemRows = (visit.chemicals || []).map(cu =>
    `<tr><td>${esc(localized(cu, "name"))}</td><td>${cu.quantity} ${esc(cu.unit || "")}</td>
     <td>${esc(usageMethod(cu))}</td><td>${esc(usageEquip(cu))}</td>
     <td>${esc(cu.area_treated || "—")}</td></tr>`).join("");
  // A signature is a PHOTOGRAPH of a signed page, so it is one of the pictures:
  // same class, same sizing, same page-fitting as any other attachment.
  const sig = (f, label) => f ? `<div class="bp-item sg"><img src="/uploads/${esc(f)}"><div class="ln">${esc(label)}</div></div>` : "";
  // "Business plan" attachments from the visit, surfaced on the printed report.
  const bpHtml = (visit.photos || []).filter(p => Number(p.is_business_plan)).map(p => {
    const isImg = /\.(jpe?g|png|gif|webp)$/i.test(p.filename || "");
    const cap = esc(p.caption || "");
    return isImg
      ? `<div class="bp-item"><img src="/uploads/${esc(p.filename)}"><div class="bp-cap">${cap}</div></div>`
      : `<div class="bp-item bp-file">📎 ${esc(p.original_name || p.filename)}<div class="bp-cap">${cap}</div></div>`;
  }).join("");
  // Captured images on the visit (excluding the business-plan ones shown below).
  const photoHtml = (visit.photos || []).filter(p =>
    !Number(p.is_business_plan) && /\.(jpe?g|png|gif|webp)$/i.test(p.filename || "")).map(p =>
    `<div class="bp-item"><img src="/uploads/${esc(p.filename)}"><div class="bp-cap">${esc(p.caption || "")}</div></div>`).join("");
  const reportRows = [
    row(t("summary"), rep.summary),
    listRow(t("condition"), rep.condition), listRow(t("recommendations"), rep.recommendations),
    // Retired fields: printed only where an older report recorded them.
    row(t("pests_found"), rep.pests_found), row(t("findings"), rep.findings),
    row(t("spare_parts_changed"), rep.spare_parts_changed),
    row(t("branch_issue"), rep.branch_issue),
  ].join("");
  return `<div class="sheet">
      <div class="top">
        <div style="display:flex;gap:12px;align-items:center">${logoHtml}
          <div class="co"><h1>${esc(compName)}</h1><div class="m">${esc(compAddr)}<br>${esc(S.phone || "")} · ${esc(S.email || "")}</div></div></div>
        <div class="rt"><h2>${esc(t("service_report"))}</h2>
          <div class="no">#${String(visit.id).padStart(5, "0")} · ${fmtDate(visit.completed_at || visit.scheduled_start)}</div></div>
      </div>
      <div class="meta">
        <div><span>${t("client")}:</span><b>${esc(localized(visit, "client") || "—")}</b></div>
        <div><span>${t("location_lbl")}:</span><b>${esc(visit.site_name || visit.location || "—")}</b></div>
        <div><span>${t("agent")}:</span><b>${esc(visit.agent_name || "—")}</b></div>
        <div><span>${t("service")}:</span><b>${esc(localized(visit, "service") || "—")}</b></div>
        ${visit.visit_number ? `<div><span>${t("visit_number")}:</span><b>${esc(visit.visit_number)}</b></div>` : ""}
        <div class="times">
          ${clk.start ? `<div><span>${clk.startActual ? t("visit_started_at") : t("scheduled_start")}:</span><b>${fmtDateTime(clk.start)}</b></div>` : ""}
          ${clk.end ? `<div><span>${clk.endActual ? t("visit_ended_at") : t("scheduled_end")}:</span><b>${fmtDateTime(clk.end)}</b></div>` : ""}
          ${clk.mins != null ? `<div><span>${t("duration")}:</span><b>${esc(fmtHours(clk.mins))}</b></div>` : ""}
        </div>
      </div>
      <h3 class="sec">${esc(t("report"))}</h3>
      <table class="kv">${reportRows}</table>
      ${matRows ? `<h3 class="sec">${esc(t("materials_used"))}</h3><table class="kv">${matRows}</table>` : ""}
      ${chemRows ? `<h3 class="sec">${esc(t("chemicals_applied"))}</h3>
        <table class="data"><thead><tr><th>${esc(t("name_en"))}</th><th>${esc(t("quantity"))}</th>
          <th>${esc(t("application_method"))}</th><th>${esc(t("application_equipment"))}</th>
          <th>${esc(t("area_treated"))}</th></tr></thead>
        <tbody>${chemRows}</tbody></table>` : ""}
      ${fuHtml ? `<h3 class="sec">🏷️ ${esc(t("followup_report"))}</h3>${fuHtml}` : ""}
      ${photoHtml ? `<h3 class="sec">📷 ${esc(t("photos"))}</h3><div class="bp-grid">${photoHtml}</div>` : ""}
      ${bpHtml ? `<h3 class="sec">${esc(t("business_plan"))}</h3><div class="bp-grid">${bpHtml}</div>` : ""}
      ${(rep.customer_signature || rep.technician_signature) ? `<div class="sigs">
        ${sig(rep.customer_signature, rep.customer_name || t("customer_signature"))}
        ${sig(rep.technician_signature, visit.agent_name || t("technician_signature"))}</div>` : ""}
    </div>`;
}

// Wrap one or more report sheets in a printable document. Each sheet starts a
// new page. autoPrint is off for the pages that go into a download bundle: a
// file that throws up a print dialog the moment it is opened is hostile when
// there are fifty of them in a folder.
function reportsDocHtml(sheets, title, autoPrint = true) {
  const ar = LANG === "ar";
  const dir = ar ? "rtl" : "ltr";
  const doc = `<!DOCTYPE html><html lang="${LANG}" dir="${dir}"><head><meta charset="utf-8">
    <title>${esc(title)}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
    <style>
      @page{size:A4;margin:14mm}
      *{box-sizing:border-box}
      body{font-family:${ar ? "'Cairo'" : "'Inter'"},system-ui,sans-serif;color:#1c2733;margin:0;padding:40px;font-size:13px}
      .sheet{max-width:760px;margin:auto;page-break-after:always;break-after:page}
      .sheet:last-of-type{page-break-after:auto;break-after:auto}
      .top{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #0f172a;padding-bottom:14px;margin-bottom:6px}
      .co h1{margin:0;font-size:17px;color:#c00000}.co .m{color:#64748b;font-size:11px;line-height:1.6}
      .rt{text-align:${ar ? "left" : "right"}}
      .rt h2{margin:0;font-size:20px;letter-spacing:.02em;color:#c00000}
      .rt .no{color:#64748b;font-size:12px;margin-top:3px}
      .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 22px;margin:16px 0 6px}
      .meta div{font-size:12px}.meta span{color:#64748b}.meta b{margin-${ar ? "right" : "left"}:6px}
      /* start, end and duration read as one line, not scattered through the grid */
      .meta .times{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px 22px}
      h3.sec{margin:20px 0 6px;font-size:11px;color:#c00000;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #e3e8ec;padding-bottom:4px}
      h4.fusec{margin:12px 0 4px;font-size:12px;color:#c00000}
      table{width:100%;border-collapse:collapse}
      .kv td{padding:7px 4px;vertical-align:top;line-height:1.6;border-bottom:1px solid #eef2f5}
      .kv td.l{color:#64748b;width:32%;white-space:nowrap}
      ol.wl{margin:0;padding-inline-start:20px}
      ol.wl li{line-height:1.6;padding-inline-start:2px}
      .data th,.data td{padding:8px 10px;text-align:${ar ? "right" : "left"};border-bottom:1px solid #e3e8ec}
      .data th{background:#f1f5f9;font-size:11px;text-transform:uppercase;color:#475569}
      .sev{display:inline-block;padding:3px 12px;border-radius:20px;font-weight:700;font-size:12px;color:#fff}
      /* THE SIGNATURE IS A PHOTOGRAPH, not ink drawn on the phone — the office
         signs paper and attaches the picture — so it prints at exactly the size
         an attachment does: its own .bp-item in a grid of its own, under the
         same 110mm cap, full width when it is wide and paired when it is tall.
         The row under it is the name, which is the only thing that makes it a
         signature and not just another photo. */
      .sigs{margin-top:30px;font-size:0}
      .sg{text-align:center}
      .sg .ln{border-top:1px solid #1c2733;margin-top:6px;padding-top:6px;color:#64748b;font-size:12px}
      /* PICTURES PRINT TWO TO A ROW, AT A THIRD OF THE PAGE'S HEIGHT. Printing
         them one to a row at the full width of the sheet made every picture a
         page of its own: a 4:3 photograph 182mm wide is 136mm tall, and a tall
         one was capped at 165mm, so an attachment or a signature took a whole
         sheet and left the rest of it white. Half the width and a 78mm cap put
         SIX pictures on a page and every one of them is still far bigger than
         the old 170px thumbnail, which was the complaint that started this.
         Sizing by max-width/max-height (not a fixed width) means the frame is
         still the picture: neither a wide shot nor a tall one gets a white
         letterbox inside its border. break-inside keeps a picture with its
         caption. Exactly 50% each (box-sizing is border-box up top) with the
         gutter as padding INSIDE the box — a margin between them would add up
         to more than the row and drop the second picture onto a line of its
         own. Plain blocks, not flex: page breaking inside a flex container is
         the one thing browsers still disagree about, and these have to
         paginate. */
      .bp-grid{margin-top:8px;font-size:0}
      /* EVERY picture takes the WHOLE width of the sheet, edge to edge, with no
         white down either side — his instruction, and it applies to signatures
         as much as to attachments. Since the page is upright and the pictures
         are not, the frame is a LANDSCAPE window 182mm wide: the picture fills
         it (object-fit:cover), so a photograph taken with the phone held
         upright is shown across its middle rather than printed as a tall strip
         with a white column each side. Two of those frames fit an A4 page. */
      .bp-item{display:block;width:100%;margin-bottom:14px;
        break-inside:avoid;page-break-inside:avoid;font-size:13px}
      /* 182 x 115mm is the frame. The width is the full text width of an A4
         sheet; the height is what lets TWO of them, captions and all, share a
         page (269mm inside the margins). A picture WIDER than the frame is
         simply scaled to fit it — nothing is lost. A picture TALLER than the
         frame is filled in and cropped top and bottom, which is the price of
         "no white at the sides"; the cap is as generous as two-to-a-page
         allows, so a portrait keeps the middle two thirds of its height. */
      .bp-item img{display:block;width:100%;height:115mm;object-fit:cover;object-position:center;
        border:1px solid #e3e8ec;border-radius:8px}
      /* A picture that is already wider than the frame must not be blown up to
         fill it — a shallow panorama would be cropped to nothing — so it keeps
         its own shape inside the same full width. */
      .bp-item img.is-wide{height:auto;max-height:115mm;object-fit:contain}
      .bp-file{padding:10px;border:1px solid #e3e8ec;border-radius:8px;font-size:12px;word-break:break-all}
      .bp-cap{color:#64748b;font-size:11px;margin-top:4px}
      .noprint{text-align:center;margin-bottom:18px}
      .pbtn{background:#0f172a;color:#fff;border:none;padding:10px 22px;border-radius:8px;font-size:14px;cursor:pointer}
      @media print{body{padding:0}.noprint{display:none}*{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}}
    </style></head><body>
    <div class="noprint"><button class="pbtn" onclick="window.print()">🖨️ ${esc(t("print"))}</button></div>
    ${sheets.join("\n")}
    <script>${IMAGES_READY_JS}\n${PHOTO_FIT_JS}<\/script>
    <script>${autoPrint ? PRINT_WHEN_LOADED : FIT_WHEN_LOADED}<\/script>
    </body></html>`;
  return doc;
}
function reportsPrintDoc(sheets, title) { printHtmlDoc(reportsDocHtml(sheets, title)); }

// A batch carries every report's photos and signatures, so printing on a fixed
// timer would hand the print dialog half-loaded images. Wait for the images
// instead. The ceiling is armed immediately rather than inside the load
// handler: an image that never settles also holds `load` back, and a print that
// never happens is worse than one missing a picture.
const IMAGES_READY_JS = `function pcWhenImagesReady(cb){
  var fired=false;
  /* The web fonts count too. They land after the images and change the height
     of every heading and table above the photos, which moves the photos down —
     measure before that and the page arithmetic below is out by a line. */
  function go(){ if(fired)return; fired=true;
    if(document.fonts && document.fonts.ready) document.fonts.ready.then(cb, cb); else cb(); }
  function arm(){
    var imgs=[].slice.call(document.images).filter(function(i){return !i.complete;});
    var left=imgs.length;
    if(!left) return go();
    imgs.forEach(function(i){
      function tick(){ if(--left<=0) go(); }
      i.addEventListener("load",tick); i.addEventListener("error",tick);
    });
  }
  if(document.readyState==="complete") arm(); else window.addEventListener("load",arm);
  setTimeout(go,12000);
}`;

// LAYING THE PICTURES OUT ONCE THEY HAVE LOADED. Two things can only be
// decided when the real photos are in hand, so they are done here rather than
// in the stylesheet:
//
//  1. WHICH PICTURES ARE TALL. A portrait photo can never fill the width of
//     the sheet, so on its own it leaves a column of white down each side.
//     Tall ones therefore go two to a row. (One tall picture on its own stays
//     centred and full size — pushing a lone photo into half the width would
//     make it smaller, not better.)
//
//  2. WHERE THE PAGES BREAK. "Keep the picture whole" is what leaves a page
//     half empty: a photo that will not fit in what is left of the page moves
//     down entire, and the gap it leaves behind is printed as white. So when
//     MORE THAN HALF the page is still free, the picture is shrunk into the
//     space that is left and stays on that page; when there is less room than
//     that, it still moves down whole, because shrinking it that far would
//     make it too small to read.
//
// The arithmetic is A4 at 96dpi less the 14mm @page margins — 182 x 269mm —
// and the document is measured at that width, because on screen (and inside
// the hidden print frame) it is laid out at some other size entirely and the
// heights would say nothing about where a printed page ends. Anything
// unexpected leaves the layout exactly as the stylesheet set it.
const PHOTO_FIT_JS = `function pcFitPhotos(){
  var PW=688, PH=1016;                      /* 182mm x 269mm at 96dpi */
  var body=document.body, prevW=body.style.width, prevPad=body.style.padding;
  body.style.padding="0"; body.style.width=PW+"px";
  try{
    /* A picture SHALLOWER than the frame (182 x 115mm, so wider than 1.58:1)
       keeps its own shape inside the full width instead of being blown up and
       cropped to a slot. Only the loaded image knows its own proportions, so it
       is marked here rather than in the markup. */
    [].slice.call(document.querySelectorAll(".bp-item img")).forEach(function(i){
      if(i.naturalWidth && i.naturalHeight && i.naturalWidth / i.naturalHeight > 182 / 115) {
        i.classList.add("is-wide");
      }
    });
    /* What the printer has to keep together: a paired row, or a lone picture —
       a signature being just another picture as far as the page is concerned. */
    var units=[].slice.call(document.querySelectorAll(
      ".bp-grid > .bp-item, .sigs > .bp-item"));
    /* A picture is under half a page tall now, so one that will not fit where
       it stands is better moved down whole than squeezed: only shrink one that
       just misses. */
    /* A picture the browser will push to the next page leaves the rest of its
       page blank, so everything after it starts that much further down: track
       it, or the second gap is measured against the wrong page. */
    var shift=0;
    units.forEach(function(it){
      var sheet=it.closest(".sheet"); if(!sheet) return;
      var imgs=[].slice.call(it.querySelectorAll("img"));
      var img=imgs[0]; if(!img) return;
      var cap=function(v){ imgs.forEach(function(m){ m.style.maxHeight=v; }); };
      cap("");
      function place(){
        var top=it.getBoundingClientRect().top-sheet.getBoundingClientRect().top+shift;
        return {room:PH-(top%PH), h:it.getBoundingClientRect().height};
      }
      var p=place();
      if(p.h<=p.room) return;
      /* Shrink it into what is left when MORE THAN HALF the page is still free
         — and also when the picture only just misses, because losing a
         fraction of one photo beats printing a third of a page of white. */
      if(!(p.room>=PH*0.5 || p.room>=p.h*0.75)){ shift+=p.room; return; }
      /* Both pictures of a pair take the SAME cap, so they stay the same size
         as each other however far the row has to come down. */
      /* Aim, then CHECK: a caption wraps, a line box carries a strut, the
         picture next to this one has just changed height. Re-measure and
         tighten until it really is inside the page, and if it cannot be, give
         up and let it move down whole rather than print it half off the page. */
      var cur=img.getBoundingClientRect().height;
      var target=Math.floor(p.room-(p.h-cur)-6);
      for(var k=0;k<5;k++){
        if(target<170){ cap(""); shift+=p.room; return; }   /* never below ~45mm */
        cap(target+"px");
        var q=place();
        if(q.h<=q.room-8) return;                    /* it fits — done */
        target=Math.floor(img.getBoundingClientRect().height-(q.h-(q.room-12)));
      }
      cap(""); shift+=place().room;
    });
  }catch(e){ /* leave the stylesheet's layout alone */ }
  body.style.width=prevW; body.style.padding=prevPad;
}`;

const PRINT_WHEN_LOADED = `(function(){
  pcWhenImagesReady(function(){
    try{ pcFitPhotos(); }catch(e){}
    setTimeout(function(){window.print();},250);
  });
})()`;

// The download bundle never prints itself (see reportsDocHtml), but its pages
// still have to be laid out — someone opens them later and prints from there.
const FIT_WHEN_LOADED = `(function(){
  pcWhenImagesReady(function(){ try{ pcFitPhotos(); }catch(e){} });
})()`;

function printReportDoc(visit, fuGroups) {
  const title = `${t("service_report")} #${String(visit.id).padStart(5, "0")}` +
    (localized(visit, "client") ? " - " + localized(visit, "client") : "");
  reportsPrintDoc([reportSheetHtml(visit, fuGroups)], title);
}

// Visit duration choices: 15 min up to 90 min in 5-minute steps.
function durationOpts() {
  const opts = [];
  for (let m = 15; m <= 90; m += 5) opts.push({ v: m, l: `${m} ${t("minutes")}` });
  return opts;
}
// How far a repeating date runs. "Every Sunday for a quarter" = the same
// weekday, week after week, until the horizon is up — so a year of a fixed
// slot is entered once instead of 52 times.
const VISIT_REPEATS = [
  { v: "none", months: 0 }, { v: "month", months: 1 }, { v: "quarter", months: 3 },
  { v: "half_year", months: 6 }, { v: "year", months: 12 },
];
const repeatMonths = (v) => (VISIT_REPEATS.find(r => r.v === v) || {}).months || 0;

// One picked date + repeat -> every "YYYY-MM-DDTHH:MM" it stands for.
function expandRepeat(dateStr, timeStr, repeat) {
  if (!dateStr) return [];
  const time = normHHMM(timeStr) || "09:00";
  const first = new Date(dateStr + "T00:00:00");
  if (isNaN(first)) return [];
  const months = repeatMonths(repeat);
  const until = new Date(first);
  until.setMonth(until.getMonth() + months);
  const out = [];
  let d = new Date(first);
  while (true) {
    out.push(ymd(d) + "T" + time);
    if (!months || out.length >= 200) break;   // 200 is the server's ceiling too
    const next = new Date(d);
    next.setDate(next.getDate() + 7);
    if (next > until) break;
    d = next;
  }
  return out;
}

// preset: prefilled fields for a new visit. opts.visit = edit that visit
// instead of creating; opts.after = run once something was saved (defaults to
// re-rendering whichever list the form was opened from).
function visitForm(preset, opts) {
  preset = preset || {};
  opts = opts || {};
  const editing = opts.visit || null;
  const src = editing || preset;
  const after = opts.after || reNavigate;
  const clientOpts = cache.clients.map(c => ({ v: c.id, l: clientLabel(c) }));
  const agentOpts = [{ v: "", l: t("none") }].concat(cache.agents.map(a => ({ v: a.id, l: a.full_name })));
  const svcOpts = [{ v: "", l: t("none") }].concat(cache.services.map(s => ({ v: s.id, l: localized(s, "name") })));
  const repOpts = VISIT_REPEATS.map(r => `<option value="${r.v}">${esc(t("rep_" + r.v))}</option>`).join("");
  // Editing keeps a single plain date; only new visits can fan out.
  const dateBlock = editing
    ? `<div class="form-grid">${dateTimeFields(t("scheduled_start"), "scheduled_start", editing.scheduled_start)}</div>`
    : `<div class="field full"><label>${t("visit_dates")}</label>
        <div class="vf-dates" id="vf-dates"></div>
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:6px">
          <button type="button" class="link-btn sm" id="vf-adddate">+ ${t("add_date")}</button>
          <span class="vf-preview" id="vf-preview"></span></div>
        <div class="muted small">${t("repeat_hint")}</div></div>`;
  const minsBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);
  const startDuration = editing && editing.scheduled_end
    ? minsBetween(editing.scheduled_start.replace(" ", "T"), editing.scheduled_end.replace(" ", "T")) : 30;
  openModal(t(editing ? "edit_visit" : "new_visit"), `<form id="vf"><div class="form-grid">
    ${field(t("client"), "client_id", { options: clientOpts, value: src.client_id, cls: "full" })}
    ${field(t("location_lbl"), "site_id", { options: [{ v: "", l: t("none") }], cls: "full" })}
    ${field(t("agent"), "agent_id", { options: agentOpts, value: src.agent_id })}
    ${field(t("service"), "service_type_id", { options: svcOpts, value: src.service_type_id })}
    ${can("contracts.view") ? `<div class="field full"><label>${t("nav_contracts")}</label>
      <select name="contract_id"><option value="">${t("ct_none")}</option></select>
      <div class="muted small">${t("visit_contract_hint")}</div></div>` : ""}
    ${dateBlock}
    ${field(t("duration"), "duration", { options: durationOpts(), value: startDuration })}
    ${field(t("location_detail"), "location", { value: src.location || "", cls: "full" })}
    ${field(t("notes"), "notes", { value: src.notes || "", textarea: true, cls: "full" })}
    </div><div class="form-actions"><button type="button" class="btn secondary" id="vf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("vf-x").addEventListener("click", closeModal);
    wireTimeInputs(root);      // the edit form's single time box (rows wire their own)
    const clientSel = root.querySelector("[name=client_id]");
    const siteSel = root.querySelector("[name=site_id]");
    const ctSel = root.querySelector("[name=contract_id]");
    const startClient = src.client_id || (clientSel && clientSel.value);
    loadSiteOptions(startClient, siteSel, src.site_id);
    loadContractOptions(startClient, ctSel, src.contract_id);
    if (clientSel) clientSel.addEventListener("change", () => {
      loadSiteOptions(clientSel.value, siteSel);
      loadContractOptions(clientSel.value, ctSel);
    });

    // ---- the date rows (new visits only) ----
    const datesBox = $("vf-dates");
    const rows = () => Array.from(datesBox.querySelectorAll(".vf-date-row"));
    function plannedDates() {
      const all = [];
      rows().forEach(r => expandRepeat(r.querySelector(".vf-date").value,
                                       r.querySelector(".vf-time").value,
                                       r.querySelector(".vf-rep").value)
        .forEach(s => { if (!all.includes(s)) all.push(s); }));
      return all.sort();
    }
    function refreshPreview() {
      const all = plannedDates();
      $("vf-preview").textContent = all.length
        ? t("visits_preview").replace("{n}", all.length)
            .replace("{first}", fmtDate(all[0])).replace("{last}", fmtDate(all[all.length - 1]))
        : "";
      rows().forEach(r => r.querySelector(".vf-rm").classList.toggle("hidden", rows().length < 2));
    }
    function addDateRow(date, time) {
      const row = document.createElement("div");
      row.className = "vf-date-row";
      row.innerHTML = `<input type="date" class="vf-date" value="${esc(date || "")}">
        <input class="vf-time hhmm" inputmode="numeric" maxlength="5" placeholder="HH:MM"
               autocomplete="off" value="${esc(time || "09:00")}">
        <select class="vf-rep">${repOpts}</select>
        <button type="button" class="link-btn danger sm vf-rm">✕</button>`;
      datesBox.appendChild(row);
      row.querySelector(".vf-rm").addEventListener("click", () => {
        if (rows().length > 1) { row.remove(); refreshPreview(); }
      });
      row.querySelectorAll("input,select").forEach(el =>
        el.addEventListener("change", refreshPreview));
      wireTimeInputs(row, refreshPreview);
      refreshPreview();
    }
    if (datesBox) {
      const p = String(preset.scheduled_start || "").replace("T", " ");
      addDateRow(p.slice(0, 10) || ymd(new Date()), p.slice(11, 16) || "09:00");
      $("vf-adddate").addEventListener("click", () => addDateRow(ymd(new Date()), "09:00"));
    }

    root.querySelector("#vf").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (siteSel && siteSel.dataset.hasSites === "1" && !siteSel.value) {
        alert(t("select_location")); siteSel.focus(); return;
      }
      const d = formData(root);
      const duration = Number(d.duration) || 0;
      delete d.duration;
      const starts = editing ? [readDateTime(root, d, "scheduled_start")].filter(Boolean)
                             : plannedDates();
      if (!starts.length) { alert(t("pick_a_date")); return; }
      // On a new visit a blank box just isn't filled in; on an edit it means
      // "take this off the visit", which has to reach the server as a null.
      const CLEARABLE = ["site_id", "agent_id", "service_type_id", "contract_id"];
      Object.keys(d).forEach(k => {
        if (d[k] !== "") return;
        if (editing && CLEARABLE.includes(k)) d[k] = null; else delete d[k];
      });
      let savedVisit = null;
      try {
        // One date = the plain single-visit call, so the "that agent is already
        // booked — schedule anyway?" prompt still applies. A repeat books the
        // whole run in one request and reports the clashes afterwards.
        if (starts.length === 1) {
          d.scheduled_start = starts[0];
          const end = addMinutes(starts[0], duration);
          if (end) d.scheduled_end = end;
          const saved = await postVisitWithConflictCheck(d, editing && editing.id);
          if (!saved) return;                       // user chose not to double-book
          if (handledOffline(saved)) return;
          savedVisit = saved;
          toast(t("saved"));
        } else {
          const res = await API.post("/visits/batch", { ...d, duration, dates: starts });
          if (handledOffline(res)) return;
          toast(t("visits_created").replace("{n}", res.created));
          if (res.conflicts && res.conflicts.length) {
            alert(t("visits_conflict_warn").replace("{n}", res.conflicts.length) + "\n\n" +
              res.conflicts.slice(0, 8).map(c => `• ${fmtDateTime(c.scheduled_start)} — ${c.client}`).join("\n"));
          }
        }
        // Deliberately stays on the list that opened this form: whoever is
        // filling a schedule wants the next row, not one visit's report.
        closeModal();
        // A single save hands the row back (and the branch NAME the picker was
        // showing, which the save itself does not return) so the list can put
        // that row back. A repeat booked many visits at once, and no single row
        // describes that — the list reloads for those.
        if (starts.length === 1 && savedVisit && savedVisit.id) {
          const so = siteSel && siteSel.selectedOptions && siteSel.selectedOptions[0];
          after(savedVisit, { site_name: (siteSel && siteSel.value && so)
            ? (so.dataset.name || so.textContent) : null });
        } else after();
      } catch (err) { alert(err.message); }
    });
  });
}

// "YYYY-MM-DDTHH:MM" + minutes, in the same format. "" when there's nothing to add.
function addMinutes(start, minutes) {
  if (!start || !minutes) return "";
  const d = new Date(start);
  if (isNaN(d)) return "";
  d.setMinutes(d.getMinutes() + Number(minutes));
  const pad = (n) => String(n).padStart(2, "0");
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The server answers 409 "agent_busy|<client>|<start>" when the agent already
// has an overlapping visit; ask before scheduling the clash anyway.
async function postVisitWithConflictCheck(d, visitId) {
  const send = () => visitId ? API.put(`/visits/${visitId}`, d) : API.post("/visits", d);
  try {
    return await send();
  } catch (err) {
    const m = /^agent_busy\|(.*)\|(.*)$/.exec(err.message || "");
    if (!m) throw err;
    if (!confirm(t("agent_busy_confirm").replace("{client}", m[1]).replace("{time}", m[2]))) return null;
    d.ignore_conflict = true;
    return send();
  }
}

// ---- visit detail ----
async function viewVisit(v, arg) {
  const id = arg.id;
  // Clients get the report auto-translated into the current language (read-only).
  // Staff edit the original text, so we don't translate the editable form.
  const langParam = role() === "client" ? `?lang=${LANG}` : "";
  const visit = await API.get("/visits/" + id + langParam);
  const canEdit = can("visits.edit");
  const rep = visit.report || {};
  // The condition/recommendation pick lists the report form draws from.
  if (role() !== "client") await loadReportOptions();
  // GPS check-in/out (staff-only; clients never receive these fields).
  const gpsLink = (lat, lng) => (lat != null && lng != null)
    ? `<a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${lat},${lng}">🗺️ ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}</a>`
    : `<span class="muted small">${t("checkin_no_gps_short")}</span>`;
  const siteDist = (lat, lng) => (lat != null && visit.site_lat != null)
    ? ` <span class="muted small">(≈${Math.round(haversineKm([lat, lng], [visit.site_lat, visit.site_lng]) * 1000)} ${t("m_from_site")})</span>` : "";
  const checkinHtml = role() === "client" ? "" : `
        <div>📍 ${t("check_in")}</div><div>${visit.checkin_at
          ? `${fmtDateTime(visit.checkin_at)} · ${gpsLink(visit.checkin_lat, visit.checkin_lng)}${siteDist(visit.checkin_lat, visit.checkin_lng)}`
          : (canEdit && ["scheduled", "in_progress"].includes(visit.status)
            ? `<button class="btn sm" id="v-checkin">📍 ${t("check_in")}</button>` : "—")}</div>
        ${visit.checkin_at ? `<div>🏁 ${t("check_out")}</div><div>${visit.checkout_at
          ? `${fmtDateTime(visit.checkout_at)} · ${gpsLink(visit.checkout_lat, visit.checkout_lng)}${siteDist(visit.checkout_lat, visit.checkout_lng)}`
          : (canEdit && visit.status !== "cancelled"
            ? `<button class="btn sm secondary" id="v-checkout">🏁 ${t("check_out")}</button>` : "—")}</div>` : ""}`;
  v.innerHTML = `
    <div class="breadcrumb" id="bc">← ${t("nav_schedule")}</div>
    <div class="page-head"><h2>${t("visit_detail")} — ${esc(localized(visit, "client"))}</h2>
      <div style="display:flex;gap:8px;align-items:center">
        ${visit.status === "completed" ? `<button class="btn sm" id="print-cert">📄 ${t("print_certificate")}</button>` : ""}
        ${(visit.status === "completed" && can("invoices.create")) ? `<button class="btn secondary sm" id="bill-visit">🧾 ${t("bill_this_visit")}</button>` : ""}
        ${statusBadge(visit.status)}</div></div>
    <div class="grid-2">
      <div class="panel"><h3>${t("nav_visits")}</h3><div class="kv">
        <div>${t("client")}</div><div>${esc(localized(visit, "client"))}</div>
        <div>${t("service")}</div><div>${esc(localized(visit, "service") || "—")}</div>
        <div>${t("agent")}</div><div>${esc(visit.agent_name || "—")}</div>
        <div>${t("scheduled_start")}</div><div>${fmtDateTime(visit.scheduled_start)}</div>
        <div>${t("location_lbl")}</div><div>${esc(visit.site_name || visit.location || "—")}</div>
        <div>${t("notes")}</div><div>${esc(visit.notes || "—")}</div>
        <div>${t("visit_number")}</div><div>${visit.visit_number
          ? `<b>${esc(visit.visit_number)}</b> <span class="muted small">${t("visit_number_auto")}</span>`
          : `<span class="muted">—</span>`}</div>
        ${checkinHtml}
      </div>
      ${canEdit && role() !== "agent" ? `<div class="form-actions" style="justify-content:flex-start;flex-wrap:wrap">
        <select id="v-site" style="min-width:140px"><option value="">${t("none")}</option></select>
        <button class="btn sm secondary" id="v-site-btn">📍 ${t("set_location")}</button></div>` : ""}
      ${canEdit && role() !== "agent" ? `<div class="form-actions" style="justify-content:flex-start">
        <select id="v-status">${["scheduled", "in_progress", "completed", "cancelled"].map(s => `<option value="${s}" ${visit.status === s ? "selected" : ""}>${t(statusKey(s))}</option>`).join("")}</select>
        <button class="btn sm" id="v-status-btn">${t("change_status")}</button></div>` : ""}
      ${visit.site_map_image ? `<div class="section-title" style="margin-top:12px"><h3>🗺️ ${t("site_map")}</h3></div>
        ${attachKind(visit.site_map_image) === "pdf"
          ? `<a class="btn secondary" href="/uploads/${esc(visit.site_map_image)}" target="_blank" rel="noopener"
               data-file-name="${esc(t("site_map"))}">📄 ${t("view_map_img")}</a>`
          : `<img src="/uploads/${esc(visit.site_map_image)}" alt="${esc(t("site_map"))}" style="width:100%;border:1px solid var(--line);border-radius:10px;display:block">`}` : ""}
      </div>
      <div class="panel"><div class="section-title"><h3>${t("report")}</h3>
        ${role() !== "client" && rep.id ? `<span class="badge b-${rep.status === "complete" ? "completed" : "draft"}">${t(rep.status === "complete" ? "report_complete" : "report_draft")}</span>` : ""}</div>
        ${role() === "client" ? clientReportView(rep) : reportForm(rep, id, canEdit, visit.transport)}
      </div>
    </div>

    ${visit.rating ? `<div class="panel"><h3>${t("visit_rating")}</h3>
      <div class="rated-stars">${"★".repeat(visit.rating.stars)}${"☆".repeat(5 - visit.rating.stars)}</div>
      ${visit.rating.comment ? `<div class="muted">${esc(visit.rating.comment)}</div>` : ""}</div>`
    : (role() === "client" && visit.status === "completed") ? `<div class="panel"><h3>${t("rate_this_visit")}</h3>
      <div class="stars-input" id="rate-stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-star="${n}">☆</button>`).join("")}</div>
      <textarea id="rate-comment" rows="2" placeholder="${t("rating_comment_ph")}" style="width:100%;margin-top:8px"></textarea>
      <div class="form-actions" style="justify-content:flex-start"><button class="btn sm" id="rate-send" disabled>${t("submit_rating")}</button></div>
    </div>` : ""}

    ${role() !== "client" ? `<div class="panel"><div class="section-title"><h3>${t("chemicals_used")}</h3>
      ${canEdit ? `<button class="btn sm" id="add-chem">+ ${t("add_chemical")}</button>` : ""}</div>
      <table><thead><tr><th>${t("name_en")}</th><th>${t("quantity")}</th>
        <th>${t("application_method")}</th><th>${t("application_equipment")}</th>
        <th>${t("area_treated")}</th><th></th></tr></thead>
      <tbody>${(visit.chemicals || []).map(cu => `<tr><td>${esc(localized(cu, "name"))}</td>
        <td>${cu.quantity} ${esc(cu.unit)}</td><td>${esc(usageMethod(cu))}</td>
        <td>${esc(usageEquip(cu))}</td><td>${esc(cu.area_treated || "—")}</td>
        <td>${canEdit ? `<button class="link-btn danger sm" data-rmuse="${cu.id}">${t("delete")}</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">${t("none")}</td></tr>`}</tbody></table></div>` : ""}

    ${role() !== "client" ? `<div class="panel" id="dev-coverage"><div class="section-title"><h3>🏷️ ${t("device_coverage")}</h3></div>
      <div class="muted">${t("loading")}</div></div>` : ""}

    <div class="panel"><div class="section-title"><h3>${t("attachments")}</h3>
      ${role() !== "client" ? `<button class="btn sm" id="add-photo">📎 ${t("add_attachment")}</button>` : ""}</div>
      <div id="photos" class="photo-grid"></div></div>

    <div class="panel"><div class="section-title"><h3>${t("signatures")}</h3></div>
      <div class="grid-2">${sigBlock("customer", visit, id, canEdit)}${
        // One signature is captured now. A report filed when there were two
        // still shows the second, read-only, rather than losing it.
        rep.technician_signature ? sigBlock("technician", visit, id, false) : ""}</div></div>

    ${canEdit && role() !== "client" ? `<div class="visit-save-bar">
      <div class="vsb-note"><span id="report-draft-hint" class="muted small"></span>
        <span class="muted small">${t("save_visit_hint")}</span></div>
      <button class="btn" id="v-save">${t("save_visit")}</button></div>` : ""}`;

  $("bc").addEventListener("click", () => navigate(role() === "client" ? "visits" : "schedule"));
  if ($("rate-stars")) {
    let picked = 0;
    const paint = () => $("rate-stars").querySelectorAll("[data-star]").forEach(b =>
      b.textContent = Number(b.dataset.star) <= picked ? "★" : "☆");
    $("rate-stars").querySelectorAll("[data-star]").forEach(b => b.addEventListener("click", () => {
      picked = Number(b.dataset.star); paint(); $("rate-send").disabled = false;
    }));
    $("rate-send").addEventListener("click", async () => {
      try {
        const r = await API.post(`/visits/${id}/rating`, { stars: picked, comment: $("rate-comment").value });
        if (handledOffline(r)) return;
        toast(t("rating_thanks")); navigate("visit", { id });
      } catch (err) { alert(err.message); }
    });
  }
  if ($("print-cert")) $("print-cert").addEventListener("click", async () => {
    if (!visit.report || visit.report.status !== "complete") {
      alert(t("no_report_for_cert")); return;
    }
    const vt = await API.get(`/visits/${id}?lang=${LANG}`);   // certificate in current language
    printCertificate(vt);
  });
  v.querySelectorAll("[data-sign]").forEach(b => b.addEventListener("click", () => signatureDialog(id, b.dataset.sign)));
  if ($("v-status-btn")) $("v-status-btn").addEventListener("click", async () => {
    const saved = await API.put("/visits/" + id, { status: $("v-status").value }); if (handledOffline(saved)) return; toast(t("saved")); navigate("visit", { id });
  });
  if ($("v-site")) {
    loadSiteOptions(visit.client_id, $("v-site"), visit.site_id, t("none"));
    $("v-site-btn").addEventListener("click", async () => {
      const saved = await API.put("/visits/" + id, { site_id: $("v-site").value || null });
      if (handledOffline(saved)) return; toast(t("saved")); navigate("visit", { id });
    });
  }
  if ($("report-form")) {
    const form = $("report-form");
    const hint = $("report-draft-hint");
    wireOptionPickers(form);
    // Auto-save as a draft while the agent types so an unfinished report is never
    // lost if they log out / close the app before completing it.
    let draftTimer = null, draftBusy = false;
    async function saveDraft() {
      if (draftBusy) return;
      draftBusy = true;
      try {
        const body = { ...formData(form), status: "draft" };
        const r = await API.post(`/visits/${id}/report`, body);
        if (r && r.__queued) {
          await patchCachedReport(id, body);
          if (hint) hint.textContent = "✓ " + t("saved_offline");
          return;
        }
        if (handledOffline(r)) return;
        if (hint) hint.textContent = "✓ " + t("draft_saved");
      } catch (e) { /* keep typing; will retry on next change */ }
      finally { draftBusy = false; }
    }
    form.addEventListener("input", () => {
      if (hint) hint.textContent = "…";
      clearTimeout(draftTimer);
      draftTimer = setTimeout(saveDraft, 1200);
    });
    // Finalise. Requires the core fields + both signatures (server-checked).
    // The button that triggers this sits OUTSIDE the report, at the foot of the
    // visit page, because it ends the whole visit — not just this one panel.
    async function completeReport() {
      clearTimeout(draftTimer);
      try {
        const done = { ...formData(form), status: "complete" };
        const saved = await API.post(`/visits/${id}/report`, done);
        if (saved && saved.__queued) await patchCachedReport(id, done);
        if (handledOffline(saved)) return;
        toast(t("report_completed"));
        navigate("visit", { id });
      } catch (err) {
        const msg = String(err && err.message || "");
        if (msg.startsWith("report_incomplete:")) {
          const keys = msg.slice("report_incomplete:".length).split(",").filter(Boolean);
          alert(t("report_incomplete_msg") + "\n\n• " + keys.map(reportFieldLabel).join("\n• "));
        } else {
          alert(msg || t("error"));
        }
      }
    }
    form.addEventListener("submit", (e) => { e.preventDefault(); completeReport(); });
    if ($("v-save")) $("v-save").addEventListener("click", completeReport);
  }
  if ($("add-chem")) $("add-chem").addEventListener("click", () => usageForm(id));
  v.querySelectorAll("[data-rmuse]").forEach(b => b.addEventListener("click", async () => {
    const r = await API.del("/usage/" + b.dataset.rmuse); if (handledOffline(r, b.closest("tr"))) return; navigate("visit", { id });
  }));
  // GPS check-in / check-out buttons.
  const wireCheck = (btnId, kind) => {
    if (!$(btnId)) return;
    $(btnId).addEventListener("click", async () => {
      $(btnId).disabled = true;
      try {
        const r = await doCheckin(id, kind);
        if (handledOffline(r)) return;
        toast(t("saved")); navigate("visit", { id });
      } catch (err) { alert(err.message); $(btnId).disabled = false; }
    });
  };
  wireCheck("v-checkin", "checkin");
  wireCheck("v-checkout", "checkout");
  // Transportation trips: add / remove (internal-only; own API, not report autosave).
  if ($("trip-add")) $("trip-add").addEventListener("click", async () => {
    const from_place = $("trip-from").value.trim(), to_place = $("trip-to").value.trim();
    const cost = $("trip-cost").value;
    if (!from_place && !to_place && !(Number(cost) > 0)) { alert(t("transport_need_info")); return; }
    try {
      const r = await API.post(`/visits/${id}/transport`, { from_place, to_place, cost });
      if (handledOffline(r)) return;
      navigate("visit", { id });
    } catch (err) { alert(err.message); }
  });
  v.querySelectorAll("[data-rmtrip]").forEach(b => b.addEventListener("click", async () => {
    const r = await API.del("/transport/" + b.dataset.rmtrip); if (handledOffline(r, b.closest("tr"))) return; navigate("visit", { id });
  }));
  renderPhotos("visit", id, (visit.photos || []).concat(visit.report_photos || []));
  if (role() !== "client") loadVisitCoverage(id);
  if ($("add-photo")) $("add-photo").addEventListener("click", () => uploadPhotoDialog("visit", id, () => navigate("visit", { id })));
}

// ---- areas (owner/manager) ----
// The parts of town the company works. A branch sits in one, a shift can cover
// one, and dispatch compares the two.
const areaLabel = (a) => (LANG === "ar" && a.name_ar) ? a.name_ar : a.name_en;
// The name to show for something that carries area_en/area_ar alongside its id.
const areaOf = (o) => o && (LANG === "ar" ? (o.area_ar || o.area_en) : (o.area_en || o.area_ar)) || "";
async function loadAreas(force) {
  if (cache.areas && !force) return cache.areas;
  cache.areas = await API.get("/areas").catch(() => []);
  return cache.areas;
}
// THE ENGINEERS A BRANCH MAY BE GIVEN TO. Engineers only: team leaders and
// managers are never auto-scheduled, so naming one would make a branch the
// planner could hand to nobody. Cached like the areas — the branch form and the
// schedule board both want it and neither should fetch it twice.
async function loadRosterAgents(force) {
  if (cache.rosterAgents && !force) return cache.rosterAgents;
  const rows = await API.get("/agents").catch(() => []);
  cache.rosterAgents = (Array.isArray(rows) ? rows : rows.items || [])
    .filter(u => u.role === "agent")
    .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
  return cache.rosterAgents;
}
// <select> of those. "" means "the roster decides", which is every branch until
// somebody is named — so it is the first option and the normal one.
function agentOptions(selected, anyLabel) {
  return `<option value="">${esc(anyLabel || t("agent_any"))}</option>` +
    (cache.rosterAgents || []).map(u =>
      `<option value="${u.id}"${String(u.id) === String(selected) ? " selected" : ""}>${
        esc(u.full_name)}</option>`).join("");
}

// <select> of areas. "" is a real choice — a shift with no area is a shift by
// hours alone, and a branch with no area simply never mismatches.
function areaOptions(selected, anyLabel) {
  return `<option value="">${esc(anyLabel || t("area_any"))}</option>` +
    (cache.areas || []).filter(a => a.active || String(a.id) === String(selected))
      .map(a => `<option value="${a.id}"${String(a.id) === String(selected) ? " selected" : ""}>${esc(areaLabel(a))}</option>`).join("");
}

async function viewAreas(v) {
  v.innerHTML = `<div class="page-head"><h2>${t("nav_areas")}</h2>
      <button class="btn sm" id="ar-add">+ ${t("add")}</button></div>
    <p class="muted">${t("areas_hint")}</p>
    <div class="panel" id="ar-list">${t("loading")}</div>
    <div class="page-head" style="margin-top:22px"><h2>${t("zones_title")}</h2>
      <button class="btn sm" id="zn-add">+ ${t("add")}</button></div>
    <p class="muted">${t("zones_hint")}</p>
    <div class="panel" id="zn-list">${t("loading")}</div>`;
  const render = async () => {
    const all = await loadAreas(true);
    if (!$("ar-list")) return;
    // A patch with work in it and nobody allowed to go is the gap that makes
    // the scheduler quietly skip customers, so it is named here rather than
    // being discovered halfway through a plan.
    const live = all.filter(a => a.active);
    const orphaned = live.filter(a => (a.branches || 0) > 0 && !(a.engineers || []).length);
    const unled = live.filter(a => !(a.managers || []).length);
    const crewCell = (a) => {
      const names = (a.engineers || []).map(e => esc(e.full_name));
      if (!names.length) {
        return (a.branches || 0) > 0
          ? `<span class="warn-line">⚠️ ${t("area_no_engineer")}</span>`
          : `<span class="muted small">${t("none")}</span>`;
      }
      return names.slice(0, 3).join(" · ") + (names.length > 3 ? ` +${names.length - 3}` : "");
    };
    $("ar-list").innerHTML = (orphaned.length || unled.length ? `<div class="loc-gaps">
        ${orphaned.length ? `<div class="warn-line">⚠️ ${
          t("areas_no_engineer").replace("{n}", orphaned.length)}: ${
          orphaned.slice(0, 6).map(a => esc(localized(a, "name"))).join(" · ")}</div>` : ""}
        ${unled.length ? `<div class="muted small">${
          t("areas_no_leader").replace("{n}", unled.length)}</div>` : ""}
      </div>` : "") + (all.length ? `<table><thead><tr>
        <th>${t("name_en")}</th><th>${t("name_ar")}</th><th>${t("branches_col")}</th>
        <th>${t("visits_per_month")}</th><th>${t("engineers_allowed")}</th>
        <th>${t("status")}</th><th></th>
      </tr></thead><tbody>${all.map(a => `<tr${a.active ? "" : ' class="muted"'}>
        <td>${esc(a.name_en)}</td><td>${esc(a.name_ar || "—")}</td>
        <td>${can("clients.edit")
              ? `<button class="link-btn ar-branches" data-branches="${a.id}"
                   title="${esc(t("area_branches_title"))}">${a.branches || 0}</button>`
              : (a.branches || 0)}</td><td>${(+a.visits_per_month || 0).toFixed(0)}</td>
        <td>${crewCell(a)}</td>
        <td>${a.active ? `<span class="badge b-completed">${t("active")}</span>`
                       : `<span class="badge">${t("inactive")}</span>`}</td>
        <td><div style="display:flex;gap:6px;justify-content:flex-end">
          ${can("clients.edit") ? `<button class="btn sm secondary" data-branches="${a.id}"
             title="${esc(t("area_branches_title"))}">📍</button>` : ""}
          <button class="btn sm secondary" data-edit="${a.id}">✏️</button>
          <button class="btn sm secondary danger" data-del="${a.id}">🗑️</button>
        </div></td></tr>`).join("")}</tbody></table>` : `<div class="empty">${t("none")}</div>`);
    v.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click",
      () => areaForm(all.find(a => a.id == b.dataset.edit), render)));
    // Both the 📍 button and the branch COUNT open the same picker: the count
    // is the thing the eye lands on when the question is "what is in here".
    v.querySelectorAll("[data-branches]").forEach(b => b.addEventListener("click",
      () => areaBranchesForm(all.find(a => a.id == b.dataset.branches), render)));
    v.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm(t("area_delete_confirm"))) return;
      await API.del("/areas/" + b.dataset.del);
      toast(t("deleted")); render();
    }));
  };
  // Zones sit under the areas because that is the order they are set up in:
  // draw the parts of town first, then say which of them are near each other.
  const renderZones = async () => {
    const zones = await API.get("/zones").catch(() => []);
    if (!$("zn-list")) return;
    $("zn-list").innerHTML = zones.length ? `<table><thead><tr>
        <th>${t("name_en")}</th><th>${t("areas_in_zone")}</th><th></th>
      </tr></thead><tbody>${zones.map(z => `<tr>
        <td><strong>${esc(localized(z, "name"))}</strong></td>
        <td>${(z.areas || []).map(a => `<span class="dp-area">${esc(areaLabel(a))}</span>`).join(" ")
             || `<span class="muted">${t("none")}</span>`}</td>
        <td><div style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn sm secondary" data-zedit="${z.id}">✏️</button>
          <button class="btn sm secondary danger" data-zdel="${z.id}">🗑️</button>
        </div></td></tr>`).join("")}</tbody></table>` : `<div class="empty">${t("none")}</div>`;
    v.querySelectorAll("[data-zedit]").forEach(b => b.addEventListener("click",
      () => zoneForm(zones.find(z => z.id == b.dataset.zedit), both)));
    v.querySelectorAll("[data-zdel]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm(t("zone_delete_confirm"))) return;
      await API.del("/zones/" + b.dataset.zdel);
      toast(t("deleted")); both();
    }));
  };
  // An area's zone can be changed from either side, so both lists redraw.
  const both = async () => { await render(); await renderZones(); };
  $("ar-add").addEventListener("click", () => areaForm(null, both));
  $("zn-add").addEventListener("click", () => zoneForm(null, both));
  render();
  renderZones();
}

// A zone is named and filled in one dialog — tick the areas that belong to it.
// Ticking here is the fast way round (four zones, 28 areas); the per-area form
// carries the same fact for a one-off correction.
async function zoneForm(zone, after) {
  zone = zone || {};
  const areas = (await loadAreas()).filter(a => a.active);
  const mine = new Set((zone.areas || []).map(a => a.id));
  openModal(t(zone.id ? "edit" : "add"), `<form id="zn-form">
      ${field(t("name_en"), "name_en", { value: zone.name_en, attrs: "required" })}
      ${field(t("name_ar"), "name_ar", { value: zone.name_ar })}
      <div class="field"><label>${esc(t("areas_in_zone"))}</label>
        <div class="chk-grid">${areas.map(a => `<label class="chk-item">
          <input type="checkbox" class="zn-area" value="${a.id}"${
            mine.has(a.id) ? " checked" : ""}><span>${esc(areaLabel(a))}</span></label>`).join("")
          || `<div class="muted">${t("none")}</div>`}</div></div>
      <div class="field"><label class="chk-item">
        <input type="checkbox" id="zn-own"${zone.own_day ? " checked" : ""}>
        <span>${esc(t("zone_own_day"))}</span></label>
        <div class="muted small">${t("zone_own_day_hint")}</div></div>
      <div class="form-actions">
        <button type="button" class="btn secondary" id="zn-x">${t("cancel")}</button>
        <button type="submit" class="btn">${t("save")}</button></div>
    </form>`, (root) => {
    $("zn-x").addEventListener("click", closeModal);
    $("zn-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { ...formData($("zn-form")) };
      body.area_ids = [...root.querySelectorAll(".zn-area:checked")].map(c => Number(c.value));
      body.own_day = $("zn-own").checked ? 1 : 0;
      try {
        const saved = zone.id ? await API.put("/zones/" + zone.id, body)
                              : await API.post("/zones", body);
        if (handledOffline(saved)) return;
        // A new zone is created before its membership can be sent, so the
        // ticks are applied in a second call.
        if (!zone.id && saved && saved.id && body.area_ids.length)
          await API.put("/zones/" + saved.id, { area_ids: body.area_ids });
        closeModal();
        await loadAreas(true);      // areas now carry a different zone_id
        toast(t("saved")); after();
      } catch (err) { alert(err.message); }
    });
  });
}

async function areaForm(area, after) {
  area = area || {};
  // Which zone this area belongs to — the grouping that lets one engineer hold
  // two nearby areas in a day.
  const zones = await API.get("/zones").catch(() => []);
  const zoneOpts = [{ v: "", l: t("zone_none") }].concat(
    zones.map(z => ({ v: z.id, l: localized(z, "name") })));
  openModal(t(area.id ? "edit" : "add"), `<form id="ar-form">
      ${field(t("name_en"), "name_en", { value: area.name_en, attrs: "required" })}
      ${field(t("name_ar"), "name_ar", { value: area.name_ar })}
      ${field(t("zone"), "zone_id", { options: zoneOpts, value: area.zone_id || "" })}
      ${field(t("sort_order"), "sort_order", { value: area.sort_order || 0, type: "number" })}
      <label class="check"><input type="checkbox" id="ar-active"${area.active === 0 ? "" : " checked"}>
        <span>${t("active")}</span></label>
      <div class="form-actions">
        <button type="button" class="btn secondary" id="ar-x">${t("cancel")}</button>
        <button type="submit" class="btn">${t("save")}</button></div>
    </form>`, () => {
    $("ar-x").addEventListener("click", closeModal);
    $("ar-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { ...formData($("ar-form")), active: $("ar-active").checked ? 1 : 0 };
      try {
        if (area.id) await API.put("/areas/" + area.id, body);
        else await API.post("/areas", body);
      } catch (err) { alert(err.message); return; }
      closeModal(); toast(t("saved")); after();
    });
  });
}

// FILLING A PATCH FROM THE AREA'S OWN ROW. The office thinks "which branches
// are in 5th Settlement", not "which area is this branch in" — and moving a
// dozen branches one dialog at a time is most of an afternoon. Tick them here
// instead: what is ticked belongs to this area, and only the ticks that were
// CHANGED are sent, so a branch nobody looked at is never touched.
async function areaBranchesForm(area, after) {
  let d;
  try { d = await API.get("/areas/" + area.id + "/branches"); }
  catch (err) { alert(err.message); return; }
  const rows = (d && d.branches) || [];
  const mine = (b) => String(b.area_id || "") === String(area.id);
  // What each branch looked like when the dialog opened — the delta is measured
  // against THIS, not against the server, so a save sends only real changes.
  const was = new Map(rows.map(b => [b.id, mine(b)]));
  const clients = [...new Map(rows.map(b =>
    [b.client_id, { id: b.client_id, name: localized(b, "client") }])).values()]
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const chip = (b) => mine(b)
    ? `<span class="ab-here">${esc(t("area_branches_here"))}</span>`
    : (b.area_id ? `<span class="dp-area">${esc(areaOf(b) || t("area_none"))}</span>`
                 : `<span class="muted small">${esc(t("area_none"))}</span>`);
  const rowHTML = (b) => `<label class="chk-item ab-row" data-id="${b.id}"
      data-client="${b.client_id}" data-in="${mine(b) ? 1 : 0}"
      data-other="${b.area_id && !mine(b) ? 1 : 0}">
      <input type="checkbox" class="ab-site" value="${b.id}"${mine(b) ? " checked" : ""}>
      <span class="ab-name"><strong>${esc(b.name)}</strong>
        <span class="muted small">${esc(localized(b, "client"))}</span></span>
      <span class="ab-tags">${chip(b)}${
        b.serviced ? "" : `<span class="muted small">${esc(t("inactive"))}</span>`}</span>
    </label>`;
  openModal(`📍 ${localized(area, "name")}`, `<div id="ab">
      <p class="muted small">${t("area_branches_hint")}</p>
      <div class="toolbar">
        <select id="ab-show">
          <option value="">${t("area_branches_show_all")}</option>
          <option value="in">${t("area_branches_show_in")}</option>
          <option value="other">${t("area_branches_show_other")}</option>
          <option value="free">${t("area_none")}</option>
        </select>
        <select id="ab-client"><option value="">${t("all_clients")}</option>
          ${clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
        <input id="ab-q" type="search" placeholder="${t("search")}…" style="max-width:200px">
        <button type="button" class="btn secondary sm" id="ab-all">${t("select_all")}</button>
        <button type="button" class="btn secondary sm" id="ab-none">${t("area_branches_clear")}</button>
      </div>
      <div class="chk-grid ab-list" id="ab-list">${rows.map(rowHTML).join("")
        || `<div class="empty">${t("none")}</div>`}</div>
      <div class="ab-sum" id="ab-sum"></div>
      <div class="form-actions">
        <button type="button" class="btn secondary" id="ab-x">${t("cancel")}</button>
        <button type="button" class="btn" id="ab-save">${t("save")}</button></div>
    </div>`, (root) => {
    const items = () => [...root.querySelectorAll(".ab-row")];
    const shown = () => items().filter(r => r.style.display !== "none");
    const boxes = () => [...root.querySelectorAll(".ab-site")];
    // The two lists the server is actually sent: what was ticked ON, and what
    // was ticked OFF. Everything else is left exactly as it is.
    const delta = () => {
      const add = [], drop = [];
      boxes().forEach(cb => {
        const id = Number(cb.value), before = was.get(id);
        if (cb.checked && !before) add.push(id);
        if (!cb.checked && before) drop.push(id);
      });
      return { add, drop };
    };
    const byId = new Map(rows.map(b => [b.id, b]));
    const sum = () => {
      const { add, drop } = delta();
      const ticked = boxes().filter(cb => cb.checked).map(cb => byId.get(Number(cb.value)));
      // COUNT WHAT THE AREAS PAGE COUNTS. That page counts branches the company
      // actually services, so a dialog that ticked 48 beside a row reading 43
      // would just look wrong; the switched-off ones are named on their own.
      const live = ticked.filter(b => b && b.serviced).length;
      const off = ticked.length - live;
      // Nearly every branch in the book has visits booked, so this is only
      // worth saying about the ones actually being moved.
      const booked = [...add, ...drop].reduce(
        (n, id) => n + (((byId.get(id) || {}).upcoming_visits) || 0), 0);
      $("ab-sum").innerHTML = `<div class="ab-sum-line"><span class="muted small">${
        t("area_branches_count").replace("{n}", live)}${off
          ? " · " + t("area_branches_off").replace("{n}", off) : ""}</span>`
        + (add.length || drop.length
          ? ` <strong class="ab-delta">${t("area_branches_delta")
              .replace("{a}", add.length).replace("{r}", drop.length)}</strong>` : "")
        + "</div>"
        // The sentence gets its own line: it is a warning, not a chip, and on a
        // phone it would otherwise push the counts off the edge.
        + (booked ? `<div class="ab-booked">📅 ${
            esc(t("area_branches_booked").replace("{n}", booked))}</div>` : "");
    };
    const applyFilter = () => {
      const show = $("ab-show").value, c = $("ab-client").value;
      const q = ($("ab-q").value || "").toLowerCase();
      items().forEach(r => {
        const okS = !show || (show === "in" ? r.dataset.in === "1"
          : show === "other" ? r.dataset.other === "1"
          : r.dataset.in === "0" && r.dataset.other === "0");
        const okC = !c || r.dataset.client === c;
        const okQ = !q || r.innerText.toLowerCase().includes(q);
        r.style.display = (okS && okC && okQ) ? "" : "none";
      });
    };
    ["ab-show", "ab-client"].forEach(id => $(id).addEventListener("change", applyFilter));
    $("ab-q").addEventListener("input", applyFilter);
    root.addEventListener("change", (e) => { if (e.target.closest(".ab-site")) sum(); });
    // The bulk gesture, and it touches ONLY what is on screen — filter to a
    // company or a search first and the rest of the book is left alone.
    const setShown = (on) => {
      shown().forEach(r => { r.querySelector(".ab-site").checked = on; });
      sum();
    };
    $("ab-all").addEventListener("click", () => setShown(true));
    $("ab-none").addEventListener("click", () => setShown(false));
    $("ab-x").addEventListener("click", closeModal);
    $("ab-save").addEventListener("click", async () => {
      const { add, drop } = delta();
      if (!add.length && !drop.length) { toast(t("nothing_to_save")); return; }
      // Taking a branch out of an area is not a small thing: the roster only
      // plans branches that have one, so it says so before it happens.
      if (drop.length && !confirm(t("area_branches_remove_confirm")
          .replace("{n}", drop.length))) return;
      try {
        const res = await API.post("/areas/" + area.id + "/branches",
                                   { assign: add, unassign: drop });
        if (handledOffline(res)) return;
        closeModal();
        toast(t("area_branches_saved").replace("{a}", res.assigned)
              .replace("{r}", res.unassigned));
        // `after` is the Areas page redrawing itself, and that already re-reads
        // the area list with its fresh branch counts. Reading it here as well
        // was 18 KB and a round trip for the same answer twice (2026-08-25).
        after();
      } catch (err) { alert(err.message); }
    });
    sum();
  });
}

// ---- report option lists (owner/manager) ----
// Two lists the office writes once so the field does not retype them: the site
// conditions an engineer can report, and the recommendations they can make.
async function viewReportOptions(v) {
  v.innerHTML = `<div class="page-head"><h2>${t("nav_report_options")}</h2></div>
    <p class="muted">${t("report_options_hint")}</p>
    <div class="grid-2">
      ${["condition", "recommendation"].map(k => `<div class="panel">
        <div class="section-title"><h3>${t(k === "condition" ? "conditions" : "recommendations")}</h3>
          <button class="btn sm" data-add="${k}">+ ${t("add")}</button></div>
        <div id="ro-${k}">${t("loading")}</div></div>`).join("")}
    </div>`;
  const render = async () => {
    const all = await loadReportOptions(true);
    // Someone can navigate away while the list is still loading; the page we
    // were filling in is then gone.
    if (!$("ro-condition")) return;
    ["condition", "recommendation"].forEach(k => {
      const rows = all.filter(o => o.kind === k);
      $("ro-" + k).innerHTML = rows.length ? `<table><thead><tr>
          <th>${t("name_en")}</th><th>${t("name_ar")}</th><th>${t("status")}</th><th></th>
        </tr></thead><tbody>${rows.map(o => `<tr${o.active ? "" : ' class="muted"'}>
          <td>${esc(o.name_en)}</td><td>${esc(o.name_ar || "—")}</td>
          <td>${o.active ? `<span class="badge b-completed">${t("active")}</span>`
                         : `<span class="badge">${t("inactive")}</span>`}</td>
          <td><div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="btn sm secondary" data-edit="${o.id}">✏️</button>
            <button class="btn sm secondary danger" data-del="${o.id}">🗑️</button>
          </div></td></tr>`).join("")}</tbody></table>`
        : `<div class="empty">${t("none")}</div>`;
    });
    v.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click",
      () => reportOptionForm(all.find(o => o.id == b.dataset.edit), render)));
    v.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      const o = all.find(x => x.id == b.dataset.del);
        if (!confirm(t("confirm_delete"))) return;
      await API.del("/report-options/" + o.id);
      toast(t("deleted")); render();
    }));
  };
  v.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click",
    () => reportOptionForm({ kind: b.dataset.add }, render)));
  render();
}

function reportOptionForm(opt, after) {
  opt = opt || {};
  const editing = !!opt.id;
  openModal(t(editing ? "edit" : "add"), `<form id="ro-form">
      ${field(t("name_en"), "name_en", { value: opt.name_en, attrs: "required" })}
      ${field(t("name_ar"), "name_ar", { value: opt.name_ar })}
      ${field(t("sort_order"), "sort_order", { value: opt.sort_order || 0, type: "number" })}
      <label class="check"><input type="checkbox" id="ro-active"${opt.active === 0 ? "" : " checked"}>
        <span>${t("active")}</span></label>
      <div class="form-actions">
        <button type="button" class="btn secondary" id="ro-x">${t("cancel")}</button>
        <button type="submit" class="btn">${t("save")}</button></div>
    </form>`, () => {
    $("ro-x").addEventListener("click", closeModal);
    $("ro-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { ...formData($("ro-form")), kind: opt.kind, active: $("ro-active").checked ? 1 : 0 };
      try {
        if (editing) await API.put("/report-options/" + opt.id, body);
        else await API.post("/report-options", body);
      } catch (err) { alert(err.message); return; }
      closeModal(); toast(t("saved")); after();
    });
  });
}

// The office keeps two lists — site conditions and recommendations — and the
// engineer ticks from them instead of typing. Which report column each list
// writes into:
const OPTION_FIELD = { condition: "condition", recommendation: "recommendations" };
const optionLabel = (o) => (LANG === "ar" && o.name_ar) ? o.name_ar : o.name_en;
// A stored value is the chosen wording, one per line — so a report keeps what
// it said even after the list is edited, and print/translate/export need no
// special case.
const splitOptionValue = (v) => String(v || "").split("\n").map(s => s.trim()).filter(Boolean);
// A stored line is the wording exactly as it was ticked — in whichever language
// the engineer had the CRM in at the time. Read it back through the office's
// list so whoever is reading now gets their own language; wording that has been
// edited off the list since is shown exactly as it was filed.
function wordingInLang(line) {
  const s = String(line || "").trim();
  const o = (cache.reportOptions || []).find(x =>
    (x.name_en || "").trim() === s || (x.name_ar || "").trim() === s);
  return o ? optionLabel(o) : s;
}
const localizedWording = (v) => splitOptionValue(v).map(wordingInLang);
// Picked wording as a numbered list — the form every read-only view shows it in.
const numberedWording = (v) => `<ol class="wording-list">${
  splitOptionValue(v).map(l => `<li>${esc(l)}</li>`).join("")}</ol>`;

function optionPicker(kind, label, value, canEdit) {
  const name = OPTION_FIELD[kind];
  const opts = (cache.reportOptions || []).filter(o => o.kind === kind && o.active);
  const chosen = localizedWording(value);
  const known = opts.map(optionLabel);
  // Wording an older report used that is no longer on the list: shown so it is
  // visible in the form it was filed with, never silently dropped.
  const legacy = chosen.filter(c => !known.includes(c));
  if (!opts.length) {
    return `<div class="field full"><label>${esc(label)}</label>
      <div class="muted small">${esc(t(canEdit && can("settings.edit") ? "opt_none_setup" : "opt_none_yet"))}</div>
      <input type="hidden" name="${name}" value="${esc(chosen.join("\n"))}">
      ${legacy.length ? `<div class="opt-legacy">${legacy.map(l => esc(l)).join("<br>")}</div>` : ""}</div>`;
  }
  const boxes = opts.map(o => {
    const text = optionLabel(o);
    return `<label class="opt-pick"><input type="checkbox" class="opt-cb" data-kind="${kind}"
      value="${esc(text)}"${chosen.includes(text) ? " checked" : ""}${canEdit ? "" : " disabled"}>
      <span>${esc(text)}</span></label>`;
  }).join("");
  return `<div class="field full"><label>${esc(label)}</label>
    <div class="opt-picks" data-picks="${kind}">${boxes}</div>
    <input type="hidden" name="${name}" id="opt-val-${kind}" value="${esc(chosen.join("\n"))}">
    ${legacy.length ? `<div class="opt-legacy"><span class="muted small">${esc(t("opt_previous"))}</span><br>${legacy.map(l => esc(l)).join("<br>")}</div>` : ""}</div>`;
}

// Ticking a box rewrites the hidden field the form actually submits, then tells
// the form so the draft auto-save picks the new value up rather than the value
// as it was before the tick.
function wireOptionPickers(root) {
  root.querySelectorAll(".opt-cb").forEach(cb => cb.addEventListener("change", () => {
    const kind = cb.dataset.kind;
    const hidden = root.querySelector("#opt-val-" + kind);
    if (!hidden) return;
    const picked = [...root.querySelectorAll(`.opt-cb[data-kind="${kind}"]`)]
      .filter(x => x.checked).map(x => x.value);
    hidden.value = picked.join("\n");
    hidden.dispatchEvent(new Event("input", { bubbles: true }));
  }));
}

async function loadReportOptions(force) {
  if (cache.reportOptions && !force) return cache.reportOptions;
  cache.reportOptions = await API.get("/report-options").catch(() => []);
  return cache.reportOptions;
}

function reportForm(rep, visitId, canEdit, trips) {
  const dis = canEdit ? "" : "disabled";
  // Transportation invoice — multiple trips per visit, stored separately from
  // the report (own API) so it stays outside the report autosave and outside
  // every client-facing / printed rendering.
  trips = trips || [];
  const tripTotal = trips.reduce((s, e) => s + (Number(e.cost) || 0), 0);
  const transportHtml = `
    <div class="section-title" style="margin:0 0 4px"><h3>🚕 ${t("transport_invoice")}</h3></div>
    <div class="muted small" style="margin-bottom:8px">${t("transport_internal_note")}</div>
    ${trips.length ? `<table><thead><tr><th>${t("transport_from")}</th><th>${t("transport_to")}</th>
        <th class="num">${t("transport_cost")} (${currencyLabel()})</th>${canEdit ? "<th></th>" : ""}</tr></thead>
      <tbody>${trips.map(e => `<tr>
        <td>${esc(e.from_place || (e.vehicle ? vehicleLabel(e.vehicle) : "—"))}</td>
        <td>${esc(e.to_place || "—")}</td><td class="num">${money(e.cost)}</td>
        ${canEdit ? `<td><button type="button" class="link-btn sm danger" data-rmtrip="${e.id}">✕ ${t("delete")}</button></td>` : ""}</tr>`).join("")}
      <tr><td colspan="2"><strong>${t("transport_total")}</strong></td>
        <td class="num"><strong>${money(tripTotal)}</strong></td>${canEdit ? "<td></td>" : ""}</tr></tbody></table>` : ""}
    ${canEdit ? `<div class="form-grid" style="align-items:end;margin-top:8px">
      <div class="field"><label>${t("transport_from")}</label>
        <input type="text" id="trip-from" maxlength="120"></div>
      <div class="field"><label>${t("transport_to")}</label>
        <input type="text" id="trip-to" maxlength="120"></div>
      <div class="field"><label>${t("transport_cost")} (${currencyLabel()})</label>
        <input type="number" step="any" min="0" id="trip-cost"></div>
      <div class="field"><label>&nbsp;</label>
        <button type="button" class="btn sm secondary" id="trip-add">+ ${t("transport_add")}</button></div>
    </div>` : ""}`;
  // The trip sheet heads the report: it is what the engineer fills in first,
  // and it stays OUTSIDE the <form> — its inputs belong to their own API, and
  // inside the form the report autosave would file them as report fields.
  return `${transportHtml}
    <form id="report-form">
    ${field(t("summary"), "summary", { value: rep.summary, textarea: true })}
    <!-- Pests found, findings and branch issue used to be typed here, and the
         "Service & Materials Used" block (spare parts + nine counters) before
         them. Condition and recommendations are chosen from the office's lists
         now. Every one of those columns stays in the database so older reports
         still print what they recorded, and each printed section hides itself
         when its field is empty. -->
    ${optionPicker("condition", t("condition"), rep.condition, canEdit)}
    ${optionPicker("recommendation", t("recommendations"), rep.recommendations, canEdit)}
    </form>${!canEdit ? "<script>document.querySelectorAll('#report-form [name]').forEach(e=>e.disabled=true)</script>" : ""}`;
}
function clientReportView(rep) {
  if (!rep || !rep.id) return `<div class="empty">${t("none")}</div>`;
  // material rows: only show the ones the engineer actually recorded
  const matKeys = ["lamps_used", "cables_used", "transformers_used", "light_sheets_used",
    "fipronil_ml", "imidacloprid_gm", "baits_count", "glo_pieces", "flybase_bags"];
  const mat = matKeys.filter(k => Number(rep[k]) > 0)
    .map(k => `<div>${t(k)}</div><div>${esc(rep[k])}</div>`).join("");
  return `<div class="kv">
    <div>${t("summary")}</div><div>${esc(rep.summary || "—")}</div>
    ${rep.condition ? `<div>${t("condition")}</div><div>${numberedWording(rep.condition)}</div>` : ""}
    <div>${t("recommendations")}</div><div>${rep.recommendations
      ? numberedWording(rep.recommendations) : "—"}</div>
    ${rep.pests_found ? `<div>${t("pests_found")}</div><div>${esc(rep.pests_found)}</div>` : ""}
    ${rep.findings ? `<div>${t("findings")}</div><div>${esc(rep.findings)}</div>` : ""}
    ${rep.spare_parts_changed ? `<div>${t("spare_parts_changed")}</div><div>${esc(rep.spare_parts_changed)}</div>` : ""}
    ${mat}
    ${rep.branch_issue ? `<div>${t("branch_issue")}</div><div>${esc(rep.branch_issue)}</div>` : ""}</div>`;
}
// Product label for a picker. The stock figure only appears for whoever can
// see the stock book — engineers get the catalog without inventory columns.
function chemLabel(c) {
  return c.quantity_in_stock === undefined
    ? `${localized(c, "name")} (${c.unit})`
    : `${localized(c, "name")} (${c.quantity_in_stock} ${c.unit})`;
}

// How a chemical was applied, and the kit used (mirrors the server's lists).
const APPLICATION_METHODS = ["by_hand", "spraying", "painting", "gel_application",
  "ulv_application", "dusting", "fogging"];
const APPLICATION_EQUIPMENT = ["sprayer", "brush", "duster", "ulv_machine", "hand", "fogger"];
// One usage row's method / equipment as printable text ("—" when not recorded).
const usageMethod = (cu) => cu.method ? t("am_" + cu.method) : "—";
const usageEquip = (cu) => cu.equipment ? t("aq_" + cu.equipment) : "—";

function usageForm(visitId) {
  // Everything the engineer was issued can be logged here — consumable materials
  // (UV lamps, glue boards, ...) included. They used to be counted on the report
  // instead and were kept out of this list so the same lamp could not be counted
  // twice; the report no longer carries those counters, so this is where a
  // material comes off the engineer's on-hand balance.
  const opts = cache.chemicals.map(c => ({ v: c.id, l: chemLabel(c) }));
  // Blank first: how it was applied and with what are optional, and a select
  // with no empty option would file its first entry on every row untouched.
  const blank = [{ v: "", l: "—" }];
  openModal(t("add_chemical"), `<form id="uf">
    ${field(t("name_en"), "chemical_id", { options: opts })}
    ${field(t("quantity"), "quantity", { type: "number" })}
    ${field(t("application_method"), "method",
      { options: blank.concat(APPLICATION_METHODS.map(k => ({ v: k, l: t("am_" + k) }))) })}
    ${field(t("application_equipment"), "equipment",
      { options: blank.concat(APPLICATION_EQUIPMENT.map(k => ({ v: k, l: t("aq_" + k) }))) })}
    ${field(t("area_treated"), "area_treated")}
    <div class="form-actions"><button type="button" class="btn secondary" id="uf-x">${t("cancel")}</button>
    <button class="btn" type="submit" id="uf-save">${t("save")}</button></div></form>`, (root) => {
    $("uf-x").addEventListener("click", closeModal);
    const save = async (e) => {
      if (e) e.preventDefault();
      try { const saved = await API.post(`/visits/${visitId}/usage`, formData(root)); if (handledOffline(saved)) return; closeModal(); navigate("visit", { id: visitId }); }
      catch (err) { alert(err.message); }
    };
    // Enter in a field submits the form; the button files it directly. Pressing
    // Save was reaching neither on this modal — the click raised no submit event
    // at all — so the button no longer depends on that path.
    root.querySelector("#uf").addEventListener("submit", save);
    $("uf-save").addEventListener("click", save);
  });
}

// ====================================================================
// Transportation — internal travel-cost log built from report entries.
// Agents see only their own trips (server-enforced); managers/admins also
// get cost roll-ups per branch / client / agent. Clients never see this.
// ====================================================================
async function viewTransport(v) {
  const mgr = hasAgentList();
  const clientOpts = `<option value="">${t("all")}</option>` +
    cache.clients.map(c => `<option value="${c.id}">${esc(clientLabel(c))}</option>`).join("");
  const agentSel = mgr
    ? `<label>${t("agent")}: <select id="tf-agent"><option value="">${t("all")}</option>${cache.agents.map(a => `<option value="${a.id}">${esc(a.full_name)}</option>`).join("")}</select></label>` : "";
  v.innerHTML = `<div class="page-head"><h2>${t("transport_title")}</h2></div>
    <div class="muted small" style="margin:-6px 0 12px">${t("transport_internal_note")}</div>
    <div class="toolbar">
      <label>${t("client")}: <select id="tf-client">${clientOpts}</select></label>
      <label>${t("location_lbl")}: <select id="tf-site"><option value="">${t("all")}</option></select></label>
      ${agentSel}
      <label>${t("from")}: <input type="date" id="tf-from"></label>
      <label>${t("to")}: <input type="date" id="tf-to"></label>
    </div>
    <div class="cards" id="tr-cards"></div>
    <div class="panel" id="tr-list">${t("loading")}</div>
    <div id="tr-groups"></div>`;
  const val = (id) => ($(id) && $(id).value) || "";
  function buildQuery(page) {
    const p = [`page=${page}`, `limit=${PAGE_SIZE}`];
    if (val("tf-client")) p.push("client=" + val("tf-client"));
    if (val("tf-site")) p.push("site=" + val("tf-site"));
    if (val("tf-agent")) p.push("agent=" + val("tf-agent"));
    if (val("tf-from")) p.push("from=" + val("tf-from"));
    if (val("tf-to")) p.push("to=" + val("tf-to"));
    return p.join("&");
  }
  const card = (val2, label, icon, cls) =>
    `<div class="stat-card ${cls}"><div class="sc-ic">${icon}</div><div><div class="v">${val2}</div><div class="l">${label}</div></div></div>`;
  const groupTable = (title, rows, nameCell) => rows.length ? `<div class="panel">
      <div class="section-title"><h3>${title}</h3></div>
      <table><thead><tr><th>${t("name_en")}</th><th class="num">${t("transport_trips")}</th><th class="num">${t("transport_total")}</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${nameCell(r)}</td><td class="num">${r.trips}</td><td class="num"><strong>${money(r.total)}</strong></td></tr>`).join("")}</tbody></table></div>` : "";
  async function refresh(page = 1) {
    const d = await API.get("/transport?" + buildQuery(page));
    $("tr-cards").innerHTML =
      card(money(d.total), t("transport_total"), "💰", "c-amber") +
      card(d.trips, t("transport_trips"), "🚕", "c-blue");
    const rows = (d.items || []).map(r => `<tr data-visit="${r.visit_id}">
      <td>${fmtDate(r.scheduled_start)}</td>
      ${mgr ? `<td>${esc(r.agent_name || "—")}</td>` : ""}
      <td>${esc(localized(r, "client"))}</td>
      <td>${esc(r.site_name || "—")}</td>
      <td>${esc(tripLabel(r))}</td>
      <td class="num"><strong>${money(r.transport_cost)}</strong></td></tr>`).join("");
    $("tr-list").innerHTML = `<table><thead><tr>
        <th>${t("date")}</th>${mgr ? `<th>${t("agent")}</th>` : ""}<th>${t("client")}</th>
        <th>${t("location_lbl")}</th><th>${t("transport_route")}</th><th class="num">${t("transport_cost")}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="empty">${t("none")}</td></tr>`}</tbody></table>` + pagerHTML(d);
    $("tr-list").querySelectorAll("tr[data-visit]").forEach(tr =>
      tr.addEventListener("click", () => navigate("visit", { id: tr.dataset.visit })));
    wirePager($("tr-list"), d, refresh);
    $("tr-groups").innerHTML = mgr
      ? groupTable(`🏢 ${t("transport_by_branch")}`, d.by_branch || [],
          r => `${esc(localized(r, "client"))}<div class="muted small">${esc(r.site_name || "—")}</div>`) +
        groupTable(`👥 ${t("transport_by_client")}`, d.by_client || [], r => esc(localized(r, "client"))) +
        groupTable(`👷 ${t("transport_by_agent")}`, d.by_agent || [], r => esc(r.agent_name || "—"))
      : "";
  }
  $("tf-client").addEventListener("change", async () => {
    const cid = val("tf-client"), sel = $("tf-site");
    if (!cid) { sel.innerHTML = `<option value="">${t("all")}</option>`; refresh(1); return; }
    await loadSiteOptions(cid, sel, "", t("all"));
    if (sel.dataset.hasSites === "1") sel.insertAdjacentHTML("beforeend", `<option value="none">${t("unassigned")}</option>`);
    refresh(1);
  });
  ["tf-site", "tf-agent", "tf-from", "tf-to"].forEach(id => {
    if ($(id)) $(id).addEventListener("change", () => refresh(1));
  });
  refresh(1);
}

// ====================================================================
// Chemicals & inventory
// ====================================================================
// ====================================================================
// IPM file library — company-wide PDFs, one shelf for everyone
// ====================================================================
// Staff publish here; every client sees the same list. A document flagged
// internal stays with the office (the server hides it from the list AND
// refuses the /uploads fetch), so the visibility column only exists for staff.
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

async function viewIpm(v) {
  const files = await API.get("/ipm-files");
  const manage = can("ipm.edit");
  const cols = manage ? 6 : 5;
  v.innerHTML = `<div class="page-head"><h2>${t("nav_ipm")}</h2>
    ${can("ipm.create") ? `<button class="btn" id="ipm-add">+ ${t("ipm_add")}</button>` : ""}</div>
    <div class="panel">
      <p class="muted small" style="margin:0 0 10px">${t("ipm_hint")}</p>
      <table><thead><tr>
        <th>${t("ipm_doc_title")}</th><th>${t("description")}</th><th>${t("file_size")}</th>
        <th>${t("date")}</th>${manage ? `<th>${t("ipm_visibility")}</th>` : ""}<th>${t("actions")}</th>
      </tr></thead><tbody>${files.map(f => `<tr>
        <td translate="no" class="notranslate"><strong>${
          /\.pdf$/i.test(f.filename) ? "📄" : "🖼️"} ${esc(f.title)}</strong>
          <div class="muted small">${esc(f.original_name || "")}</div></td>
        <td translate="no" class="notranslate">${esc(f.description || "—")}</td>
        <td>${fmtBytes(f.size_bytes)}</td>
        <td>${fmtDate(f.updated_at || f.created_at)}</td>
        ${manage ? `<td>${f.visible_to_clients
          ? `<span class="badge b-completed">${t("ipm_published")}</span>`
          : `<span class="badge b-draft">${t("ipm_internal")}</span>`}</td>` : ""}
        <td><a class="link-btn sm" href="/uploads/${esc(f.filename)}" target="_blank" rel="noopener"
            data-file-name="${esc(f.title || f.original_name || "")}">${t("open")}</a>
          ${manage ? ` · <button class="link-btn sm" data-ipm-edit="${f.id}">${t("edit")}</button>` : ""}
          ${can("ipm.delete") ? ` · <button class="link-btn danger sm" data-ipm-del="${f.id}">${t("delete")}</button>` : ""}
        </td></tr>`).join("") || `<tr><td colspan="${cols}" class="empty">${t("ipm_none")}</td></tr>`}
      </tbody></table></div>`;
  if ($("ipm-add")) $("ipm-add").addEventListener("click", () => ipmForm());
  v.querySelectorAll("[data-ipm-edit]").forEach(b => b.addEventListener("click", () =>
    ipmForm(files.find(f => f.id == b.dataset.ipmEdit))));
  v.querySelectorAll("[data-ipm-del]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("confirm_delete"))) return;
    try {
      await API.del(`/ipm-files/${b.dataset.ipmDel}`);
      toast(t("ipm_deleted")); navigate("ipm");
    } catch (e) { alert(e.message); }
  }));
}

// Add or edit one document. On edit the PDF is optional — leaving the file
// picker empty keeps the current copy and only rewrites the metadata.
function ipmForm(f) {
  const isEdit = !!f; f = f || {};
  const visible = isEdit ? !!f.visible_to_clients : true;
  openModal(isEdit ? t("edit") : t("ipm_add"), `<form id="ipmf"><div class="form-grid">
    ${field(t("ipm_doc_title"), "title", { value: f.title, cls: "full", attrs: "required" })}
    ${field(t("description"), "description", { value: f.description, textarea: true, cls: "full" })}
    <div class="field full"><label>${isEdit ? t("ipm_replace_file") : t("ipm_file_pdf")}</label>
      <input type="file" id="ipm-file" accept="application/pdf,.pdf,image/*" ${isEdit ? "" : "required"}>
      <div class="muted small">${t("ipm_file_hint")}</div></div>
    <div class="field full"><label><input type="checkbox" id="ipm-visible" ${visible ? "checked" : ""}>
      ${t("ipm_visible")}</label>
      <div class="muted small">${t("ipm_visible_hint")}</div></div>
    </div><div class="form-actions"><button type="button" class="btn secondary" id="ipmf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("ipmf-x").addEventListener("click", closeModal);
    root.querySelector("#ipmf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      // Checkboxes aren't values — formData() only reads .value.
      d.visible_to_clients = $("ipm-visible").checked ? "1" : "0";
      const file = $("ipm-file").files[0];
      if (!isEdit && !file) { alert(t("ipm_file_pdf")); return; }
      try {
        if (file) await API.uploadDoc(isEdit ? `/ipm-files/${f.id}/file` : "/ipm-files", file, d);
        else await API.put(`/ipm-files/${f.id}`, d);
        closeModal(); toast(t("saved")); navigate("ipm");
      } catch (err) { alert(err.message); }
    });
  });
}

async function viewChemicals(v) {
  const chems = await API.get("/chemicals");
  v.innerHTML = `<div class="page-head"><h2>${t("chemicals_title")}</h2>
    <div style="display:flex;gap:8px">
    ${can("chemicals.edit") ? `<button class="btn secondary" id="stock-in">📦 ${t("stock_in")}</button>` : ""}
    ${can("chemicals.create") ? `<button class="btn" id="add-chem">+ ${t("new_chemical")}</button>` : ""}</div></div>
    <div class="panel"><table><thead><tr>
      <th>${t("name_en")}</th><th>${t("active_ingredient")}</th><th>${t("in_stock")}</th>
      <th>${t("reorder_level")}</th><th>${t("hazard_class")}</th><th>${t("expiry_date")}</th>${can("chemicals.edit") ? `<th>${t("actions")}</th>` : ""}</tr></thead>
      <tbody>${chems.map(c => {
        const low = c.quantity_in_stock <= c.reorder_level;
        return `<tr><td><strong>${esc(localized(c, "name"))}</strong><div class="muted small">${esc(c.reg_no || "")}</div></td>
        <td>${esc(c.active_ingredient || "—")}</td>
        <td class="${low ? "lowstock" : ""}">${c.quantity_in_stock} ${esc(c.unit)} ${low ? `· ${t("low_stock_warn")}` : ""}</td>
        <td>${c.reorder_level} ${esc(c.unit)}</td><td>${esc(c.hazard_class || "—")}</td>
        <td>${expiryCell(c.expiry_date)}</td>
        ${can("chemicals.edit") ? `<td><button class="link-btn sm" data-stock="${c.id}">${t("adjust_stock")}</button>
          · <button class="link-btn sm" data-edit="${c.id}">${t("edit")}</button></td>` : ""}</tr>`;
      }).join("") || `<tr><td colspan="7" class="empty">${t("none")}</td></tr>`}</tbody></table></div>
    <div class="panel"><div class="section-title"><h3>📦 ${t("purchase_history")}</h3></div>
      <div id="po-box">${t("loading")}</div></div>`;
  if ($("add-chem")) $("add-chem").addEventListener("click", () => chemForm());
  if ($("stock-in")) $("stock-in").addEventListener("click", () => purchaseOrderForm(chems));
  v.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () =>
    chemForm(chems.find(c => c.id == b.dataset.edit))));
  v.querySelectorAll("[data-stock]").forEach(b => b.addEventListener("click", () => stockForm(b.dataset.stock)));
  API.get("/purchase-orders").then(pos => {
    const box = $("po-box");
    if (!box) return;
    // A purchase is a cost record: it has to be correctable. Editing moves
    // stock by the difference, so the count stays true to what was bought.
    const canEdit = can("chemicals.edit"), canDel = can("chemicals.delete");
    box.innerHTML = pos.length ? `<table><thead><tr>
        <th>${t("date")}</th><th>${t("supplier")}</th><th>${t("reference")}</th>
        <th>${t("line_items")}</th><th class="num">${t("unit_cost")}</th><th class="num">${t("total")}</th>
        <th>${t("recorded_by")}</th>${canEdit || canDel ? `<th>${t("actions")}</th>` : ""}</tr></thead>
      <tbody>${pos.map(po => `<tr>
        <td>${fmtDate(po.created_at)}</td><td>${esc(po.supplier || "—")}</td><td>${esc(po.reference || "—")}</td>
        <td>${po.items.map(it => `${esc(localized(it, "name"))} × ${it.quantity} ${esc(it.unit || "")}`).join("<br>")}</td>
        <td class="num">${po.items.map(it => money(it.unit_cost)).join("<br>")}</td>
        <td class="num">${money(po.total_cost)}</td><td>${esc(po.created_by_name || "—")}</td>
        ${canEdit || canDel ? `<td>
          ${canEdit ? `<button class="link-btn sm" data-po-edit="${po.id}">${t("edit")}</button>` : ""}
          ${canEdit && canDel ? " · " : ""}
          ${canDel ? `<button class="link-btn danger sm" data-po-del="${po.id}">${t("delete")}</button>` : ""}
        </td>` : ""}</tr>`).join("")}</tbody></table>`
      : `<div class="empty">${t("none")}</div>`;
    box.querySelectorAll("[data-po-edit]").forEach(b => b.addEventListener("click", () =>
      purchaseOrderForm(chems, pos.find(p => p.id == b.dataset.poEdit))));
    box.querySelectorAll("[data-po-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm(t("po_delete_confirm"))) return;
      try {
        await API.del("/purchase-orders/" + b.dataset.poDel);
        toast(t("po_deleted")); navigate("chemicals");
      } catch (e) { alert(e.message); }
    }));
  }).catch(() => { const box = $("po-box"); if (box) box.innerHTML = ""; });
}

// Stock-in: one purchase order with several chemical lines; posting it
// increments inventory and writes the 'purchase' transactions atomically.
// With `po` it edits that purchase instead — the server moves stock by the
// difference, so correcting a typo doesn't need a compensating adjustment.
function purchaseOrderForm(chems, po) {
  const isEdit = !!po; po = po || {};
  const opt = (c, sel) => `<option value="${c.id}" ${String(sel) === String(c.id) ? "selected" : ""}>${esc(localized(c, "name"))} (${esc(c.unit)})</option>`;
  const line = (it) => `<tr class="po-row">
    <td><select class="po-chem">${chems.map(c => opt(c, it && it.chemical_id)).join("")}</select></td>
    <td><input class="po-qty" type="number" step="any" min="0" value="${it ? it.quantity : 1}" style="width:80px"></td>
    <td><input class="po-cost" type="number" step="any" min="0" value="${it ? it.unit_cost : 0}" style="width:100px"></td>
    <td><button type="button" class="link-btn danger sm po-rm">✕</button></td></tr>`;
  const rows = (po.items && po.items.length ? po.items.map(line) : [line()]).join("");
  openModal(isEdit ? t("po_edit") : t("stock_in"), `<form id="pof"><div class="form-grid">
    ${field(t("supplier"), "supplier", { value: po.supplier })}
    ${field(t("reference"), "reference", { value: po.reference })}
    <div class="full"><label>${t("line_items")}</label>
      <table class="li-table"><thead><tr><th>${t("name_en")}</th><th>${t("quantity")}</th>
        <th>${t("unit_cost")}</th><th></th></tr></thead><tbody id="po-body">${rows}</tbody></table>
      <button type="button" class="btn secondary sm" id="po-add" style="margin-top:8px">${t("add_line")}</button></div>
    ${field(t("notes"), "note", { cls: "full", value: po.note })}
    ${isEdit ? `<div class="full muted small">${t("po_edit_hint")}</div>` : ""}
    </div><div class="form-actions"><button type="button" class="btn secondary" id="pof-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("pof-x").addEventListener("click", closeModal);
    $("po-add").addEventListener("click", () => {
      const tb = document.createElement("tbody"); tb.innerHTML = line();
      root.querySelector("#po-body").appendChild(tb.firstElementChild);
    });
    root.addEventListener("click", (e) => { if (e.target.classList.contains("po-rm")) e.target.closest("tr").remove(); });
    root.querySelector("#pof").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      d.items = [...root.querySelectorAll(".po-row")].map(r => ({
        chemical_id: r.querySelector(".po-chem").value,
        quantity: r.querySelector(".po-qty").value,
        unit_cost: r.querySelector(".po-cost").value,
      })).filter(it => Number(it.quantity) > 0);
      if (!d.items.length) { alert(t("po_needs_line")); return; }
      try {
        const saved = isEdit ? await API.put("/purchase-orders/" + po.id, d)
                             : await API.post("/purchase-orders", d);
        if (handledOffline(saved)) return;
        closeModal(); toast(isEdit ? t("saved") : t("stock_received"));
        cache.chemicals = await API.get("/chemicals");
        navigate("chemicals");
      } catch (err) { alert(err.message); }
    });
  });
}

// Expiry cell: red badge when past, amber when within 60 days, else the date.
function expiryCell(d) {
  if (!d) return "—";
  const days = Math.floor((new Date(d) - new Date()) / 86400000);
  if (days < 0) return `<span class="badge b-cancelled">${t("expired")}</span> <span class="muted small">${fmtDate(d)}</span>`;
  if (days <= 60) return `<span class="badge b-draft">${t("expires_soon")}</span> <span class="muted small">${fmtDate(d)}</span>`;
  return fmtDate(d);
}

function chemForm(c) {
  const isEdit = !!c; c = c || {};
  const units = ["L", "ml", "kg", "g", "unit"].map(u => ({ v: u, l: u }));
  openModal(isEdit ? t("edit") : t("new_chemical"), `<form id="chf"><div class="form-grid">
    ${field(t("name_en"), "name_en", { value: c.name_en })}
    ${field(t("name_ar"), "name_ar", { value: c.name_ar })}
    ${field(t("active_ingredient"), "active_ingredient", { value: c.active_ingredient })}
    ${field(t("unit"), "unit", { options: units, value: c.unit })}
    ${isEdit ? "" : field(t("in_stock"), "quantity_in_stock", { type: "number", value: c.quantity_in_stock || 0 })}
    ${field(t("reorder_level"), "reorder_level", { type: "number", value: c.reorder_level || 0 })}
    ${field(t("hazard_class"), "hazard_class", { value: c.hazard_class })}
    ${field(t("reg_no"), "reg_no", { value: c.reg_no })}
    ${field(t("cost_per_unit"), "cost_per_unit", { type: "number", value: c.cost_per_unit || 0 })}
    ${field(t("expiry_date"), "expiry_date", { type: "date", value: (c.expiry_date || "").slice(0, 10) })}
    </div><div class="form-actions"><button type="button" class="btn secondary" id="chf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("chf-x").addEventListener("click", closeModal);
    root.querySelector("#chf").addEventListener("submit", async (e) => {
      e.preventDefault();
      try { const saved = isEdit ? await API.put("/chemicals/" + c.id, formData(root)) : await API.post("/chemicals", formData(root));
        if (handledOffline(saved)) return;
        // The screen re-reads the list as it redraws; re-reading it HERE as
        // well was the same 5 KB answer twice. The dropdown cache is corrected
        // from the row that was just saved instead.
        closeModal(); patchChemicalCache(saved); navigate("chemicals"); }
      catch (err) { alert(err.message); }
    });
  });
}
function stockForm(id) {
  const reasons = [{ v: "purchase", l: t("add_stock") }, { v: "adjustment", l: t("adjust_stock") }];
  openModal(t("adjust_stock"), `<form id="sf">
    ${field(t("stock_change"), "change", { type: "number" })}
    ${field(t("actions"), "reason", { options: reasons })}
    ${field(t("notes"), "note")}
    <div class="form-actions"><button type="button" class="btn secondary" id="sf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("sf-x").addEventListener("click", closeModal);
    root.querySelector("#sf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const saved = await API.post(`/chemicals/${id}/stock`, formData(root));
      if (handledOffline(saved)) return;
      closeModal();
      patchChemicalCache(saved); navigate("chemicals");
    });
  });
}

// ====================================================================
// Engineer material issues (stock checked out of inventory by an engineer)
// ====================================================================
// Per-engineer materials balance: issued − used (on their visits) = remaining.
function renderIssueBalance(balance, mine) {
  const engineers = (balance && balance.engineers) || [];
  if (!engineers.length) return "";
  const qty = (n, unit) => `${(+n || 0).toLocaleString()} ${esc(unit || "")}`.trim();
  const block = (e) => {
    if (!e.materials.length) return "";
    const rows = e.materials.map(m => {
      const low = m.remaining <= 0;
      return `<tr${low ? ` class="bal-empty"` : ""}>
        <td>${esc(localized(m, "name") || ("#" + m.chemical_id))}</td>
        <td>${qty(m.issued, m.unit)}</td>
        <td>${qty(m.used, m.unit)}</td>
        <td>${m.returned ? qty(m.returned, m.unit) : "—"}</td>
        <td><strong>${qty(m.remaining, m.unit)}</strong></td></tr>`;
    }).join("");
    return `${mine ? "" : `<div style="font-weight:600;margin:10px 0 4px">${esc(e.agent_name)}</div>`}
      <table><thead><tr><th>${t("material")}</th><th>${t("issued")}</th>
        <th>${t("used")}</th><th>${t("handed_back")}</th>
        <th>${t("remaining")}</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  const body = engineers.map(block).join("");
  if (!body.trim()) return "";
  return `<div class="panel"><h3 style="margin:0 0 8px">📊 ${t("materials_on_hand")}</h3>
    <p class="muted" style="margin:0 0 10px">${t("materials_on_hand_hint")}</p>${body}</div>`;
}

// Status of one materials row. An engineer's submission is a REQUEST until the
// office approves it — approval is what actually issues the materials.
const ISSUE_STATUS_BADGE = { requested: "b-draft", approved: "b-completed", declined: "b-declined" };
function issueStatusBadge(s) {
  return `<span class="badge ${ISSUE_STATUS_BADGE[s] || "b-draft"}">${t("iss_" + (s || "approved"))}</span>`;
}

// The second signature. Releasing the stock is the office saying "we handed it
// over"; this is the engineer saying "I have it". Only an approved issue has a
// receipt to show — a request nobody released yet is not a handover.
function issueReceiptBadge(i) {
  if (i.status !== "approved") return "—";
  if (i.receipt_status === "received") return `<span class="badge b-completed">${t("iss_received")}</span>`;
  if (i.receipt_status === "disputed") return `<span class="badge b-declined">${t("iss_disputed")}</span>`;
  return `<span class="badge b-draft">${t("iss_awaiting_receipt")}</span>`;
}
// Whose signature is missing: only the engineer the materials went to can give it.
function issueNeedsMyReceipt(i) {
  return i.status === "approved" && !i.receipt_status
    && API.user && i.agent_id === API.user.id;
}

// ====================================================================
// POCKET MONEY — the cash an engineer carries for a taxi, a part, a repair.
// ====================================================================
// The office hands out a float and settles what comes back; the engineer files
// what they spent. Only approved rows move a balance, so the page always shows
// two numbers: what the engineer holds, and what is still waiting on a
// decision. Same shape as the materials page — inbox on top, history below.
const CASH_CATEGORIES = ["transport", "purchase", "repair", "other"];
// A claim with a receipt attached says so; a taxi fare simply has none.
const cashReceiptLink = (r) => r.receipts
  ? ` <button class="link-btn sm" data-receipt="${r.id}">📎 ${t("cash_receipt")}</button>` : "";
// The one way the profit picture can count the same money twice: a taxi
// claimed here that was also logged as a trip on the same visit.
const cashDupWarning = (r) => r.dup_transport
  ? ` <span class="warn-line" title="${esc(t("cash_dup_transport_hint"))}">⚠️ ${t("cash_dup_transport")}</span>` : "";
const cashSign = { advance: "+", expense: "−", return: "−" };
const _cfTrips = new Set();     // visits already known to carry a travel trip

async function viewCash(v) {
  const office = can("cash.approve");
  const [rows, sum] = await Promise.all([API.get("/cash"), API.get("/cash/summary")]);
  const T = sum.totals || {};
  const pending = rows.filter(r => r.status === "pending");
  const card = (val, label, icon, cls) =>
    `<div class="stat-card ${cls}"><div class="sc-ic">${icon}</div><div>
      <div class="v">${val}</div><div class="l">${esc(label)}</div></div></div>`;
  const cards = `<div class="cards">
      ${card(money(T.balance), t(office ? "cash_out_now" : "cash_my_balance"), "👛", (T.balance || 0) > 0 ? "c-blue" : "c-green")}
      ${card(money(T.advanced), t("cash_advanced"), "🏦", "c-teal")}
      ${card(money(T.spent), t("cash_spent"), "🧾", "c-purple")}
      ${card(money(T.pending), t("cash_pending"), "⏳", (T.pending || 0) > 0 ? "warn" : "c-green")}
      ${office ? card(T.stale_count || 0, t("cash_stale_floats"), "📅",
                      (T.stale_count || 0) > 0 ? "warn" : "c-green") : ""}</div>`;
  // The office's queue: claims nobody has answered yet.
  const inbox = (office && pending.length) ? `<div class="panel iss-inbox">
      <div class="section-title"><h3>📥 ${t("cash_claims")} (${pending.length})</h3></div>
      <table><thead><tr><th>${t("date")}</th><th>${t("engineer")}</th><th>${t("cash_kind")}</th>
        <th>${t("category")}</th><th class="num">${t("amount")}</th><th>${t("notes")}</th><th></th></tr></thead>
      <tbody>${pending.map(r => `<tr>
        <td>${fmtDate(r.spent_on)}</td><td>${esc(r.agent_name)}</td>
        <td>${esc(t("cash_" + r.kind))}</td><td>${r.category ? esc(t("cat_" + r.category)) : "—"}</td>
        <td class="num"><strong>${money(r.amount)}</strong></td>
        <td>${esc(r.note || "—")}${cashReceiptLink(r)}${cashDupWarning(r)}</td>
        <td><div class="row-actions">
          <button class="btn sm" data-okcash="${r.id}">${t("approve")}</button>
          <button class="link-btn danger sm" data-nocash="${r.id}">${t("decline")}</button>
        </div></td></tr>`).join("")}</tbody></table></div>` : "";
  // Who is holding how much — the number the office actually chases.
  const balances = (office && (sum.balances || []).length) ? `<div class="panel">
      <div class="section-title"><h3>👛 ${t("cash_balances")}</h3></div>
      <p class="muted small" style="margin:-4px 0 8px">${t("cash_ageing_hint").replace("{n}", sum.stale_days || 30)}</p>
      <table><thead><tr><th>${t("engineer")}</th><th class="num">${t("cash_advanced")}</th>
        <th class="num">${t("cash_spent")}</th><th class="num">${t("cash_returned")}</th>
        <th class="num">${t("cash_pending")}</th><th class="num">${t("cash_balance")}</th>
        <th class="num">${t("cash_days_out")}</th><th class="num">${t("cash_no_receipt")}</th></tr></thead>
      <tbody>${sum.balances.map(b => `<tr>
        <td>${esc(b.agent_name)}</td><td class="num">${money(b.advanced)}</td>
        <td class="num">${money(b.spent)}</td><td class="num">${money(b.returned)}</td>
        <td class="num">${b.pending ? `<span class="warn-line">${money(b.pending)}</span>` : "—"}</td>
        <td class="num"><strong>${money(b.balance)}</strong></td>
        <td class="num">${b.days_out == null ? "—"
          : (b.stale ? `<span class="warn-line">${b.days_out}</span>` : b.days_out)}</td>
        <td class="num">${b.no_receipt ? `<span class="muted">${b.no_receipt}</span>` : "—"}</td>
        </tr>`).join("")}</tbody></table></div>` : "";
  const canDelete = can("cash.delete");
  // A row shows a delete button when the office can remove anything, or when
  // it is the engineer's own claim nobody has answered yet — the header has to
  // agree with that, or the last column runs off the end of the table.
  const hasRowActions = canDelete || rows.some(r => r.status === "pending"
    && String(r.agent_id) === String(API.user && API.user.id));
  const historyRows = rows.map(r => {
    const st = r.status === "approved" ? "completed" : r.status === "declined" ? "cancelled" : "draft";
    const mineWaiting = r.status === "pending"
      && String(r.agent_id) === String(API.user && API.user.id);
    return `<tr>
      <td>${fmtDate(r.spent_on)}</td>${office ? `<td>${esc(r.agent_name)}</td>` : ""}
      <td>${esc(t("cash_" + r.kind))}</td>
      <td>${r.category ? esc(t("cat_" + r.category)) : "—"}</td>
      <td class="num">${cashSign[r.kind] || ""}${money(r.amount)}</td>
      <td><span class="badge b-${st}">${esc(t("cst_" + r.status))}</span>
        ${r.decline_reason ? `<div class="muted small">${esc(r.decline_reason)}</div>` : ""}</td>
      <td>${esc(r.note || "—")}${cashReceiptLink(r)}${cashDupWarning(r)}</td>
      ${hasRowActions ? `<td>${(canDelete || mineWaiting)
        ? `<button class="link-btn danger sm" data-delcash="${r.id}">${t("delete")}</button>` : ""}</td>` : ""}
    </tr>`;
  }).join("");
  const cols = 6 + (office ? 1 : 0) + (hasRowActions ? 1 : 0);
  v.innerHTML = `<div class="page-head"><h2>${t("nav_cash")}</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${office ? `<button class="btn" id="cash-give">＋ ${t("cash_give")}</button>` : ""}
      ${can("cash.create") ? `<button class="btn${office ? " secondary" : ""}" id="cash-spend">🧾 ${t("cash_log_expense")}</button>` : ""}
      ${can("cash.create") ? `<button class="btn secondary" id="cash-back">↩️ ${t("cash_return")}</button>` : ""}
    </div></div>
    <p class="muted small" style="margin:-6px 0 10px">${t(office ? "cash_hint_office" : "cash_hint_agent")}</p>
    ${cards}
    ${inbox}
    ${balances}
    <h3 style="margin:18px 0 8px">${t("cash_history")}</h3>
    <div class="panel"><table><thead><tr><th>${t("date")}</th>${office ? `<th>${t("engineer")}</th>` : ""}
      <th>${t("cash_kind")}</th><th>${t("category")}</th><th class="num">${t("amount")}</th>
      <th>${t("status")}</th><th>${t("notes")}</th>${hasRowActions ? "<th></th>" : ""}</tr></thead>
      <tbody>${historyRows || `<tr><td colspan="${cols}" class="empty">${t("none")}</td></tr>`}</tbody>
      </table></div>`;
  const reload = () => navigate("cash");
  if ($("cash-give")) $("cash-give").addEventListener("click", () => cashForm("advance", reload));
  if ($("cash-spend")) $("cash-spend").addEventListener("click", () => cashForm("expense", reload));
  if ($("cash-back")) $("cash-back").addEventListener("click", () => cashForm("return", reload));
  v.querySelectorAll("[data-okcash]").forEach(b => b.addEventListener("click", async () => {
    const row = rows.find(r => String(r.id) === b.dataset.okcash);
    const asked = prompt(t("cash_approve_prompt"), String(row ? row.amount : ""));
    if (asked === null) return;
    try { await API.post(`/cash/${b.dataset.okcash}/approve`, { amount: Number(asked) || undefined });
      toast(t("saved")); reload(); } catch (e) { alert(e.message); }
  }));
  v.querySelectorAll("[data-nocash]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt(t("decline_reason"));
    if (reason === null) return;
    try { await API.post(`/cash/${b.dataset.nocash}/decline`, { reason });
      toast(t("saved")); reload(); } catch (e) { alert(e.message); }
  }));
  v.querySelectorAll("[data-receipt]").forEach(b => b.addEventListener("click", async () => {
    let files = [];
    try { files = await API.get(`/photos?entity_type=cash&entity_id=${b.dataset.receipt}`); }
    catch (e) { alert(e.message); return; }
    if (!files.length) { toast(t("none")); return; }
    const f = files[0];
    openFileViewer("/uploads/" + f.filename, f.original_name || f.filename);
  }));
  v.querySelectorAll("[data-delcash]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("confirm_delete"))) return;
    try { await API.del(`/cash/${b.dataset.delcash}`); toast(t("deleted")); reload(); }
    catch (e) { alert(e.message); }
  }));
}

// One movement: the office handing cash out, or an engineer accounting for it.
async function cashForm(kind, done) {
  const office = can("cash.approve");
  const agents = (cache.agents || []).map(a => ({ v: a.id, l: a.full_name }));
  const cats = CASH_CATEGORIES.map(k => ({ v: k, l: t("cat_" + k) }));
  // Which job the money was spent on. Blank is a real answer — not every taxi
  // belongs to one visit — but naming it is what files the cost under a client.
  let visitOpts = [];
  if (kind === "expense") {
    try {
      const vs = await API.get("/visits");
      visitOpts = [{ v: "", l: "—" }].concat(vs.slice(0, 60).map(x => ({
        v: x.id, l: `#${String(x.id).padStart(5, "0")} · ${fmtDate(x.scheduled_start)} · ${
          localized(x, "client") || x.client_en || ""}` })));
    } catch (e) { visitOpts = []; }
  }
  const title = { advance: t("cash_give"), expense: t("cash_log_expense"), return: t("cash_return") }[kind];
  openModal(title, `<form id="cf"><div class="form-grid">
      ${office && agents.length ? field(t("engineer"), "agent_id", { options: agents }) : ""}
      ${field(t("amount"), "amount", { type: "number", attrs: 'step="0.01" min="0" inputmode="decimal"' })}
      ${kind === "expense" ? field(t("category"), "category", { options: cats }) : ""}
      ${field(t("date"), "spent_on", { type: "date", value: ymd(new Date()) })}
      ${visitOpts.length ? field(t("visit"), "visit_id", { options: visitOpts }) : ""}</div>
    ${field(t("notes"), "note", { textarea: true })}
    <div id="cf-dup" class="hidden warn-line" style="margin:-4px 0 8px">⚠️ ${t("cash_dup_transport_hint")}</div>
    ${kind === "expense" ? `<div class="field"><label>${t("cash_receipt")}</label>
      <input type="file" id="cf-receipt" accept="image/*,.pdf" capture="environment">
      <div class="muted small">${t("cash_receipt_hint")}</div></div>` : ""}
    <p class="muted small">${t(kind === "advance" ? "cash_give_hint"
      : office ? "cash_office_files_hint" : "cash_claim_hint")}</p>
    <div class="form-actions"><button type="button" class="btn secondary" id="cf-x">${t("cancel")}</button>
    <button class="btn" type="submit" id="cf-save">${t("save")}</button></div></form>`, (root) => {
    $("cf-x").addEventListener("click", closeModal);
    // A visit that already carries a trip does not need the same taxi twice.
    const visitSel = root.querySelector("[name=visit_id]");
    const catSel = root.querySelector("[name=category]");
    const dupNote = () => {
      const el = $("cf-dup");
      if (!el) return;
      const v = visitSel && visitSel.value;
      const isTransport = catSel && catSel.value === "transport";
      el.classList.toggle("hidden", !(v && isTransport && _cfTrips.has(String(v))));
    };
    if (visitSel) {
      visitSel.addEventListener("change", async () => {
        const v = visitSel.value;
        if (v && !_cfTrips.has(String(v))) {
          try {
            const vis = await API.get(`/visits/${v}`);
            if (vis && (vis.transport || []).length) _cfTrips.add(String(v));
          } catch (e) { /* a hint, never a blocker */ }
        }
        dupNote();
      });
    }
    if (catSel) catSel.addEventListener("change", dupNote);
    const save = async (e) => {
      if (e) e.preventDefault();
      const d = formData(root);
      if (!(Number(d.amount) > 0)) { alert(t("amount")); return; }
      const fileEl = $("cf-receipt");
      const file = fileEl && fileEl.files && fileEl.files[0];
      try {
        const saved = await API.post("/cash", Object.assign({ kind }, d));
        if (handledOffline(saved)) return;
        // The claim exists before the receipt can point at it. A photo that
        // fails to upload must not lose the claim itself, so it only warns.
        if (file && saved && saved.id) {
          try { await API.uploadPhoto("cash", saved.id, file); }
          catch (e) { alert(t("cash_receipt_failed") + " " + e.message); }
        }
        closeModal(); toast(t("saved")); done();
      } catch (err) { alert(err.message); }
    };
    root.querySelector("#cf").addEventListener("submit", save);
    $("cf-save").addEventListener("click", save);
  });
}

async function viewIssues(v) {
  const mine = isField();
  const [issues, balance, returns] = await Promise.all([
    API.get("/issues"), API.get("/issues/balance"), API.get("/returns").catch(() => [])]);
  const canDelete = can("issues.delete");
  const canApprove = can("issues.approve");
  const pending = issues.filter(i => i.status === "requested");
  // The office needs the waiting requests in front of it, not buried in history.
  const inbox = (canApprove && pending.length) ? `<div class="panel iss-inbox">
      <div class="section-title"><h3>📥 ${t("iss_pending_title")} (${pending.length})</h3></div>
      <table><thead><tr><th>${t("date")}</th><th>${t("engineer")}</th>
        <th>${t("materials")}</th><th>${t("notes")}</th><th></th></tr></thead>
      <tbody>${pending.map(i => `<tr class="clickable" data-issue="${i.id}">
        <td>${fmtDateTime(i.created_at)}</td><td>${esc(i.agent_name)}</td>
        <td>${i.item_count} ${t("items_n")}</td><td>${esc(i.note || "—")}</td>
        <td><div class="row-actions">
          <button class="btn sm" data-okissue="${i.id}">${t("approve")}</button>
          <button class="link-btn danger sm" data-noissue="${i.id}">${t("decline")}</button>
        </div></td></tr>`).join("")}</tbody></table></div>` : "";
  // The engineer's own half: materials the office has released but that nobody
  // has said arrived. It sits at the top of their page for the same reason the
  // request inbox sits at the top of the office's.
  const toConfirm = issues.filter(issueNeedsMyReceipt);
  const confirmBox = toConfirm.length ? `<div class="panel iss-confirm">
      <div class="section-title"><h3>${t("iss_to_confirm_title")} (${toConfirm.length})</h3></div>
      <p class="muted small" style="margin:0 0 10px">${t("iss_confirm_hint")}</p>
      <table><thead><tr><th>${t("date")}</th><th>${t("materials")}</th>
        <th>${t("notes")}</th><th></th></tr></thead>
      <tbody>${toConfirm.map(i => `<tr class="clickable" data-issue="${i.id}">
        <td>${fmtDateTime(i.handled_at || i.created_at)}</td>
        <td>${i.item_count} ${t("items_n")}</td><td>${esc(i.note || "—")}</td>
        <td><div class="row-actions">
          <button class="btn sm" data-gotissue="${i.id}">${t("iss_confirm_receipt")}</button>
          <button class="link-btn danger sm" data-noget="${i.id}">${t("iss_not_received")}</button>
        </div></td></tr>`).join("")}</tbody></table></div>` : "";
  // --- what is coming BACK: the same handover, in reverse ------------------
  const canStock = can("chemicals.edit");
  const retPending = returns.filter(r => r.status === "requested");
  const retToTake = returns.filter(r => r.status === "approved" && !r.receipt_status);
  const retInbox = (canApprove && retPending.length) ? `<div class="panel iss-inbox">
      <div class="section-title"><h3>↩️ ${t("ret_pending_title")} (${retPending.length})</h3></div>
      <table><thead><tr><th>${t("date")}</th><th>${t("engineer")}</th><th>${t("materials")}</th>
        <th>${t("notes")}</th><th></th></tr></thead>
      <tbody>${retPending.map(r => `<tr>
        <td>${fmtDateTime(r.created_at)}</td><td>${esc(r.agent_name)}</td>
        <td>${r.item_count} ${t("items_n")}</td><td>${esc(r.note || "—")}</td>
        <td><div class="row-actions">
          <button class="btn sm" data-okret="${r.id}">${t("approve")}</button>
          <button class="link-btn danger sm" data-noret="${r.id}">${t("decline")}</button>
        </div></td></tr>`).join("")}</tbody></table></div>` : "";
  // The warehouse's half: approved returns waiting to be counted onto the shelf.
  const retTake = (canStock && retToTake.length) ? `<div class="panel iss-confirm">
      <div class="section-title"><h3>📦 ${t("ret_to_take_title")} (${retToTake.length})</h3></div>
      <p class="muted small" style="margin:0 0 10px">${t("ret_take_hint")}</p>
      <table><thead><tr><th>${t("date")}</th><th>${t("engineer")}</th><th>${t("materials")}</th>
        <th>${t("notes")}</th><th></th></tr></thead>
      <tbody>${retToTake.map(r => `<tr>
        <td>${fmtDateTime(r.handled_at || r.created_at)}</td><td>${esc(r.agent_name)}</td>
        <td>${r.item_count} ${t("items_n")}</td><td>${esc(r.note || "—")}</td>
        <td><div class="row-actions">
          <button class="btn sm" data-takeret="${r.id}">${t("ret_take_in")}</button>
          <button class="link-btn danger sm" data-disret="${r.id}">${t("ret_dispute")}</button>
        </div></td></tr>`).join("")}</tbody></table></div>` : "";
  const retRows = returns.map(r => `<tr>
      <td>${fmtDateTime(r.created_at)}</td>${mine ? "" : `<td>${esc(r.agent_name)}</td>`}
      <td>${r.item_count} ${t("items_n")}</td>
      <td>${issueStatusBadge(r.status === "requested" ? "requested" : r.status)}</td>
      <td>${r.receipt_status === "received"
            ? `<span class="badge b-completed">${t("ret_in_stock")}</span>`
            : r.receipt_status === "disputed"
              ? `<span class="badge b-cancelled">${t("ret_disputed")}</span>`
              : (r.status === "approved" ? `<span class="badge b-draft">${t("ret_awaiting_stock")}</span>` : "—")}</td>
      <td>${esc(r.note || r.decline_reason || "—")}</td>
      ${canDelete ? `<td><button class="link-btn danger sm" data-rmret="${r.id}">${t("delete")}</button></td>` : ""}
    </tr>`).join("");
  const cols = 5 + (mine ? 0 : 1) + (canDelete ? 1 : 0);
  v.innerHTML = `<div class="page-head"><h2>${t("nav_issues")}</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
    ${can("issues.create") ? `<button class="btn" id="add-issue">+ ${canApprove ? t("new_issue") : t("request_materials")}</button>` : ""}
    ${can("issues.create") ? `<button class="btn secondary" id="ret-materials">↩️ ${t("ret_hand_back")}</button>` : ""}
    </div></div>
    ${mine ? `<p class="muted small" style="margin:-6px 0 10px">${t("iss_request_hint")}</p>` : ""}
    ${confirmBox}
    ${retTake}
    ${inbox}
    ${retInbox}
    ${renderIssueBalance(balance, mine)}
    <h3 style="margin:18px 0 8px">${t("issue_history")}</h3>
    <div class="panel"><table><thead><tr>
      <th>${t("date")}</th>${mine ? "" : `<th>${t("engineer")}</th>`}<th>${t("materials")}</th>
      <th>${t("status")}</th><th>${t("iss_receipt")}</th><th>${t("notes")}</th>${canDelete ? "<th></th>" : ""}</tr></thead>
      <tbody>${issues.map(i => `<tr class="clickable" data-issue="${i.id}">
        <td>${fmtDateTime(i.created_at)}</td>${mine ? "" : `<td>${esc(i.agent_name)}</td>`}
        <td>${i.item_count} ${t("items_n")}</td>
        <td>${issueStatusBadge(i.status)}</td><td>${issueReceiptBadge(i)}</td><td>${esc(i.note || "—")}</td>
        ${canDelete ? `<td><button class="link-btn danger sm" data-rmissue="${i.id}">${t("delete")}</button></td>` : ""}</tr>`).join("")
      || `<tr><td colspan="${cols}" class="empty">${t("none")}</td></tr>`}</tbody></table></div>
    ${returns.length ? `<h3 style="margin:18px 0 8px">${t("ret_history")}</h3>
    <div class="panel"><table><thead><tr>
      <th>${t("date")}</th>${mine ? "" : `<th>${t("engineer")}</th>`}<th>${t("materials")}</th>
      <th>${t("status")}</th><th>${t("ret_stock")}</th><th>${t("notes")}</th>
      ${canDelete ? "<th></th>" : ""}</tr></thead><tbody>${retRows}</tbody></table></div>` : ""}`;
  if ($("add-issue")) $("add-issue").addEventListener("click", () => issueForm());
  if ($("ret-materials")) $("ret-materials").addEventListener("click", () =>
    returnForm(balance, mine, () => navigate("issues")));
  v.querySelectorAll("[data-okret]").forEach(b => b.addEventListener("click", () =>
    approveReturnDialog(b.dataset.okret)));
  v.querySelectorAll("[data-noret]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt(t("decline_reason"));
    if (reason === null) return;
    try { await API.post(`/returns/${b.dataset.noret}/decline`, { reason });
      toast(t("saved")); navigate("issues"); } catch (e) { alert(e.message); }
  }));
  v.querySelectorAll("[data-takeret]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("ret_take_confirm"))) return;
    try { await API.post(`/returns/${b.dataset.takeret}/receive`, {});
      if (cache.chemicals) cache.chemicals = await API.get("/chemicals");
      toast(t("saved")); navigate("issues"); } catch (e) { alert(e.message); }
  }));
  v.querySelectorAll("[data-disret]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt(t("ret_dispute_prompt"));
    if (reason === null) return;
    try { await API.post(`/returns/${b.dataset.disret}/dispute`, { reason });
      toast(t("saved")); navigate("issues"); } catch (e) { alert(e.message); }
  }));
  v.querySelectorAll("[data-rmret]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("confirm_delete"))) return;
    try { await API.del("/returns/" + b.dataset.rmret); toast(t("deleted")); navigate("issues"); }
    catch (e) { alert(e.message); }
  }));
  v.querySelectorAll("[data-okissue]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    await approveIssueDialog(b.dataset.okissue);
  }));
  v.querySelectorAll("[data-noissue]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    await declineIssue(b.dataset.noissue);
  }));
  v.querySelectorAll("[data-gotissue]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    await confirmIssueReceipt(b.dataset.gotissue);
  }));
  v.querySelectorAll("[data-noget]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    await disputeIssueReceipt(b.dataset.noget);
  }));
  v.querySelectorAll("[data-issue]").forEach(tr => tr.addEventListener("click", (e) => {
    if (e.target.dataset.rmissue !== undefined) return;
    issueDetail(tr.dataset.issue);
  }));
  v.querySelectorAll("[data-rmissue]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (confirm(t("confirm_delete"))) {
      const r = await API.del("/issues/" + b.dataset.rmissue);
      if (handledOffline(r, b.closest("tr"))) return;
      navigate("issues");
    }
  }));
}

// Handing material back: the engineer says what is left, off the same balance
// the CRM already keeps, so nobody can offer back what they never held.
function returnForm(balance, mine, done) {
  const engineers = (balance && balance.engineers) || [];
  const list = engineers.filter(e => e.materials.some(m => m.remaining > 0));
  if (!list.length) { alert(t("ret_nothing_held")); return; }
  const engOpts = list.map(e => ({ v: e.agent_id, l: e.agent_name }));
  const rowsFor = (e) => e.materials.filter(m => m.remaining > 0).map(m => `<tr>
      <td>${esc(localized(m, "name") || ("#" + m.chemical_id))}</td>
      <td class="num">${(+m.remaining).toLocaleString()} ${esc(m.unit || "")}</td>
      <td><input type="number" class="ret-q" data-chem="${m.chemical_id}"
        min="0" max="${m.remaining}" step="0.01" inputmode="decimal" placeholder="0"></td></tr>`).join("");
  const table = (e) => `<table class="ret-table" data-eng="${e.agent_id}"${
      list.length > 1 && e !== list[0] ? ' style="display:none"' : ""}>
      <thead><tr><th>${t("material")}</th><th class="num">${t("remaining")}</th>
        <th>${t("ret_giving_back")}</th></tr></thead><tbody>${rowsFor(e)}</tbody></table>`;
  openModal(`↩️ ${t("ret_hand_back")}`, `<form id="rtf">
      ${!mine ? field(t("engineer"), "agent_id", { options: engOpts }) : ""}
      ${list.map(table).join("")}
      ${field(t("notes"), "note", { textarea: true })}
      <p class="muted small">${t("ret_hand_back_hint")}</p>
      <div class="form-actions"><button type="button" class="btn secondary" id="rtf-x">${t("cancel")}</button>
      <button class="btn" type="submit" id="rtf-save">${t("save")}</button></div></form>`, (root) => {
    $("rtf-x").addEventListener("click", closeModal);
    const sel = root.querySelector("[name=agent_id]");
    if (sel) sel.addEventListener("change", () => root.querySelectorAll(".ret-table").forEach(tb => {
      tb.style.display = tb.dataset.eng === sel.value ? "" : "none";
    }));
    const save = async (e) => {
      if (e) e.preventDefault();
      const shown = root.querySelector(".ret-table" + (sel ? `[data-eng="${sel.value}"]` : ""));
      const items = [...shown.querySelectorAll(".ret-q")]
        .filter(i => Number(i.value) > 0)
        .map(i => ({ chemical_id: Number(i.dataset.chem), quantity: Number(i.value) }));
      if (!items.length) { alert(t("ret_nothing_picked")); return; }
      const body = { items, note: root.querySelector("[name=note]").value.trim() };
      if (sel) body.agent_id = sel.value;
      try {
        const saved = await API.post("/returns", body);
        if (handledOffline(saved)) return;
        closeModal(); toast(t("saved")); done();
      } catch (err) { alert(err.message); }
    };
    root.querySelector("#rtf").addEventListener("submit", save);
    $("rtf-save").addEventListener("click", save);
  });
}

// The office agreeing a return, line by line — it may take back less than was
// offered, exactly as it may issue less than was asked for.
async function approveReturnDialog(id) {
  let r;
  try { r = await API.get("/returns/" + id); } catch (e) { alert(e.message); return; }
  openModal(`↩️ ${t("ret_approve_title")}`, `<form id="raf">
      <table><thead><tr><th>${t("material")}</th><th class="num">${t("ret_offered")}</th>
        <th>${t("ret_taking")}</th></tr></thead>
      <tbody>${r.items.map(it => `<tr>
        <td>${esc(localized(it, "name"))}</td>
        <td class="num">${(+it.quantity).toLocaleString()} ${esc(it.unit || "")}</td>
        <td><input type="number" class="raf-q" data-id="${it.id}" value="${it.quantity}"
          min="0" max="${it.quantity}" step="0.01" inputmode="decimal"></td></tr>`).join("")}</tbody></table>
      <p class="muted small">${t("ret_approve_hint")}</p>
      <div class="form-actions"><button type="button" class="btn secondary" id="raf-x">${t("cancel")}</button>
      <button class="btn" type="submit" id="raf-save">${t("approve")}</button></div></form>`, (root) => {
    $("raf-x").addEventListener("click", closeModal);
    const save = async (e) => {
      if (e) e.preventDefault();
      const items = [...root.querySelectorAll(".raf-q")].map(i => ({
        id: Number(i.dataset.id),
        approved_quantity: Number(i.value) || 0,
        line_status: Number(i.value) > 0 ? "approved" : "declined",
      }));
      try {
        await API.post(`/returns/${id}/approve`, { items });
        closeModal(); toast(t("saved")); navigate("issues");
      } catch (err) { alert(err.message); }
    };
    root.querySelector("#raf").addEventListener("submit", save);
    $("raf-save").addEventListener("click", save);
  });
}

// Approving is what issues the materials (and deducts stock), so the stock cache
// is refreshed afterwards and the page redrawn.
async function approveIssue(id, items) {
  try {
    const saved = await API.post(`/issues/${id}/approve`, items ? { items } : {});
    if (handledOffline(saved)) return;
    toast(t("iss_approved_toast"));
    if (cache.chemicals) cache.chemicals = await API.get("/chemicals");
    navigate("issues");
  } catch (err) { alert(err.message); }
}

// A request for several materials is answered line by line: the office keeps
// what it can give, drops what it cannot, and may cut a quantity to what is
// actually on the shelf. Approving everything as asked is still one tap.
async function approveIssueDialog(id) {
  let issue;
  try { issue = await API.get("/issues/" + id); }
  catch (err) { alert(err.message); return; }
  const items = issue.items || [];
  if (items.length < 2) return approveIssue(id);   // one line: nothing to choose between
  const row = (it) => `<tr data-line="${it.id}">
      <td><label class="check"><input type="checkbox" class="ia-ok" checked><span>${esc(localized(it, "name"))}</span></label></td>
      <td class="num muted small">${it.quantity}${esc(it.unit ? " " + it.unit : "")}</td>
      <td><input type="number" class="ia-qty" min="0" step="any" max="${it.quantity}"
        value="${it.quantity}" style="max-width:110px"></td></tr>`;
  openModal(t("iss_approve_title"), `<p class="muted small">${t("iss_approve_hint")}</p>
    <table><thead><tr><th>${t("material")}</th><th class="num">${t("requested")}</th>
      <th>${t("approve_qty")}</th></tr></thead>
      <tbody id="ia-rows">${items.map(row).join("")}</tbody></table>
    <div class="form-actions">
      <button type="button" class="btn secondary" id="ia-x">${t("cancel")}</button>
      <button type="button" class="btn" id="ia-go">${t("approve")}</button></div>`, (root) => {
    // Unticking a line greys its quantity out: it is not being given.
    root.querySelectorAll("tr[data-line]").forEach(tr => {
      const cb = tr.querySelector(".ia-ok"), qty = tr.querySelector(".ia-qty");
      cb.addEventListener("change", () => { qty.disabled = !cb.checked; tr.classList.toggle("muted", !cb.checked); });
    });
    $("ia-x").addEventListener("click", closeModal);
    $("ia-go").addEventListener("click", async () => {
      const lines = [...root.querySelectorAll("tr[data-line]")].map(tr => ({
        id: Number(tr.dataset.line),
        approved: tr.querySelector(".ia-ok").checked,
        quantity: tr.querySelector(".ia-qty").value,
      }));
      if (!lines.some(l => l.approved)) { alert(t("iss_approve_none")); return; }
      closeModal();
      await approveIssue(id, lines);
    });
  });
}
async function declineIssue(id) {
  const reason = prompt(t("iss_decline_reason"));
  if (reason === null) return;
  try {
    const saved = await API.post(`/issues/${id}/decline`, { reason });
    if (handledOffline(saved)) return;
    toast(t("iss_declined_toast"));
    navigate("issues");
  } catch (err) { alert(err.message); }
}

// The engineer signing for what the office released. No stock moves either way:
// confirming records the handover, and reporting it missing raises it with the
// office rather than putting the material back by itself.
async function confirmIssueReceipt(id) {
  if (!confirm(t("iss_confirm_receipt_ask"))) return;
  try {
    const saved = await API.post(`/issues/${id}/receive`, {});
    if (handledOffline(saved)) return;
    toast(t("iss_received_toast"));
    navigate("issues");
  } catch (err) { alert(err.message); }
}
async function disputeIssueReceipt(id) {
  const reason = prompt(t("iss_dispute_reason"));
  if (reason === null) return;
  try {
    const saved = await API.post(`/issues/${id}/dispute`, { reason });
    if (handledOffline(saved)) return;
    toast(t("iss_disputed_toast"));
    navigate("issues");
  } catch (err) { alert(err.message); }
}

function issueForm() {
  const isManager = can("issues.approve");
  const agentOpts = (cache.agents || []).map(a => ({ v: a.id, l: a.full_name }));
  const chemOpts = (cache.chemicals || []).map(c => ({ v: c.id, l: chemLabel(c) }));
  openModal(isManager ? t("new_issue") : t("request_materials"), `<form id="isf">
    ${isManager ? field(t("engineer"), "agent_id", { options: agentOpts })
      : `<p class="muted small">${t("iss_request_hint")}</p>`}
    <div class="full"><label>${t("materials")}</label>
      <table class="li-table"><thead><tr><th>${t("material")}</th><th>${t("qty")}</th><th></th></tr></thead>
      <tbody id="iss-body"></tbody></table>
      <button type="button" class="btn secondary sm" id="iss-add" style="margin-top:8px">+ ${t("add_material")}</button></div>
    ${field(t("notes"), "note", { textarea: true, cls: "full" })}
    <div class="form-actions"><button type="button" class="btn secondary" id="isf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    const chemSelect = () => `<select class="iss-chem">${chemOpts.map(o => `<option value="${esc(o.v)}">${esc(o.l)}</option>`).join("")}</select>`;
    const addRow = () => {
      const tr = document.createElement("tr"); tr.className = "li-row";
      tr.innerHTML = `<td>${chemSelect()}</td>
        <td><input class="iss-qty" type="number" step="any" value="1" style="width:80px"></td>
        <td><button type="button" class="link-btn danger sm li-rm">✕</button></td>`;
      root.querySelector("#iss-body").appendChild(tr);
    };
    addRow();
    root.querySelector("#iss-add").addEventListener("click", addRow);
    root.addEventListener("click", (e) => { if (e.target.classList.contains("li-rm")) e.target.closest("tr").remove(); });
    $("isf-x").addEventListener("click", closeModal);
    root.querySelector("#isf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const items = [...root.querySelectorAll(".li-row")].map(r => ({
        chemical_id: r.querySelector(".iss-chem").value,
        quantity: parseFloat(r.querySelector(".iss-qty").value) || 0,
      })).filter(it => it.chemical_id && it.quantity > 0);
      if (!items.length) { alert(t("need_one_material")); return; }
      const body = { items, note: root.querySelector("[name=note]").value };
      const agentSel = root.querySelector("[name=agent_id]");
      if (agentSel) body.agent_id = agentSel.value;
      try {
        const saved = await API.post("/issues", body);
        if (handledOffline(saved)) return;
        closeModal();
        // An engineer's submission is waiting on the office — say so rather than
        // "saved", which would read as "I have the materials".
        toast(saved && saved.status === "requested" ? t("iss_requested_toast") : t("saved"));
        if (cache.chemicals) cache.chemicals = await API.get("/chemicals");  // reflect deducted stock
        navigate("issues");
      } catch (err) { alert(err.message); }
    });
  });
}

async function issueDetail(id) {
  const iss = await API.get("/issues/" + id);
  // Once answered, a line shows what was actually given rather than what was
  // asked for — a declined material and a cut quantity both have to be visible.
  const rows = (iss.items || []).map(it => {
    const declined = (it.line_status || "approved") !== "approved";
    const given = it.approved_quantity == null ? it.quantity : it.approved_quantity;
    const answered = iss.status !== "requested";
    const qty = !answered ? `${it.quantity} ${esc(it.unit || "")}`
      : declined ? `<span class="muted">${t("declined")}</span>`
      : `${given} ${esc(it.unit || "")}${Number(given) < Number(it.quantity)
          ? ` <span class="muted small">(${t("requested")} ${it.quantity})</span>` : ""}`;
    return `<tr${declined && answered ? ' class="muted"' : ""}>
      <td>${esc(localized(it, "name"))}</td><td>${qty}</td></tr>`;
  }).join("");
  const waiting = iss.status === "requested";
  openModal(waiting ? t("iss_request_detail") : t("issue_detail"), `<div class="kv">
      <div>${t("engineer")}</div><div>${esc(iss.agent_name)}</div>
      <div>${t("date")}</div><div>${fmtDateTime(iss.created_at)}</div>
      <div>${t("status")}</div><div>${issueStatusBadge(iss.status)}</div>
      ${iss.handled_at ? `<div>${t("iss_handled")}</div><div>${esc(iss.handled_by_name || "—")} · ${fmtDateTime(iss.handled_at)}</div>` : ""}
      ${iss.decline_reason ? `<div>${t("decline_reason")}</div><div>${esc(iss.decline_reason)}</div>` : ""}
      ${iss.status === "approved" ? `<div>${t("iss_receipt")}</div>
        <div>${issueReceiptBadge(iss)}${iss.receipt_at ? " · " + fmtDateTime(iss.receipt_at) : ""}
        ${iss.receipt_note ? `<div class="muted small">${esc(iss.receipt_note)}</div>` : ""}</div>` : ""}
      <div>${t("notes")}</div><div>${esc(iss.note || "—")}</div></div>
    <table style="margin-top:12px"><thead><tr><th>${t("material")}</th><th>${t("qty")}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="form-actions"><button type="button" class="btn secondary" id="id-x">${t("close")}</button>
      ${waiting && can("issues.approve") ? `<button type="button" class="link-btn danger" id="id-no">${t("decline")}</button>
        <button type="button" class="btn" id="id-ok">${t("approve")}</button>` : ""}
      ${issueNeedsMyReceipt(iss) ? `<button type="button" class="link-btn danger" id="id-noget">${t("iss_not_received")}</button>
        <button type="button" class="btn" id="id-got">${t("iss_confirm_receipt")}</button>` : ""}
      ${can("issues.delete") ? `<button type="button" class="btn danger" id="id-del">${t("delete")}</button>` : ""}</div>`, (root) => {
    $("id-x").addEventListener("click", closeModal);
    if ($("id-ok")) $("id-ok").addEventListener("click", async () => { closeModal(); await approveIssueDialog(id); });
    if ($("id-no")) $("id-no").addEventListener("click", async () => { closeModal(); await declineIssue(id); });
    if ($("id-got")) $("id-got").addEventListener("click", async () => { closeModal(); await confirmIssueReceipt(id); });
    if ($("id-noget")) $("id-noget").addEventListener("click", async () => { closeModal(); await disputeIssueReceipt(id); });
    if ($("id-del")) $("id-del").addEventListener("click", async () => {
      if (!confirm(t("confirm_delete"))) return;
      const r = await API.del("/issues/" + id);
      if (handledOffline(r)) return;
      closeModal(); toast(t("saved")); navigate("issues");
    });
  });
}

// ====================================================================
// Invoices & finance
// ====================================================================
let invoiceTab = "invoice";
async function viewInvoices(v) {
  const dt = invoiceTab;
  const tab = (k, label) => `<button class="btn sm ${invoiceTab === k ? "" : "secondary"}" data-tab="${k}">${label}</button>`;
  v.innerHTML = `<div class="page-head"><h2>${t("invoices_title")}</h2>
    <div style="display:flex;gap:8px">
      ${can("invoices.view") ? `<button class="btn secondary sm" id="exp-inv">⬇ ${t("export")}</button>` : ""}
      ${can("invoices.edit") ? `<button class="btn secondary sm" id="pb-manage">📖 ${t("price_book")}</button>` : ""}
      ${can("invoices.create") ? `<button class="btn" id="add-inv">+ ${dt === "quote" ? t("quote") : t("new_invoice")}</button>` : ""}</div></div>
    <div class="toolbar">${tab("invoice", t("nav_invoices"))} ${tab("quote", t("nav_quotes"))}</div>
    <div class="panel" id="inv-list">${t("loading")}</div>`;
  v.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => { invoiceTab = b.dataset.tab; navigate("invoices"); }));
  if ($("add-inv")) $("add-inv").addEventListener("click", () => invoiceForm({ doc_type: dt }));
  if ($("exp-inv")) $("exp-inv").addEventListener("click", () =>
    exportDialog("invoices", () => printInvoiceList(dt)));
  if ($("pb-manage")) $("pb-manage").addEventListener("click", () => priceBookManager());
  const render = async (page) => {
    const d = await API.get(`/invoices?doc_type=${dt}&page=${page}&limit=${PAGE_SIZE}`);
    $("inv-list").innerHTML =
      `<table><thead><tr><th>${t("invoice_no")}</th><th>${t("client")}</th>
        <th>${t("issue_date")}</th><th>${t("total")}</th>${dt === "invoice" ? `<th>${t("paid")}</th>` : ""}<th>${t("status")}</th></tr></thead>
      <tbody>${d.items.map(i => `<tr class="clickable" data-inv="${i.id}">
        <td>${esc(i.number)}</td><td>${esc(localized(i, "client"))}</td>
        <td>${fmtDate(i.issue_date)}</td><td>${money(i.total)}</td>${dt === "invoice" ? `<td>${money(i.paid)}</td>` : ""}
        <td>${statusBadge(i.status)}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">${t("none")}</td></tr>`}</tbody></table>` + pagerHTML(d);
    $("inv-list").querySelectorAll("tr[data-inv]").forEach(tr => tr.addEventListener("click", () => navigate("invoice", { id: tr.dataset.inv })));
    wirePager($("inv-list"), d, render);
  };
  render(1);
}

// Line-items editor used by the invoice/quote form.
function lineItemsEditor(items) {
  items = items && items.length ? items : [{ description: "", quantity: 1, unit_price: 0 }];
  const row = (it) => `<tr class="li-row">
    <td><input class="li-desc" value="${esc(it.description || "")}" placeholder="${t("description")}"></td>
    <td><input class="li-qty" type="number" step="any" value="${it.quantity ?? 1}" style="width:70px"></td>
    <td><input class="li-price" type="number" step="any" value="${it.unit_price ?? 0}" style="width:100px"></td>
    <td class="li-amt num">0.00</td><td><button type="button" class="link-btn danger sm li-rm">✕</button></td></tr>`;
  return `<div class="full"><label>${t("line_items")}</label>
    <table class="li-table"><thead><tr><th>${t("description")}</th><th>${t("qty")}</th>
      <th>${t("unit_price")}</th><th>${t("line_total")}</th><th></th></tr></thead>
      <tbody id="li-body">${items.map(row).join("")}</tbody></table>
    <button type="button" class="btn secondary sm" id="li-add" style="margin-top:8px">${t("add_line")}</button>
    <div style="text-align:end;margin-top:8px"><strong>${t("subtotal")}: <span id="li-sub">0.00</span></strong></div></div>`;
}
function wireLineItems(root, taxInputName) {
  const recalc = () => {
    let sub = 0;
    root.querySelectorAll(".li-row").forEach(r => {
      const q = parseFloat(r.querySelector(".li-qty").value) || 0;
      const p = parseFloat(r.querySelector(".li-price").value) || 0;
      const amt = q * p; sub += amt;
      r.querySelector(".li-amt").textContent = amt.toFixed(2);
    });
    root.querySelector("#li-sub").textContent = sub.toFixed(2);
    const taxRate = parseFloat(SETTINGS.tax_rate || 0);
    const taxEl = root.querySelector(`[name=${taxInputName}]`);
    if (taxEl && !taxEl.dataset.touched) taxEl.value = (sub * taxRate / 100).toFixed(2);
  };
  root.addEventListener("input", (e) => {
    if (e.target.name === taxInputName) e.target.dataset.touched = "1";
    recalc();
  });
  root.querySelector("#li-add").addEventListener("click", () => {
    const tb = root.querySelector("#li-body");
    const div = document.createElement("tbody");
    div.innerHTML = `<tr class="li-row"><td><input class="li-desc" placeholder="${t("description")}"></td>
      <td><input class="li-qty" type="number" step="any" value="1" style="width:70px"></td>
      <td><input class="li-price" type="number" step="any" value="0" style="width:100px"></td>
      <td class="li-amt num">0.00</td><td><button type="button" class="link-btn danger sm li-rm">✕</button></td></tr>`;
    tb.appendChild(div.firstElementChild);
    recalc();
  });
  root.addEventListener("click", (e) => { if (e.target.classList.contains("li-rm")) { e.target.closest("tr").remove(); recalc(); } });
  recalc();
}
function collectLineItems(root) {
  return [...root.querySelectorAll(".li-row")].map(r => ({
    description: r.querySelector(".li-desc").value,
    quantity: parseFloat(r.querySelector(".li-qty").value) || 0,
    unit_price: parseFloat(r.querySelector(".li-price").value) || 0,
  })).filter(it => it.description || it.quantity || it.unit_price);
}

// ---- price book (service catalog) management ----
async function priceBookManager() {
  const items = await API.get("/price-book?all=1");
  const row = (p) => `<tr class="${p.active ? "" : "muted"}">
    <td><strong>${esc(localized(p, "name"))}</strong>${p.description ? `<div class="muted small">${esc(p.description)}</div>` : ""}</td>
    <td class="num">${money(p.unit_price)}</td>
    <td>${p.active ? `<span class="badge b-active">${t("active")}</span>` : `<span class="badge b-inactive">${t("status")}</span>`}</td>
    <td><button type="button" class="link-btn sm" data-pbe="${p.id}">✏️</button>
        <button type="button" class="link-btn sm" data-pbt="${p.id}" data-a="${p.active ? 0 : 1}">${p.active ? "⏸" : "▶️"}</button></td></tr>`;
  openModal(t("price_book"), `<div>
    <table><thead><tr><th>${t("description")}</th><th class="num">${t("unit_price")}</th><th>${t("status")}</th><th></th></tr></thead>
    <tbody>${items.map(row).join("") || `<tr><td colspan="4" class="empty">${t("none")}</td></tr>`}</tbody></table>
    <div class="form-actions"><button type="button" class="btn secondary" id="pbm-x">${t("cancel")}</button>
    <button type="button" class="btn" id="pbm-add">+ ${t("new_price_item")}</button></div></div>`, (root) => {
    $("pbm-x").addEventListener("click", closeModal);
    $("pbm-add").addEventListener("click", () => priceItemForm());
    root.querySelectorAll("[data-pbe]").forEach(b => b.addEventListener("click", () =>
      priceItemForm(items.find(p => p.id == b.dataset.pbe))));
    root.querySelectorAll("[data-pbt]").forEach(b => b.addEventListener("click", async () => {
      try { await API.put(`/price-book/${b.dataset.pbt}`, { active: b.dataset.a }); priceBookManager(); }
      catch (err) { alert(err.message); }
    }));
  });
}

function priceItemForm(p) {
  const isEdit = !!p; p = p || {};
  openModal(isEdit ? t("edit") : t("new_price_item"), `<form id="pbf"><div class="form-grid">
    ${field(t("name_en"), "name_en", { value: p.name_en })}
    ${field(t("name_ar"), "name_ar", { value: p.name_ar })}
    ${field(t("description"), "description", { value: p.description, cls: "full" })}
    ${field(t("unit_price"), "unit_price", { type: "number", value: p.unit_price ?? 0 })}
    </div><div class="form-actions"><button type="button" class="btn secondary" id="pbf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("pbf-x").addEventListener("click", closeModal);
    root.querySelector("#pbf").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const d = formData(root);
        const saved = isEdit ? await API.put(`/price-book/${p.id}`, d) : await API.post("/price-book", d);
        if (handledOffline(saved)) return;
        toast(t("saved")); priceBookManager();
      } catch (err) { alert(err.message); }
    });
  });
}

function invoiceForm(preset) {
  preset = preset || {};
  const isEdit = !!preset.id;                 // editing an existing document
  const isQuote = preset.doc_type === "quote";
  const clientOpts = cache.clients.map(c => ({ v: c.id, l: clientLabel(c) }));
  const statuses = (isQuote ? ["draft", "sent", "accepted", "declined", "cancelled"] : ["draft", "sent", "paid", "overdue", "cancelled"])
    .map(s => ({ v: s, l: t(statusKey(s)) }));
  const title = isEdit ? `${t("edit")} — ${esc(preset.number)}` : (isQuote ? t("quote") : t("new_invoice"));
  openModal(title, `<form id="if"><div class="form-grid">
    ${field(t("client"), "client_id", { options: clientOpts, value: preset.client_id, cls: "full" })}
    ${field(t("location_lbl"), "site_id", { options: [{ v: "", l: t("none") }], cls: "full" })}
    ${field(t("issue_date"), "issue_date", { type: "date", value: preset.issue_date })}
    ${isQuote ? field(t("valid_until"), "valid_until", { type: "date", value: preset.valid_until })
              : field(t("due_date"), "due_date", { type: "date", value: preset.due_date })}
    ${field(t("invoice_status"), "status", { options: statuses, value: preset.status })}
    ${field(t("tax"), "tax", { type: "number", value: preset.tax ?? 0 })}
    ${can("contracts.view") ? `<div class="field full"><label>${t("nav_contracts")}</label>
      <select name="contract_id"><option value="">${t("ct_none")}</option></select>
      <div class="muted small">${t("invoice_contract_hint")}</div></div>` : ""}
    <div class="full" id="pb-picker-box" style="display:none"><label>${t("add_from_pricebook")}</label>
      <select id="pb-picker"><option value="">—</option></select></div>
    ${lineItemsEditor(preset.items)}
    ${field(t("notes"), "notes", { textarea: true, cls: "full", value: preset.notes })}
    </div><div class="form-actions"><button type="button" class="btn secondary" id="if-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("if-x").addEventListener("click", closeModal);
    const clientSel = root.querySelector("[name=client_id]");
    const siteSel = root.querySelector("[name=site_id]");
    const ctSel = root.querySelector("[name=contract_id]");
    loadSiteOptions(preset.client_id || (clientSel && clientSel.value), siteSel, preset.site_id, t("none"));
    loadContractOptions(preset.client_id || (clientSel && clientSel.value), ctSel, preset.contract_id);
    if (clientSel) clientSel.addEventListener("change", () => {
      loadSiteOptions(clientSel.value, siteSel, null, t("none"));
      loadContractOptions(clientSel.value, ctSel);
    });
    // In edit mode the client can't be moved and the existing tax shouldn't be auto-overwritten.
    if (isEdit) {
      const cl = root.querySelector("[name=client_id]"); if (cl) cl.disabled = true;
      const tx = root.querySelector("[name=tax]"); if (tx) tx.dataset.touched = "1";
    }
    wireLineItems(root, "tax");
    // Price book: picking an item appends a pre-priced line.
    API.get("/price-book").then(items => {
      if (!items || !items.length) return;
      const sel = root.querySelector("#pb-picker");
      sel.innerHTML = `<option value="">—</option>` + items.map(p =>
        `<option value="${p.id}">${esc(localized(p, "name"))} — ${money(p.unit_price)}</option>`).join("");
      root.querySelector("#pb-picker-box").style.display = "";
      sel.addEventListener("change", () => {
        const p = items.find(x => x.id == sel.value);
        if (!p) return;
        sel.value = "";
        const tb = root.querySelector("#li-body");
        const last = tb.lastElementChild;
        // reuse the trailing empty row if there is one, else add a new row
        let row = (last && !last.querySelector(".li-desc").value) ? last : null;
        if (!row) { root.querySelector("#li-add").click(); row = tb.lastElementChild; }
        row.querySelector(".li-desc").value = localized(p, "name") + (p.description ? ` — ${p.description}` : "");
        row.querySelector(".li-qty").value = 1;
        row.querySelector(".li-price").value = p.unit_price;
        row.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }).catch(() => {});
    root.querySelector("#if").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      d.items = collectLineItems(root);
      try {
        let saved;
        if (isEdit) { saved = await API.put("/invoices/" + preset.id, d); }
        else { d.doc_type = preset.doc_type || "invoice"; saved = await API.post("/invoices", d); }
        if (handledOffline(saved)) return;
        closeModal(); toast(t("saved")); navigate("invoice", { id: saved.id });
      } catch (err) { alert(err.message); }
    });
  });
}

async function viewInvoice(v, arg) {
  const inv = await API.get("/invoices/" + arg.id);
  v.innerHTML = `<div class="breadcrumb" id="bc">← ${t("invoices_title")}</div>
    <div class="page-head"><h2>${esc(inv.number)} — ${esc(localized(inv, "client"))}</h2>
      <div>${statusBadge(inv.status)}
        ${(inv.doc_type === "invoice" && inv.status !== "cancelled" && (inv.total - (inv.paid || 0)) > 0.009 && (role() === "client" || can("payments.create"))) ? `<button class="btn sm" id="pay-online">💳 ${t("pay_now")}</button>` : ""}
        ${can("invoices.edit") ? `<button class="btn secondary sm" id="edit-inv">✏️ ${t("edit")}</button>` : ""}
        ${(inv.doc_type === "quote" && can("invoices.edit") && inv.status !== "accepted") ? `<button class="btn sm" id="convert-inv">➡ ${t("convert_to_invoice")}</button>` : ""}
        ${(inv.doc_type === "quote" && can("contracts.create")
           && ["sent", "accepted"].includes(inv.status)) ? `<button class="btn sm" id="quote-contract">📑 ${t("make_contract")}</button>` : ""}
        ${(inv.doc_type === "quote" && inv.status === "sent" && role() === "client") ? `<button class="btn sm" id="approve-quote">✅ ${t("approve_quote")}</button>
          <button class="btn secondary sm" id="decline-quote">✖ ${t("decline_quote")}</button>` : ""}
        <button class="btn sm" id="print-inv">🖨️ ${t("print_pdf")}</button></div></div>
    <div class="grid-2">
      <div class="panel"><h3>${inv.doc_type === "quote" ? t("quote") : t("invoice_no")}</h3><div class="kv">
        <div>${t("issue_date")}</div><div>${fmtDate(inv.issue_date)}</div>
        <div>${inv.doc_type === "quote" ? t("valid_until") : t("due_date")}</div><div>${fmtDate(inv.doc_type === "quote" ? inv.valid_until : inv.due_date)}</div>
        <div>${t("amount")}</div><div>${money(inv.amount)}</div>
        <div>${t("tax")}</div><div>${money(inv.tax)}</div>
        <div>${t("total")}</div><div><strong>${money(inv.total)}</strong></div>
        ${inv.doc_type === "quote" ? "" : `<div>${t("paid")}</div><div>${money(inv.paid)}</div>
        <div>${t("outstanding")}</div><div><strong>${money(inv.total - inv.paid)}</strong></div>`}
        <div>${t("notes")}</div><div>${esc(inv.notes || "—")}</div>
      </div>
      ${(inv.items && inv.items.length) ? `<table style="margin-top:12px"><thead><tr><th>${t("description")}</th><th>${t("qty")}</th><th class="num">${t("line_total")}</th></tr></thead>
        <tbody>${inv.items.map(it => `<tr><td>${esc(it.description)}</td><td>${it.quantity}</td><td class="num">${money(it.amount)}</td></tr>`).join("")}</tbody></table>` : ""}
      </div>
      ${inv.doc_type === "quote" ? "" : `<div class="panel"><div class="section-title"><h3>${t("add_payment")}</h3></div>
        ${can("payments.create") ? `<form id="pay-form" class="form-grid">
          ${field(t("payment_amount"), "amount", { type: "number" })}
          ${field(t("payment_method"), "method", { options: [
            { v: "cash", l: "Cash / نقدي" }, { v: "bank_transfer", l: "Bank / تحويل" }, { v: "card", l: "Card / بطاقة" }] })}
          <div class="form-actions full"><button class="btn" type="submit">${t("record_payment")}</button></div>
        </form>` : ""}
        <table style="margin-top:10px"><thead><tr><th>${t("issue_date")}</th><th>${t("payment_method")}</th><th>${t("amount")}</th></tr></thead>
        <tbody>${(inv.payments || []).map(p => `<tr><td>${fmtDateTime(p.paid_at)}</td><td>${esc(p.method)}</td><td>${money(p.amount)}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">${t("none")}</td></tr>`}</tbody></table>
      </div>`}</div>`;
  $("bc").addEventListener("click", () => navigate("invoices"));
  $("print-inv").addEventListener("click", () => printInvoice(inv));
  if ($("pay-online")) $("pay-online").addEventListener("click", () => payInvoice(inv));
  if ($("edit-inv")) $("edit-inv").addEventListener("click", () => invoiceForm(inv));
  if ($("quote-contract")) $("quote-contract").addEventListener("click",
    () => quoteToContractDialog(inv));
  if ($("convert-inv")) $("convert-inv").addEventListener("click", async () => {
    try { const ni = await API.post(`/invoices/${inv.id}/convert`); if (handledOffline(ni)) return; toast(t("saved")); invoiceTab = "invoice"; navigate("invoice", { id: ni.id }); }
    catch (err) { alert(err.message); }
  });
  if ($("approve-quote")) $("approve-quote").addEventListener("click", async () => {
    if (!confirm(t("approve_quote_confirm"))) return;
    try { const ni = await API.post(`/invoices/${inv.id}/approve`); if (handledOffline(ni)) return; toast(t("quote_approved")); navigate("invoice", { id: ni.id }); }
    catch (err) { alert(err.message); }
  });
  if ($("decline-quote")) $("decline-quote").addEventListener("click", async () => {
    const reason = prompt(t("decline_reason"));
    if (reason === null) return;
    try { const r = await API.post(`/invoices/${inv.id}/decline`, { reason }); if (handledOffline(r)) return; toast(t("quote_declined")); navigate("invoice", { id: inv.id }); }
    catch (err) { alert(err.message); }
  });
  if ($("pay-form")) $("pay-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { const saved = await API.post(`/invoices/${inv.id}/payments`, formData($("pay-form"))); if (handledOffline(saved)) return; toast(t("saved")); navigate("invoice", { id: inv.id }); }
    catch (err) { alert(err.message); }
  });
}

// Start an online payment for an invoice. Real gateways return a hosted
// checkout_url we redirect to; the built-in "manual" sandbox provider has no
// external page, so we confirm in-app and post the callback ourselves.
async function payInvoice(inv) {
  try {
    const r = await API.post(`/invoices/${inv.id}/pay`, {});
    if (r.provider === "manual") {
      if (!confirm(t("pay_sandbox_confirm").replace("{amt}", money(r.amount) + " " + (r.currency || "")))) return;
      await API.post(`/payments/callback/manual`, { token: r.token });
      toast(t("payment_done"));
      navigate("invoice", { id: inv.id });
    } else if (r.checkout_url) {
      window.location.href = r.checkout_url;   // hosted gateway checkout
    } else {
      alert(t("pay_unavailable"));
    }
  } catch (e) { alert(e.message); }
}

// ---- printable / PDF invoice (opens a clean document and triggers print) ----
// Company details come from Settings (editable in the Settings screen).
function printInvoice(inv) {
  const ar = LANG === "ar";
  const dir = ar ? "rtl" : "ltr";
  const S = SETTINGS || {};
  const compName = (ar ? S.company_name_ar : S.company_name_en) || S.company_name_en || "Company";
  const compAddr = (ar ? S.address_ar : S.address_en) || S.address_en || "";
  const isQuote = inv.doc_type === "quote";
  const docTitle = isQuote ? t("quote") : t("invoice_doc");
  const logoHtml = S.logo ? `<img src="/uploads/${esc(S.logo)}" style="height:48px">` : `<div class="logo">🐜</div>`;
  const clientName = localized(inv, "client");
  const clientAddr = ar ? (inv.client_address_ar || inv.client_address_en) : (inv.client_address_en || inv.client_address_ar);
  const due = (inv.total || 0) - (inv.paid || 0);
  // line items table (falls back to a single line when none)
  const items = (inv.items && inv.items.length) ? inv.items
    : [{ description: inv.notes || (ar ? "خدمات مكافحة الآفات" : "Pest control services"),
         quantity: 1, unit_price: inv.amount, amount: inv.amount }];
  const itemRows = items.map(it => `<tr><td>${esc(it.description)}</td>
    <td class="num">${it.quantity}</td><td class="num">${money(it.unit_price)}</td>
    <td class="num">${money(it.amount)}</td></tr>`).join("");
  const payRows = (inv.payments || []).map(p =>
    `<tr><td>${fmtDate(p.paid_at)}</td><td>${esc(p.method)}</td><td class="num">${money(p.amount)}</td></tr>`).join("");
  const doc = `<!DOCTYPE html><html lang="${LANG}" dir="${dir}"><head><meta charset="utf-8">
    <title>${esc(docTitle)} ${esc(inv.number)}${clientName ? " - " + esc(clientName) : ""}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      @page{size:A4;margin:14mm}
      *{box-sizing:border-box}
      body{font-family:${ar ? "'Cairo'" : "'Inter'"},system-ui,sans-serif;color:#1c2733;margin:0;padding:40px;font-size:13px}
      .inv{max-width:760px;margin:auto}
      .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1f8a4c;padding-bottom:18px}
      .logo{font-size:34px}
      .co h1{margin:0 0 4px;font-size:19px;color:#156c3a}
      .co .muted{color:#6b7a87;line-height:1.6}
      .title{text-align:${ar ? "left" : "right"}}
      .title h2{margin:0;font-size:30px;letter-spacing:2px;color:#1f8a4c}
      .title .no{font-size:14px;font-weight:600;margin-top:4px}
      .parties{display:flex;justify-content:space-between;gap:20px;margin:26px 0}
      .parties h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#6b7a87}
      .parties .box{line-height:1.7}
      .meta{text-align:${ar ? "left" : "right"};line-height:1.8}
      table{width:100%;border-collapse:collapse;margin-top:10px}
      th,td{padding:11px 12px;text-align:${ar ? "right" : "left"};border-bottom:1px solid #e3e8ec}
      th{background:#f0f7f2;color:#156c3a;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
      .num{text-align:${ar ? "left" : "right"};white-space:nowrap}
      .totals{margin-top:18px;display:flex;justify-content:${ar ? "flex-start" : "flex-end"}}
      .totals table{width:300px}
      .totals td{border:none;padding:6px 12px}
      .totals .grand td{border-top:2px solid #1f8a4c;font-size:16px;font-weight:700;color:#156c3a}
      .totals .due td{font-weight:700;color:#d23f3f}
      .status{display:inline-block;padding:4px 14px;border-radius:20px;font-weight:700;font-size:12px;
        border:2px solid #1f8a4c;color:#156c3a;margin-top:8px}
      .status.paid{background:#1f8a4c;color:#fff}
      .status.overdue{border-color:#d23f3f;color:#d23f3f}
      h3.sec{margin:26px 0 4px;font-size:12px;color:#6b7a87;text-transform:uppercase;letter-spacing:.06em}
      .foot{margin-top:34px;padding-top:14px;border-top:1px solid #e3e8ec;color:#6b7a87;text-align:center}
      @media print{body{padding:0}.noprint{display:none}}
      .noprint{text-align:center;margin-bottom:20px}
      .pbtn{background:#1f8a4c;color:#fff;border:none;padding:10px 22px;border-radius:8px;font-size:14px;cursor:pointer}
    </style></head><body>
    <div class="noprint"><button class="pbtn" onclick="window.print()">🖨️ ${esc(t("print_pdf"))}</button></div>
    <div class="inv">
      <div class="top">
        <div style="display:flex;gap:12px">${logoHtml}
          <div class="co"><h1>${esc(compName)}</h1>
            <div class="muted">${esc(compAddr)}<br>${esc(S.phone || "")} · ${esc(S.email || "")}<br>${esc(t("vat_no"))}: ${esc(S.vat_no || "")}</div>
          </div></div>
        <div class="title"><h2>${esc(docTitle)}</h2><div class="no">${esc(inv.number)}</div>
          <div class="status ${inv.status}">${esc(t(statusKey(inv.status)))}</div></div>
      </div>
      <div class="parties">
        <div class="box"><h3>${esc(t("bill_to"))}</h3>
          <strong>${esc(clientName)}</strong><br>
          ${inv.client_contact ? esc(inv.client_contact) + "<br>" : ""}
          ${clientAddr ? esc(clientAddr) + "<br>" : ""}
          ${inv.client_city ? esc(inv.client_city) + "<br>" : ""}
          ${inv.client_phone ? esc(inv.client_phone) : ""}</div>
        <div class="meta">
          <div><strong>${esc(t("issue_date"))}:</strong> ${fmtDate(inv.issue_date)}</div>
          <div><strong>${esc(isQuote ? t("valid_until") : t("due_date"))}:</strong> ${fmtDate(isQuote ? inv.valid_until : inv.due_date)}</div>
        </div>
      </div>
      <table><thead><tr><th>${esc(t("description"))}</th><th class="num">${esc(t("qty"))}</th>
        <th class="num">${esc(t("unit_price"))}</th><th class="num">${esc(t("amount"))}</th></tr></thead>
        <tbody>${itemRows}</tbody></table>
      <div class="totals"><table>
        <tr><td>${esc(t("subtotal"))}</td><td class="num">${money(inv.amount)}</td></tr>
        <tr><td>${esc(t("tax"))}</td><td class="num">${money(inv.tax)}</td></tr>
        <tr class="grand"><td>${esc(t("total"))}</td><td class="num">${money(inv.total)}</td></tr>
        ${isQuote ? "" : `<tr><td>${esc(t("paid"))}</td><td class="num">${money(inv.paid)}</td></tr>
        <tr class="due"><td>${esc(t("balance_due"))}</td><td class="num">${money(due)}</td></tr>`}
      </table></div>
      ${payRows ? `<h3 class="sec">${esc(t("payments_received"))}</h3>
        <table><thead><tr><th>${esc(t("date"))}</th><th>${esc(t("payment_method"))}</th><th class="num">${esc(t("amount"))}</th></tr></thead>
        <tbody>${payRows}</tbody></table>` : ""}
      <div class="foot">${esc(t("thank_you"))}</div>
    </div>
    <script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>
    </body></html>`;
  printHtmlDoc(doc);
}

// ---- printable pest-control service / compliance certificate ----
// Built from the already-loaded visit + report; opens a clean doc and prints.
function printCertificate(visit) {
  const ar = LANG === "ar";
  const dir = ar ? "rtl" : "ltr";
  const S = SETTINGS || {};
  const compName = (ar ? S.company_name_ar : S.company_name_en) || S.company_name_en || "Company";
  const compAddr = (ar ? S.address_ar : S.address_en) || S.address_en || "";
  const logoHtml = S.logo ? `<img src="/uploads/${esc(S.logo)}" style="height:52px">` : `<div class="logo">🐜</div>`;
  const rep = visit.report || {};
  const certNo = "CERT-" + String(visit.id).padStart(5, "0");
  const clk = visitClock(visit);   // when the engineer arrived and left
  const svcDate = visit.completed_at || visit.scheduled_start;
  // Certificate wording is editable in Settings; fall back to the built-in text.
  const statement = (ar ? S.cert_statement_ar : S.cert_statement_en) || t("cert_statement");
  const footer = (ar ? S.cert_footer_ar : S.cert_footer_en) || t("cert_footer");
  const sevColors = { low: "#1f8a4c", medium: "#d97706", high: "#e0541b", critical: "#d23f3f" };
  const sev = rep.severity || "low";
  const sigImg = f => f ? `<img src="/uploads/${esc(f)}" style="max-height:110px;max-width:100%">` : "";
  const chemRows = (visit.chemicals || []).map(cu =>
    `<tr><td>${esc(localized(cu, "name"))}</td><td class="num">${cu.quantity} ${esc(cu.unit || "")}</td>
     <td>${esc(usageMethod(cu))}</td><td>${esc(usageEquip(cu))}</td>
     <td>${esc(cu.area_treated || "—")}</td></tr>`).join("");
  // engineer service-log materials (only the ones with recorded quantities)
  const matKeys = ["lamps_used", "cables_used", "transformers_used", "light_sheets_used",
    "fipronil_ml", "imidacloprid_gm", "baits_count", "glo_pieces", "flybase_bags"];
  const matRows = matKeys.filter(k => Number(rep[k]) > 0)
    .map(k => `<tr><td>${esc(t(k))}</td><td class="num">${esc(rep[k])}</td></tr>`).join("");
  const row = (label, val) => val ? `<tr><td class="lbl">${esc(label)}</td><td>${esc(val)}</td></tr>` : "";
  // The recommendations were ticked off a list, so they read as one.
  const listRow = (label, val) => val ? `<tr><td class="lbl">${esc(label)}</td>
    <td><ol class="wl">${splitOptionValue(val).map(l => `<li>${esc(l)}</li>`).join("")}</ol></td></tr>` : "";
  const doc = `<!DOCTYPE html><html lang="${LANG}" dir="${dir}"><head><meta charset="utf-8">
    <title>${esc(certNo)}${localized(visit, "client") ? " - " + esc(localized(visit, "client")) : ""}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      @page{size:A4;margin:14mm}
      *{box-sizing:border-box}
      body{font-family:${ar ? "'Cairo'" : "'Inter'"},system-ui,sans-serif;color:#1c2733;margin:0;padding:40px;font-size:13px}
      .cert{max-width:780px;margin:auto;border:2px solid #1f8a4c;border-radius:10px;padding:30px 34px;position:relative}
      .cert:before{content:"";position:absolute;inset:6px;border:1px solid #cfe6d8;border-radius:7px;pointer-events:none}
      .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1f8a4c;padding-bottom:16px}
      .logo{font-size:36px}
      .co h1{margin:0 0 4px;font-size:18px;color:#156c3a}
      .co .muted{color:#6b7a87;line-height:1.6;font-size:12px}
      .title{text-align:${ar ? "left" : "right"}}
      .title h2{margin:0;font-size:21px;color:#1f8a4c;line-height:1.25}
      .title .no{font-size:13px;font-weight:600;margin-top:6px;color:#6b7a87}
      .statement{margin:20px 0;padding:14px 16px;background:#f0f7f2;border-radius:8px;line-height:1.7;color:#2b3a45}
      h3.sec{margin:20px 0 6px;font-size:11px;color:#156c3a;text-transform:uppercase;letter-spacing:.07em}
      table{width:100%;border-collapse:collapse}
      .kvt td{padding:6px 4px;vertical-align:top;line-height:1.6}
      .kvt td.lbl{color:#6b7a87;width:34%;white-space:nowrap}
      ol.wl{margin:0;padding-inline-start:20px}
      ol.wl li{line-height:1.6;padding-inline-start:2px}
      .data th,.data td{padding:9px 10px;text-align:${ar ? "right" : "left"};border-bottom:1px solid #e3e8ec}
      .data th{background:#f0f7f2;color:#156c3a;font-size:11px;text-transform:uppercase}
      .num{text-align:${ar ? "left" : "right"};white-space:nowrap}
      .sev{display:inline-block;padding:3px 12px;border-radius:20px;font-weight:700;font-size:12px;color:#fff;background:${sevColors[sev]}}
      .sigs{display:flex;justify-content:space-between;gap:24px;margin-top:30px}
      .sig{flex:1;text-align:center}
      .sig .ln{border-top:1px solid #1c2733;margin-top:6px;padding-top:6px;color:#6b7a87;font-size:12px}
      .foot{margin-top:24px;padding-top:12px;border-top:1px solid #e3e8ec;color:#6b7a87;text-align:center;font-size:11px;line-height:1.6}
      @media print{body{padding:0}.noprint{display:none}*{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}}
      .noprint{text-align:center;margin-bottom:20px}
      .pbtn{background:#1f8a4c;color:#fff;border:none;padding:10px 22px;border-radius:8px;font-size:14px;cursor:pointer}
    </style></head><body>
    <div class="noprint"><button class="pbtn" onclick="window.print()">🖨️ ${esc(t("print_pdf"))}</button></div>
    <div class="cert">
      <div class="top">
        <div style="display:flex;gap:12px">${logoHtml}
          <div class="co"><h1>${esc(compName)}</h1>
            <div class="muted">${esc(compAddr)}<br>${esc(S.phone || "")} · ${esc(S.email || "")}<br>${esc(t("vat_no"))}: ${esc(S.vat_no || "")}</div>
          </div></div>
        <div class="title"><h2>${esc(t("service_certificate"))}</h2>
          <div class="no">${esc(t("cert_no"))}: ${esc(certNo)}</div>
          <div class="no">${esc(t("issued_on"))}: ${fmtDate(ymd(new Date()))}</div>
          ${S.cert_license_no ? `<div class="no">${esc(t("cert_license_no"))}: ${esc(S.cert_license_no)}</div>` : ""}</div>
      </div>
      <div class="statement">${esc(statement)}</div>
      <div style="display:flex;gap:24px">
        <div style="flex:1"><h3 class="sec">${esc(t("premises"))}</h3>
          <table class="kvt">
            ${row(t("client"), localized(visit, "client"))}
            ${row(t("location"), visit.location || visit.site_name)}
          </table></div>
        <div style="flex:1"><h3 class="sec">${esc(t("nav_visits"))}</h3>
          <table class="kvt">
            ${row(t("service"), localized(visit, "service"))}
            ${row(t("date_of_service"), fmtDateTime(svcDate))}
            ${row(clk.startActual ? t("visit_started_at") : t("scheduled_start"), clk.start ? fmtDateTime(clk.start) : "")}
            ${row(clk.endActual ? t("visit_ended_at") : t("scheduled_end"), clk.end ? fmtDateTime(clk.end) : "")}
            ${row(t("duration"), clk.mins != null ? fmtHours(clk.mins) : "")}
            ${row(t("agent"), visit.agent_name)}
          </table></div>
      </div>
      <h3 class="sec">${esc(t("report"))}</h3>
      <table class="kvt">
        ${row(t("pests_found"), rep.pests_found)}
        ${row(t("findings"), rep.findings)}
        ${listRow(t("recommendations"), rep.recommendations)}
        ${row(t("spare_parts_changed"), rep.spare_parts_changed)}
        ${row(t("branch_issue"), rep.branch_issue)}
      </table>
      ${matRows ? `<h3 class="sec">${esc(t("materials_used"))}</h3>
        <table class="data"><thead><tr><th>${esc(t("materials_used"))}</th><th class="num">${esc(t("quantity"))}</th></tr></thead>
        <tbody>${matRows}</tbody></table>` : ""}
      ${chemRows ? `<h3 class="sec">${esc(t("chemicals_applied"))}</h3>
        <table class="data"><thead><tr><th>${esc(t("name_en"))}</th><th class="num">${esc(t("quantity"))}</th>
        <th>${esc(t("application_method"))}</th><th>${esc(t("application_equipment"))}</th>
        <th>${esc(t("area_treated"))}</th></tr></thead><tbody>${chemRows}</tbody></table>` : ""}
      <div class="sigs">
        <div class="sig">${sigImg(rep.customer_signature)}<div class="ln">${esc(rep.customer_name || t("customer_signature"))}</div></div>
        <div class="sig">${sigImg(rep.technician_signature)}<div class="ln">${esc(visit.agent_name || t("technician_signature"))}</div></div>
        <div class="sig"><div style="height:70px"></div><div class="ln">${esc(t("authorized_signature"))} — ${esc(compName)}</div></div>
      </div>
      <div class="foot">${esc(footer)}</div>
    </div>
    <script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>
    </body></html>`;
  printHtmlDoc(doc);
}

// ---- client-facing certificates list (download per completed visit) ----
async function viewCertificates(v) {
  const visits = await API.get("/visits?status=completed");
  const rows = visits.map(vis => {
    const ready = !!vis.has_report;
    const cell = ready
      ? `<button class="btn sm" data-cert="${vis.id}">📄 ${t("download_certificate")}</button>`
      : `<span class="muted">${t("report_pending")}</span>`;
    return `<tr>
      <td>CERT-${String(vis.id).padStart(5, "0")}</td>
      <td>${fmtDate(vis.completed_at || vis.scheduled_start)}</td>
      <td>${esc(localized(vis, "service") || "—")}</td>
      <td>${esc(vis.agent_name || "—")}</td>
      <td>${cell}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">${t("none")}</td></tr>`;
  v.innerHTML = `<div class="page-head"><h2>${t("my_certificates")}</h2></div>
    <div class="panel"><p class="muted" style="margin:0 0 14px">${t("certificates_hint")}</p>
      <table><thead><tr><th>${t("cert_no")}</th><th>${t("date_of_service")}</th>
      <th>${t("service")}</th><th>${t("agent")}</th><th>${t("certificate")}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  v.querySelectorAll("[data-cert]").forEach(b => b.addEventListener("click", async () => {
    const visit = await API.get(`/visits/${b.dataset.cert}?lang=${LANG}`);
    if (!visit.report || visit.report.status !== "complete") {
      alert(t("no_report_for_cert")); return;
    }
    printCertificate(visit);
  }));
}

// ====================================================================
// Agents & users
// ====================================================================
async function viewAgents(v) {
  const users = await API.get("/users");
  const canPerms = can("permissions.edit");
  v.innerHTML = `<div class="page-head"><h2>${t("agents_title")}</h2>
    ${can("users.create") ? `<button class="btn" id="add-user">+ ${t("new_user")}</button>` : ""}</div>
    <div class="panel"><table><thead><tr><th>${t("full_name")}</th><th>${t("email")}</th>
      <th>${t("role")}</th><th>${t("phone")}</th><th>${t("specialization")}</th><th>${t("actions")}</th></tr></thead>
      <tbody>${users.map(u => `<tr${u.active === 0 ? ' class="muted"' : ""}>
        <td><strong>${esc(u.full_name)}</strong>${u.active === 0 ? ` <span class="badge">${t("inactive")}</span>` : ""}</td>
        <td>${esc(u.email)}</td>
        <td>${t("role_" + u.role)}${u.site_name ? ` <span class="muted">· ${esc(u.site_name)}</span>` : ""}${
          u.role === "area_manager" ? ` <span class="muted small">· ${(u.areas || []).length
            ? esc((u.areas || []).map(a => localized(a, "name")).join(" · "))
            : t("leader_no_areas")}</span>` : ""}${
          u.role === "team_leader" ? ` <span class="muted small">· ${(u.members || []).length
            ? esc((u.members || []).map(m => m.full_name).join(" · "))
            : t("team_empty_short")}</span>` : ""}</td>
        <td>${esc(u.phone || "—")}</td><td>${esc(u.specialization || "—")}</td>
        <td>${can("users.edit") ? `<button class="link-btn sm" data-edit="${u.id}">${t("edit")}</button>` : ""}
          ${canPerms && u.role !== "admin" ? `<button class="link-btn sm" data-perms="${u.id}">🛡️ ${t("permissions_title")}</button>` : ""}
          ${can("users.edit") && u.active === 0 ? `<button class="link-btn sm" data-on="${u.id}">${t("reactivate")}</button>` : ""}
          ${can("users.delete") && u.active !== 0 ? `<button class="link-btn sm" data-off="${u.id}">${t("deactivate")}</button>` : ""}
          ${can("users.delete") ? `<button class="link-btn sm danger" data-del="${u.id}">${t("delete")}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
  if ($("add-user")) $("add-user").addEventListener("click", () => userForm());
  v.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () =>
    userForm(users.find(u => u.id == b.dataset.edit))));
  v.querySelectorAll("[data-perms]").forEach(b => b.addEventListener("click", () =>
    navigate("permissions", { tab: "user", userId: b.dataset.perms })));
  v.querySelectorAll("[data-off]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("deactivate_confirm"))) return;
    try { await API.del("/users/" + b.dataset.off); toast(t("saved")); navigate("agents"); }
    catch (err) { alert(err.message); }
  }));
  v.querySelectorAll("[data-on]").forEach(b => b.addEventListener("click", async () => {
    try { await API.put("/users/" + b.dataset.on, { active: 1 }); toast(t("saved")); navigate("agents"); }
    catch (err) { alert(err.message); }
  }));
  // Deleting is final. When the server refuses because the account carries
  // material issues, it says so and switching them off is offered instead.
  v.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    const who = users.find(u => u.id == b.dataset.del);
    if (!confirm(t("user_delete_confirm").replace("{name}", who ? who.full_name : ""))) return;
    try {
      await API.del("/users/" + b.dataset.del + "/permanent");
      toast(t("deleted")); navigate("agents");
    } catch (err) {
      if (who && who.active !== 0 && confirm(err.message + "\n\n" + t("deactivate_instead"))) {
        try { await API.del("/users/" + b.dataset.del); toast(t("saved")); navigate("agents"); }
        catch (e2) { alert(e2.message); }
      } else { alert(err.message); }
    }
  }));
}

async function userForm(u) {
  const isEdit = !!u; u = u || {};
  const roles = ["admin", "manager", "agent", "area_manager", "team_leader", "client"]
    .map(r => ({ v: r, l: t("role_" + r) }));
  // The area manager's patch is picked here, so the list has to be loaded
  // before the form is drawn rather than after it.
  await loadAreas();
  const held = (u.area_ids || []).map(String);
  const areaBoxes = (cache.areas || []).filter(a => a.active || held.includes(String(a.id)))
    .map(a => `<label class="chk-item"><input type="checkbox" class="uf-area" value="${a.id}"${
      held.includes(String(a.id)) ? " checked" : ""}> ${esc(areaLabel(a))}</label>`).join("");
  // …and the team leader's crew the same way: every engineer, ticked if they
  // report to this person. Somebody already on another team shows whose.
  const crew = (cache.agents || []).filter(a => a.id !== u.id);
  const onTeam = (u.member_ids || []).map(String);
  const memberBoxes = crew.map(a => {
    const taken = a.team_leader_id && String(a.team_leader_id) !== String(u.id);
    const boss = taken ? (crew.find(x => x.id === a.team_leader_id) || {}).full_name : "";
    return `<label class="chk-item"><input type="checkbox" class="uf-member" value="${a.id}"${
      onTeam.includes(String(a.id)) ? " checked" : ""}> ${esc(a.full_name)}${
      boss ? ` <span class="muted small">· ${esc(boss)}</span>` : ""}</label>`;
  }).join("");
  const clientOpts = [{ v: "", l: t("none") }].concat(cache.clients.map(c => ({ v: c.id, l: clientLabel(c) })));
  openModal(isEdit ? t("edit") : t("new_user"), `<form id="uf"><div class="form-grid">
    ${field(t("full_name"), "full_name", { value: u.full_name })}
    ${field(t("email"), "email", { value: u.email, type: "email" })}
    ${field(t("password"), "password", { type: "password" })}
    ${field(t("role"), "role", { options: roles, value: u.role })}
    ${field(t("phone"), "phone", { value: u.phone })}
    ${field(t("specialization"), "specialization", { value: u.specialization })}
    ${field(t("hire_date"), "hire_date", { type: "date", value: u.hire_date })}
    ${field(t("license_no"), "license_no", { value: u.license_no })}
    ${field(t("license_expiry"), "license_expiry", { type: "date", value: u.license_expiry })}
    ${field(t("belongs_to"), "client_id", { options: clientOpts, value: u.client_id })}
    ${field(t("location_lbl"), "site_id", { options: [], value: u.site_id, cls: "uf-site" })}
    <p class="muted uf-site" style="grid-column:1/-1;margin:-6px 0 0;font-size:13px">${t("portal_site_hint")}</p>
    <div class="field full uf-areas"><label>${t("leader_areas")}</label>
      <div class="chk-grid">${areaBoxes || `<span class="muted">${t("areas_empty")}</span>`}</div>
      <p class="muted" style="margin:6px 0 0;font-size:13px">${t("leader_areas_hint")}</p></div>
    <div class="field full uf-team"><label>${t("team_members")}</label>
      <div class="chk-grid">${memberBoxes || `<span class="muted">${t("no_agents_to_roster")}</span>`}</div>
      <p class="muted" style="margin:6px 0 0;font-size:13px">${t("team_members_hint")}</p></div>
    </div><div class="form-actions"><button type="button" class="btn secondary" id="uf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {

    // A client-portal login can be pinned to ONE of that company's locations —
    // offered only when the company actually has locations to choose from.
    const roleSel = root.querySelector("[name=role]");
    const clientSel = root.querySelector("[name=client_id]");
    const siteSel = root.querySelector("[name=site_id]");
    const siteRows = root.querySelectorAll(".uf-site");
    const areaRows = root.querySelectorAll(".uf-areas");
    const teamRows = root.querySelectorAll(".uf-team");
    async function syncSitePicker(reload) {
      if (reload) await loadSiteOptions(clientSel.value, siteSel, u.site_id, t("all_locations"));
      const show = roleSel.value === "client" && !!siteSel.dataset.hasSites;
      siteRows.forEach(el => { el.style.display = show ? "" : "none"; });
      // The area picker belongs to the area manager, the team picker to the
      // team leader, and neither to anybody else.
      areaRows.forEach(el => { el.style.display = roleSel.value === "area_manager" ? "" : "none"; });
      teamRows.forEach(el => { el.style.display = roleSel.value === "team_leader" ? "" : "none"; });
    }
    roleSel.addEventListener("change", () => syncSitePicker(false));
    clientSel.addEventListener("change", () => syncSitePicker(true));
    syncSitePicker(true);
    $("uf-x").addEventListener("click", closeModal);
    root.querySelector("#uf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      if (d.client_id === "") delete d.client_id;
      if (isEdit && !d.password) delete d.password;
      // Checkboxes are invisible to formData() (it reads .value only — the same
      // gotcha as the contract auto-bill and ipm_visible boxes), so the patch
      // and the crew are collected by hand. Each is sent only for the role it
      // belongs to, so saving any other account never touches either.
      if (d.role === "area_manager") {
        d.area_ids = Array.from(root.querySelectorAll(".uf-area:checked")).map(c => Number(c.value));
      }
      if (d.role === "team_leader") {
        d.member_ids = Array.from(root.querySelectorAll(".uf-member:checked")).map(c => Number(c.value));
      }
      try { const saved = isEdit ? await API.put("/users/" + u.id, d) : await API.post("/users", d);
        if (handledOffline(saved)) return;
        closeModal(); cache.clients = await API.get("/clients"); navigate("agents"); }
      catch (err) { alert(err.message); }
    });
  });
}

// ====================================================================
// Permissions (RBAC) — role defaults + per-user overrides
// ====================================================================
// A COLUMN FOR EVERY ACTION THE SERVER KNOWS, not a fixed four.
// The matrix used to draw view/create/edit/delete and nothing else, while the
// catalog also carries `issues.approve`, `cash.approve` and
// `schedule.clear_all`. Those three had no checkbox anywhere in the app: they
// could not be granted, could not be taken away, and ticking a module's master
// box quietly granted four of Issues' five permissions with nothing to say so.
// Columns are read off the catalog now, so a permission added to the server can
// never again be invisible here.
const PERM_COL_ORDER = ["view", "create", "edit", "approve", "delete", "clear_all"];
function permCols(catalog) {
  const used = new Set();
  catalog.forEach(m => (m.actions || []).forEach(a => used.add(a)));
  return PERM_COL_ORDER.filter(a => used.has(a))
    .concat([...used].filter(a => PERM_COL_ORDER.indexOf(a) === -1).sort());
}
let _permCatalog = null;

async function loadPermCatalog() {
  if (!_permCatalog) _permCatalog = await API.get("/permissions/catalog");
  return _permCatalog;
}

// Re-fetch my own profile so nav reflects any change to my role/user perms.
// One path only — see syncMyPerms, which also re-draws the screen underneath.
async function refreshMyPerms() { await syncMyPerms({ force: true }); }

function permMatrixHTML(catalog, effective, opts) {
  const ovr = opts.overrides || {};
  const cols = permCols(catalog);
  const rows = catalog.map(m => {
    const cells = cols.map(act => {
      if (!m.actions.includes(act)) return `<td class="pcell na"></td>`;
      const perm = m.module + "." + act;
      const checked = effective[perm] ? "checked" : "";
      const over = (perm in ovr) ? " overridden" : "";
      const dis = opts.editable ? "" : "disabled";
      return `<td class="pcell${over}" title="${over ? t('perms_overridden') : ''}">
        <input type="checkbox" data-perm="${perm}" ${checked} ${dis}></td>`;
    }).join("");
    const rowToggle = opts.editable
      ? `<input type="checkbox" class="prow" data-mod="${m.module}" title="${t('perms_all')}"> ` : "";
    return `<tr><td class="pmod">${rowToggle}${t("mod_" + m.module)}</td>${cells}</tr>`;
  }).join("");
  return `<table class="perm-table"><thead><tr><th>${t("perms_feature")}</th>
    ${cols.map(c => `<th>${t("col_" + c)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

function collectPerms(wrap) {
  const o = {};
  wrap.querySelectorAll("input[data-perm]").forEach(c => { o[c.dataset.perm] = c.checked; });
  return o;
}

// Module master checkbox toggles every action in its row, and stays in sync.
function wirePermRowToggles(wrap) {
  wrap.querySelectorAll("input.prow").forEach(rc => {
    const mod = rc.dataset.mod;
    const cells = () => [...wrap.querySelectorAll(`input[data-perm^="${mod}."]`)];
    const sync = () => { const cs = cells(); rc.checked = cs.length > 0 && cs.every(c => c.checked); };
    sync();
    rc.addEventListener("change", () => cells().forEach(c => { c.checked = rc.checked; }));
    cells().forEach(c => c.addEventListener("change", sync));
  });
}

async function viewPermissions(v, arg) {
  if (!can("permissions.view")) { v.innerHTML = `<div class="empty">${t("perms_admin_note")}</div>`; return; }
  const cat = await loadPermCatalog();
  const tab = (arg && arg.tab) || "roles";
  v.innerHTML = `<div class="page-head"><h2>${t("permissions_title")}</h2></div>
    <div class="tabs">
      <button class="tab ${tab === "roles" ? "active" : ""}" data-tab="roles">${t("perms_roles_tab")}</button>
      <button class="tab ${tab === "user" ? "active" : ""}" data-tab="user">${t("perms_users_tab")}</button>
    </div><div id="perm-body">${t("loading")}</div>`;
  v.querySelectorAll(".tab").forEach(b =>
    b.addEventListener("click", () => navigate("permissions", { tab: b.dataset.tab })));
  if (tab === "user") await permUsersTab(cat, arg);
  else await permRolesTab(cat, arg);
}

async function permRolesTab(cat, arg) {
  const sel = (arg && arg.role) || "manager";
  $("perm-body").innerHTML = `<div class="panel">
    <div class="toolbar"><label>${t("perms_role_label")}:
      <select id="perm-role">${cat.roles.map(r =>
        `<option value="${r}" ${r === sel ? "selected" : ""}>${t("role_" + r)}</option>`).join("")}</select></label></div>
    <div id="perm-matrix"></div></div>`;
  $("perm-role").addEventListener("change", e =>
    navigate("permissions", { tab: "roles", role: e.target.value }));
  renderRoleMatrix(cat, sel);
}

function renderRoleMatrix(cat, roleName) {
  const wrap = $("perm-matrix");
  const eff = cat.roles_effective[roleName];
  const editable = can("permissions.edit") && roleName !== "admin";
  const intro = roleName === "admin" ? t("perms_admin_note") : t("perms_role_intro");
  wrap.innerHTML = `<p class="muted">${intro}</p>` +
    permMatrixHTML(cat.catalog, eff, { editable, overrides: cat.role_overrides[roleName] }) +
    (editable ? `<div class="form-actions"><button class="btn" id="perm-save">${t("perms_save")}</button></div>` : "");
  wirePermRowToggles(wrap);
  if (editable) $("perm-save").addEventListener("click", async () => {
    try {
      await API.put("/permissions/roles/" + roleName, { perms: collectPerms(wrap) });
      _permCatalog = null;
      toast(t("perms_saved"));
      await refreshMyPerms();
    } catch (err) { alert(err.message); }
  });
}

async function permUsersTab(cat, arg) {
  const users = (await API.get("/users")).filter(u => u.role !== "admin");
  const selId = (arg && arg.userId) || "";
  $("perm-body").innerHTML = `<div class="panel">
    <div class="toolbar"><label>${t("perms_user_label")}:
      <select id="perm-user"><option value="">${t("perms_select_user")}</option>
        ${users.map(u => `<option value="${u.id}" ${String(u.id) === String(selId) ? "selected" : ""}>${esc(u.full_name)} — ${t("role_" + u.role)}</option>`).join("")}</select></label></div>
    <div id="perm-matrix"></div></div>`;
  $("perm-user").addEventListener("change", e =>
    navigate("permissions", { tab: "user", userId: e.target.value }));
  if (selId) await renderUserMatrix(cat, selId);
}

async function renderUserMatrix(cat, userId) {
  const wrap = $("perm-matrix");
  const data = await API.get("/permissions/users/" + userId);
  const editable = can("permissions.edit");
  wrap.innerHTML = `<p class="muted">${t("perms_user_intro")}</p>` +
    permMatrixHTML(cat.catalog, data.effective, { editable, overrides: data.overrides }) +
    (editable ? `<div class="form-actions">
      <button class="btn secondary" id="perm-reset">${t("perms_reset_user")}</button>
      <button class="btn" id="perm-save">${t("perms_save")}</button></div>` : "");
  wirePermRowToggles(wrap);
  if (!editable) return;
  $("perm-save").addEventListener("click", async () => {
    // Store an override only where the chosen value differs from the role default;
    // anything matching the role is sent as null to clear/inherit.
    const cur = collectPerms(wrap), base = data.role_effective, perms = {};
    Object.keys(cur).forEach(p => { perms[p] = (cur[p] === !!base[p]) ? null : cur[p]; });
    try {
      await API.put("/permissions/users/" + userId, { perms });
      toast(t("perms_saved"));
      await refreshMyPerms();
      navigate("permissions", { tab: "user", userId });
    } catch (err) { alert(err.message); }
  });
  $("perm-reset").addEventListener("click", async () => {
    const perms = {};
    Object.keys(data.effective).forEach(p => { perms[p] = null; });
    try {
      await API.put("/permissions/users/" + userId, { perms });
      toast(t("perms_saved"));
      await refreshMyPerms();
      navigate("permissions", { tab: "user", userId });
    } catch (err) { alert(err.message); }
  });
}

// ====================================================================
// Search
// ====================================================================
async function viewSearch(v, arg) {
  const q = (arg && arg.q) || "";
  v.innerHTML = `<div class="page-head"><h2>${t("search_title")}</h2></div>
    <div class="toolbar"><input id="s-input" placeholder="${t("search_placeholder")}" value="${esc(q)}" style="flex:1;max-width:480px" />
    <button class="btn" id="s-go">${t("search")}</button></div><div id="s-results"></div>`;
  const run = async () => {
    const term = $("s-input").value.trim();
    if (!term) { $("s-results").innerHTML = ""; return; }
    const r = await API.get("/search?q=" + encodeURIComponent(term));
    let html = "";
    if (r.clients && r.clients.length) html += `<div class="panel"><h3>${t("nav_clients")}</h3>` +
      r.clients.map(c => `<div><a href="#" data-go="client" data-id="${c.id}">${esc(localized(c, "name"))}</a> <span class="muted small">${esc(c.city || "")}</span></div>`).join("") + `</div>`;
    if (r.visits && r.visits.length) html += `<div class="panel"><h3>${t("nav_visits")}</h3>` +
      r.visits.map(x => `<div><a href="#" data-go="visit" data-id="${x.id}">${esc(x.client_en)} · ${fmtDate(x.scheduled_start)}</a> ${statusBadge(x.status)}</div>`).join("") + `</div>`;
    if (r.chemicals && r.chemicals.length) html += `<div class="panel"><h3>${t("nav_chemicals")}</h3>` +
      r.chemicals.map(c => `<div>${esc(localized(c, "name"))} — ${c.quantity_in_stock} ${esc(c.unit)}</div>`).join("") + `</div>`;
    if (r.invoices && r.invoices.length) html += `<div class="panel"><h3>${t("nav_invoices")}</h3>` +
      r.invoices.map(i => `<div><a href="#" data-go="invoice" data-id="${i.id}">${esc(i.number)}</a> — ${money(i.total)} ${statusBadge(i.status)}</div>`).join("") + `</div>`;
    $("s-results").innerHTML = html || `<div class="empty">${t("no_results")}</div>`;
    $("s-results").querySelectorAll("[data-go]").forEach(a => a.addEventListener("click", (e) => {
      e.preventDefault(); navigate(a.dataset.go, { id: a.dataset.id });
    }));
  };
  $("s-go").addEventListener("click", run);
  $("s-input").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  if (q) run();
}

// ====================================================================
// Exports — CSV / Excel from the server, PDF from the browser
// ====================================================================
// CSV and Excel are the same rows in a different wrapper (the server builds a
// real .xlsx workbook, not a renamed CSV). PDF has no server-side library in
// this app: like every other "PDF" here it is a branded print document.
// `qs` narrows the export to what the page is showing (the finance ledger
// exports the period on screen, not the whole book).
async function downloadExport(entity, fmt, qs = "") {
  const res = await fetch(`/api/export/${entity}.${fmt}${qs}`, { headers: { Authorization: "Bearer " + API.token } });
  if (!res.ok) { alert(t("export_failed")); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${entity}.${fmt}`; a.click();
  URL.revokeObjectURL(url);
}
function downloadCsv(entity) { return downloadExport(entity, "csv"); }

// A ready-made file from the server (the per-report zips) — same auth as any
// API call, saved rather than parsed.
async function downloadZip(url, filename) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + API.token } });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    throw new Error(msg.error || t("export_failed"));
  }
  saveBlob(await res.blob(), filename);
}

// Format picker. pdfFn is optional — only pages that can render a print
// document offer the third choice.
function exportDialog(entity, pdfFn, qs = "") {
  const opt = (fmt, icon, label, hint) => `<button type="button" class="btn secondary exp-opt" data-fmt="${fmt}">
    <span class="exp-ic">${icon}</span><span><strong>${label}</strong><br><span class="muted small">${hint}</span></span></button>`;
  openModal(t("export"), `<div class="export-opts">
    ${opt("csv", "📄", t("export_csv"), t("export_csv_hint"))}
    ${opt("xlsx", "📊", t("export_excel"), t("export_excel_hint"))}
    ${pdfFn ? opt("pdf", "🖨️", t("export_pdf"), t("export_pdf_hint")) : ""}
    </div><div class="form-actions"><button type="button" class="btn secondary" id="exp-x">${t("cancel")}</button></div>`,
    (root) => {
      $("exp-x").addEventListener("click", closeModal);
      root.querySelectorAll(".exp-opt").forEach(b => b.addEventListener("click", async () => {
        const fmt = b.dataset.fmt;
        closeModal();
        try {
          if (fmt === "pdf") await pdfFn();
          else await downloadExport(entity, fmt, qs);
        } catch (e) { alert(e.message); }
      }));
    });
}

// Printable invoice/quote register with the money totalled at the foot —
// the finance view of the same list the page shows.
async function printInvoiceList(docType) {
  const d = await API.get(`/invoices?doc_type=${docType}&page=1&limit=1000`);
  const rows = d.items || d;
  const isInv = docType !== "quote";
  const sum = (f) => rows.reduce((a, r) => a + (Number(r[f]) || 0), 0);
  const totals = { total: sum("total"), paid: sum("paid") };
  const body = `<div class="panel"><table><thead><tr>
      <th>${t("invoice_no")}</th><th>${t("client")}</th><th>${t("issue_date")}</th>
      <th>${t("due_date")}</th><th class="num">${t("total")}</th>
      ${isInv ? `<th class="num">${t("paid")}</th><th class="num">${t("balance")}</th>` : ""}
      <th>${t("status")}</th></tr></thead>
    <tbody>${rows.map(i => `<tr>
      <td>${esc(i.number)}</td><td>${esc(localized(i, "client"))}</td>
      <td>${fmtDate(i.issue_date)}</td><td>${fmtDate(i.due_date)}</td>
      <td class="num">${money(i.total)}</td>
      ${isInv ? `<td class="num">${money(i.paid)}</td><td class="num">${money((i.total || 0) - (i.paid || 0))}</td>` : ""}
      <td>${statusBadge(i.status)}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">${t("none")}</td></tr>`}
    </tbody><tfoot><tr><th colspan="4">${t("total")} (${rows.length})</th>
      <th class="num">${money(totals.total)}</th>
      ${isInv ? `<th class="num">${money(totals.paid)}</th><th class="num">${money(totals.total - totals.paid)}</th>` : ""}
      <th></th></tr></tfoot></table></div>`;
  analyticsReportDoc(isInv ? t("invoices_title") : t("nav_quotes"),
                     `${t("generated_on")} ${new Date().toLocaleDateString(LANG === "ar" ? "ar" : "en-GB")}`,
                     body);
}

// ====================================================================
// Finance & Costs — the owner's page: what the company spends every month
// and every year (rent, salaries, tax, licences) set against what it collects.
// ====================================================================
const COST_CATEGORIES = ["rent", "salary", "tax", "utilities", "vehicle", "fuel",
  "materials", "equipment", "insurance", "licenses", "marketing", "office",
  "maintenance", "bank", "other"];
// 'inventory', 'transport' and 'pocket' are read from the stock-in log, the
// travel log and the engineers' pocket money; they appear in the totals but
// are never entered here.
const CAT_ICON = { rent: "🏢", salary: "👔", tax: "🏛️", utilities: "💡", vehicle: "🚐",
  fuel: "⛽", materials: "🧪", equipment: "🛠️", insurance: "🛡️", licenses: "📜",
  marketing: "📣", office: "🖇️", maintenance: "🔧", bank: "🏦", other: "📌",
  inventory: "📦", transport: "🚕", pocket: "👛" };
function catLabel(c) { return `${CAT_ICON[c] || "📌"} ${t("exp_cat_" + c)}`; }

let financeYear = null;                 // null = current year
let profitBasis = "visits";             // how overhead is spread over customers/deals
let cashflowWeeks = 13;                 // forecast horizon (a quarter by default)
let cashflowData = null;
let clientProfitData = null;            // last per-client run, for the printable
let contractProfitData = null;          // last per-contract run, likewise
let financeData = null;                 // last summary, for the printable P&L
const expenseFilter = { category: "", page: 1 };

async function viewFinance(v) {
  const year = financeYear || String(new Date().getFullYear());
  const d = await API.get(`/finance/summary?year=${year}`);
  financeData = d;
  financeYear = year;
  const T = d.totals, R = d.run_rate;
  const dueCount = (d.upcoming || []).filter(u => u.overdue).length;
  const kpi = (val, label, icon, cls, extra = "") =>
    `<div class="stat-card ${cls}"><div class="sc-ic">${icon}</div><div>
      <div class="v">${val}</div><div class="l">${label}</div>${extra}</div></div>`;
  const years = (d.years || []).map(y =>
    `<option value="${y}" ${y === year ? "selected" : ""}>${y}</option>`).join("");

  v.innerHTML = `<div class="page-head"><h2>${t("nav_finance")}</h2>
    <div class="fin-head-btns">
      <select id="fin-year">${years}</select>
      ${can("finance.create") ? `<button class="btn secondary" id="fin-post">⏱️ ${t("fin_post_due")}</button>` : ""}
      <button class="btn secondary" id="fin-export">⬇ ${t("export")}</button>
      ${can("finance.create") ? `<button class="btn secondary" id="fin-add-rec">🔁 ${t("fin_add_recurring")}</button>
      <button class="btn" id="fin-add-exp">+ ${t("fin_add_expense")}</button>` : ""}
    </div></div>
    <p class="muted small">${t("finance_hint")}</p>
    <div class="cards cockpit-kpis">
      ${kpi(money(T.revenue), t("fin_revenue"), "💵", "c-green",
            `<div class="sc-trend">${t("fin_invoiced")}: ${money(T.invoiced)}</div>`)}
      ${kpi(money(T.costs), t("fin_costs"), "🧾", "warn",
            `<div class="sc-trend">${t("fin_of_which_derived")}: ${money(T.purchases + T.transport + (T.pocket || 0))}</div>`)}
      ${kpi(money(T.profit), t("fin_profit"), T.profit < 0 ? "📉" : "📈",
            T.profit < 0 ? "danger" : "c-green",
            `<div class="sc-trend ${T.profit < 0 ? "down" : "up"}">${T.margin}% ${t("fin_margin")}</div>`)}
      ${kpi(money(R.monthly), t("fin_run_rate"), "🔁", "",
            `<div class="sc-trend">${money(R.annual)} ${t("fin_per_year")}</div>`)}
      ${kpi(money(R.payroll_monthly), t("fin_payroll_month"), "👔", "")}
      ${kpi(money(T.outstanding), t("fin_outstanding"), "⏰", T.outstanding > 0 ? "warn" : "c-green")}
    </div>
    <div class="panel"><h3>📈 ${t("fin_rev_vs_cost")} <span class="muted">· ${year}</span></h3>
      ${financeChart(d)}${financeMonthTable(d)}</div>
    <div class="panel"><div class="section-title"><h3>💧 ${t("fin_cashflow")}</h3>
        <div class="fin-filters"><select id="fin-weeks">
          ${[4, 13, 26, 52].map(w => `<option value="${w}" ${w === cashflowWeeks ? "selected" : ""}>${w} ${t("weeks_lbl")}</option>`).join("")}
        </select></div></div>
      <div id="fin-cashflow">${t("loading")}</div></div>
    <div class="grid-2">
      <div class="panel"><h3>🧾 ${t("fin_by_category")}</h3>${financeCategories(d)}</div>
      <div class="panel"><h3>🔔 ${t("fin_upcoming")}${dueCount ? ` <span class="badge b-overdue">${dueCount}</span>` : ""}</h3>
        <p class="muted small">${t("fin_upcoming_hint")}</p>${financeUpcoming(d)}
        ${financeExpiring(d)}</div>
    </div>
    <div class="panel"><div class="section-title"><h3>🎯 ${t("fin_budget_vs_actual")}</h3>
        ${can("finance.create") ? `<button class="btn secondary sm" id="fin-budgets">${t("fin_set_budgets")}</button>` : ""}</div>
      ${financeBudget(d)}</div>
    <div class="panel"><div class="section-title"><h3>🏢 ${t("fin_per_client")}</h3>
        <div class="fin-filters"><select id="fin-basis">
          <option value="visits" ${profitBasis === "visits" ? "selected" : ""}>${t("fin_basis_visits")}</option>
          <option value="revenue" ${profitBasis === "revenue" ? "selected" : ""}>${t("fin_basis_revenue")}</option>
        </select></div></div>
      <p class="muted small">${t("fin_per_client_hint")}</p>
      <div id="fin-clients">${t("loading")}</div></div>
    <div class="panel"><h3>📑 ${t("fin_per_contract")}</h3>
      <p class="muted small">${t("fin_per_contract_hint")}</p>
      <div id="fin-contracts">${t("loading")}</div></div>
    <div class="panel"><div class="section-title"><h3>🔁 ${t("fin_standing_costs")}</h3></div>
      <p class="muted small">${t("fin_standing_hint")}</p>
      <div id="fin-recurring">${t("loading")}</div></div>
    <div class="panel"><h3>👔 ${t("fin_payroll")} <span class="muted">· ${year}</span></h3>
      <p class="muted small">${t("fin_payroll_hint")}</p>${financePayroll(d)}</div>
    <div class="panel"><div class="section-title"><h3>📒 ${t("fin_expense_ledger")}</h3>
        <div class="fin-filters">
          <select id="fin-cat"><option value="">${t("all")}</option>
            ${COST_CATEGORIES.map(c => `<option value="${c}" ${expenseFilter.category === c ? "selected" : ""}>${esc(t("exp_cat_" + c))}</option>`).join("")}
          </select></div></div>
      <div id="fin-ledger">${t("loading")}</div></div>`;

  $("fin-year").addEventListener("change", (e) => {
    financeYear = e.target.value; expenseFilter.page = 1; navigate("finance");
  });
  $("fin-cat").addEventListener("change", (e) => {
    expenseFilter.category = e.target.value; expenseFilter.page = 1; loadExpenseLedger(d);
  });
  $("fin-export").addEventListener("click", () =>
    exportDialog("expenses", () => printFinance(d), `?from=${d.from}&to=${d.to}`));
  if ($("fin-add-exp")) $("fin-add-exp").addEventListener("click", () => expenseForm(null, d));
  if ($("fin-add-rec")) $("fin-add-rec").addEventListener("click", () => costForm(null, d));
  if ($("fin-budgets")) $("fin-budgets").addEventListener("click", () => budgetForm(d));
  if ($("fin-post")) $("fin-post").addEventListener("click", async () => {
    try {
      const r = await API.post("/recurring-costs/post", {});
      toast(r.created ? `${t("fin_posted")}: ${r.created}` : t("fin_nothing_due"));
      navigate("finance");
    } catch (e) { alert(e.message); }
  });
  $("fin-basis").addEventListener("change", (e) => {
    // One choice drives both allocations — the split is the same question.
    profitBasis = e.target.value; loadClientProfit(d); loadContractProfit(d);
  });
  $("fin-weeks").addEventListener("change", (e) => {
    cashflowWeeks = Number(e.target.value) || 13; loadCashflow();
  });
  loadCashflow();
  loadClientProfit(d);
  loadContractProfit(d);
  loadRecurringCosts(d);
  loadExpenseLedger(d);
}

// Revenue and cost as curves; profit is left to the table below because a
// negative month has no place on an area chart that starts at zero.
function financeChart(d) {
  const labels = d.months.map(m => monthShort(m.m));
  return curveChart(labels, [
    { name: t("fin_revenue"), color: "#16a34a", values: d.months.map(m => m.revenue) },
    { name: t("fin_costs"), color: "#dc2626", values: d.months.map(m => m.costs) },
  ], { money: true });
}

function financeMonthTable(d) {
  const rows = d.months.map(m => `<tr>
      <td>${esc(monthShort(m.m))} ${esc(m.m.slice(0, 4))}</td>
      <td class="num">${money(m.revenue)}</td>
      <td class="num">${money(m.costs)}</td>
      <td class="num ${m.profit < 0 ? "neg" : "pos"}"><strong>${money(m.profit)}</strong></td>
    </tr>`).join("");
  const T = d.totals;
  return `<table class="fin-months"><thead><tr><th>${t("month")}</th>
      <th class="num">${t("fin_revenue")}</th><th class="num">${t("fin_costs")}</th>
      <th class="num">${t("fin_profit")}</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><th>${t("total")}</th><th class="num">${money(T.revenue)}</th>
      <th class="num">${money(T.costs)}</th>
      <th class="num ${T.profit < 0 ? "neg" : "pos"}">${money(T.profit)}</th></tr></tfoot></table>`;
}

function financeCategories(d) {
  const cats = d.by_category || [];
  if (!cats.length) return `<div class="empty">${t("fin_no_costs")}</div>`;
  const total = cats.reduce((a, c) => a + c.amount, 0) || 1;
  const rows = cats.map((c, i) => {
    const pct = Math.round(c.amount * 100 / total);
    const color = PALETTE[i % PALETTE.length];
    return `<tr><td>${esc(catLabel(c.category))}
        ${c.derived ? `<span class="muted small" title="${esc(t("fin_derived_hint"))}">·&nbsp;${t("fin_auto")}</span>` : ""}</td>
      <td class="cat-bar"><span style="width:${pct}%;background:${color}"></span></td>
      <td class="num">${money(c.amount)}</td><td class="num muted">${pct}%</td></tr>`;
  }).join("");
  return `<table class="cat-table"><tbody>${rows}</tbody></table>
    <p class="muted small">${t("fin_derived_hint")}</p>`;
}

// Cash flow forecast — the only panel that looks forward. Built entirely from
// dates already in the system: standing costs from their next due date, and
// money in from unpaid invoices plus the invoices auto-billing contracts will
// raise. The balance line starts from cash on hand (Settings).
async function loadCashflow() {
  const box = $("fin-cashflow");
  if (!box) return;
  box.innerHTML = `<div class="empty">${t("loading")}</div>`;
  let d;
  try { d = await API.get(`/finance/cashflow?weeks=${cashflowWeeks}`); }
  catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  cashflowData = d;
  const T = d.totals;
  if (!d.item_count) {
    box.innerHTML = `<div class="empty">${t("fin_no_cashflow")}</div>`;
    return;
  }
  const labels = d.buckets.map(b => fmtDayMonth(b.start));
  const chart = curveChart(labels, [
    { name: t("fin_cash_in"), color: "#16a34a", values: d.buckets.map(b => b.in) },
    { name: t("fin_cash_out"), color: "#dc2626", values: d.buckets.map(b => b.out) },
  ], { money: true });
  const warn = d.shortfall
    ? `<div class="cf-warn">⚠️ ${t("fin_shortfall_warn")
        .replace("{date}", fmtDate(d.shortfall.start))
        .replace("{amount}", money(d.shortfall.balance))}</div>`
    : `<div class="cf-ok">✅ ${t("fin_no_shortfall")}</div>`;
  const openingNote = d.opening_set ? "" :
    `<div class="muted small">${t("fin_opening_missing")}</div>`;
  const rows = d.buckets.map(b => `<tr>
      <td>${esc(fmtDayMonth(b.start))} – ${esc(fmtDayMonth(b.end))}</td>
      <td class="num">${b.in ? money(b.in) : "—"}</td>
      <td class="num">${b.out ? money(b.out) : "—"}</td>
      <td class="num ${b.net < 0 ? "neg" : "pos"}">${money(b.net)}</td>
      <td class="num ${b.balance < 0 ? "neg" : ""}"><strong>${money(b.balance)}</strong></td>
    </tr>`).join("");
  const flag = (i) => i.overdue ? `<span class="badge b-overdue">${t("fin_overdue_now")}</span>`
    : (i.needs_action ? `<span class="badge b-draft">${t("cost_manual")}</span>`
    : (i.certainty === "expected" ? `<span class="badge b-draft">${t("fin_expected_cash")}</span>` : ""));
  const items = d.items.slice(0, 15).map(i => `<tr>
      <td>${fmtDate(i.date)}</td>
      <td>${i.kind === "in" ? "⬆️" : "⬇️"} ${esc(i.label)} ${flag(i)}</td>
      <td class="num ${i.kind === "in" ? "pos" : "neg"}">${i.kind === "in" ? "+" : "−"}${money(i.amount)}</td>
    </tr>`).join("");
  box.innerHTML = `${warn}
    <div class="cf-kpis">
      <div><span class="l">${t("fin_opening")}</span><span class="v">${money(d.opening)}</span>${openingNote}</div>
      <div><span class="l">${t("fin_cash_in")}</span><span class="v pos">${money(T.in)}</span>
        ${d.overdue_in ? `<span class="muted small">${t("fin_overdue_included")}: ${money(d.overdue_in)}</span>` : ""}</div>
      <div><span class="l">${t("fin_cash_out")}</span><span class="v neg">${money(T.out)}</span></div>
      <div><span class="l">${t("fin_closing")}</span>
        <span class="v ${T.closing < 0 ? "neg" : "pos"}">${money(T.closing)}</span></div>
    </div>
    ${chart}
    <div class="grid-2" style="margin-top:12px">
      <div><table class="fin-cf"><thead><tr><th>${t("fin_week")}</th>
          <th class="num">${t("fin_cash_in")}</th><th class="num">${t("fin_cash_out")}</th>
          <th class="num">${t("fin_net")}</th><th class="num">${t("fin_balance")}</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <div><table class="fin-cf"><thead><tr><th colspan="3">${t("fin_next_movements")}</th></tr></thead>
        <tbody>${items}</tbody></table>
        ${d.item_count > 15 ? `<p class="muted small">${t("fin_more_movements").replace("{n}", d.item_count - 15)}</p>` : ""}
      </div></div>
    <div id="fin-vat"></div>
    <p class="muted small">${t("fin_cashflow_hint")}</p>`;
  loadVatReturns();
}

// The tax charged on invoices, and what is still owed to the authority. Sits
// under the forecast because that is the panel it changes.
async function loadVatReturns() {
  const box = $("fin-vat");
  if (!box) return;
  let d;
  try { d = await API.get("/vat-returns"); } catch (e) { box.innerHTML = ""; return; }
  if (d.filing === "none") {
    box.innerHTML = `<p class="muted small">${t("fin_vat_off")}</p>`;
    return;
  }
  const rows = (d.returns || []).filter(r => r.status === "pending" || r.net_due > 0);
  const line = (r, open) => `<tr>
      <td><strong>${esc(r.period)}</strong>
        <div class="muted small">${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}</div></td>
      <td class="num">${money(r.output_vat)}</td>
      <td class="num">${money(r.input_vat)}</td>
      <td class="num"><strong>${money(r.net_due)}</strong></td>
      <td>${fmtDate(r.due_date)} ${r.overdue ? `<span class="badge b-overdue">${t("fin_overdue_now")}</span>` : ""}</td>
      <td>${open ? `<span class="badge b-draft">${t("fin_vat_open")}</span>`
        : (r.status === "paid" ? `<span class="badge b-completed">${t("inv_paid")}</span>`
        : `<span class="badge b-sent">${t("fin_vat_pending")}</span>`)}</td>
      <td>${!open && r.status === "pending" && can("finance.create")
        ? `<button class="link-btn sm" data-vat-pay="${r.id}">${t("fin_vat_pay")}</button>
           ${can("finance.edit") ? ` · <button class="link-btn sm" data-vat-edit="${r.id}">${t("fin_vat_input")}</button>` : ""}`
        : ""}</td></tr>`;
  box.innerHTML = `<div class="section-title" style="margin-top:16px"><h4>🏛️ ${t("fin_vat")}</h4></div>
    <table class="fin-cf"><thead><tr><th>${t("fin_vat_period")}</th>
      <th class="num">${t("fin_vat_output")}</th><th class="num">${t("fin_vat_input")}</th>
      <th class="num">${t("fin_vat_net")}</th><th>${t("due_date")}</th>
      <th>${t("status")}</th><th></th></tr></thead>
    <tbody>${d.running ? line(d.running, true) : ""}${rows.map(r => line(r, false)).join("")
      || (d.running ? "" : `<tr><td colspan="7" class="empty">${t("fin_vat_none")}</td></tr>`)}
    </tbody></table>
    <p class="muted small">${t("fin_vat_hint")}</p>`;
  box.querySelectorAll("[data-vat-pay]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("fin_vat_pay_confirm"))) return;
    try {
      await API.post(`/vat-returns/${b.dataset.vatPay}/pay`, {});
      toast(t("saved")); navigate("finance");
    } catch (e) { alert(e.message); }
  }));
  box.querySelectorAll("[data-vat-edit]").forEach(b => b.addEventListener("click", async () => {
    const cur = prompt(t("fin_vat_input_prompt"), "0");
    if (cur === null) return;
    try {
      await API.put(`/vat-returns/${b.dataset.vatEdit}`, { input_vat: cur });
      toast(t("saved")); loadVatReturns();
    } catch (e) { alert(e.message); }
  }));
}

// "27 Jul" — short enough for a chart axis and a week column.
function fmtDayMonth(s) {
  const dt = new Date(String(s).replace(" ", "T"));
  return isNaN(dt) ? s : dt.toLocaleDateString(LANG === "ar" ? "ar" : "en-GB",
                                               { day: "numeric", month: "short" });
}

// Budget against actual. The budget shown is the year's intention prorated to
// the window on screen, so a part-year view is compared with a part-year budget
// rather than flattering itself against the whole year's allowance.
function financeBudget(d) {
  const B = d.budget || {};
  const rows = B.categories || [];
  if (!rows.length) return `<div class="empty">${t("fin_no_budgets")}</div>`;
  const bar = (r) => {
    if (!r.budget) return `<span class="muted small">${t("fin_no_budget_set")}</span>`;
    const pct = Math.min(100, Math.round(r.used_pct));
    const cls = r.over ? "over" : (r.used_pct >= 90 ? "near" : "");
    return `<div class="bud-bar ${cls}"><span style="width:${pct}%"></span></div>`;
  };
  const T = B.totals || {};
  return `<table class="fin-budget"><thead><tr>
      <th>${t("cost_category")}</th><th class="num">${t("fin_budget")}</th>
      <th class="num">${t("fin_actual")}</th><th class="num">${t("fin_variance")}</th>
      <th>${t("fin_used")}</th><th class="num"></th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${esc(catLabel(r.category))}${r.period
        ? `<div class="muted small">${money(r.set_amount)} · ${t(r.period === "annual" ? "budget_annual" : "budget_monthly")}</div>` : ""}</td>
      <td class="num">${r.budget ? money(r.budget) : "—"}</td>
      <td class="num">${money(r.actual)}</td>
      <td class="num ${!r.budget ? "muted" : (r.variance < 0 ? "neg" : "pos")}">${r.budget ? money(r.variance) : "—"}</td>
      <td>${bar(r)}</td>
      <td class="num ${r.over ? "neg" : "muted"}">${r.used_pct != null ? r.used_pct + "%" : ""}</td>
    </tr>`).join("")}</tbody>
    <tfoot><tr><th>${t("total")}</th><th class="num">${money(T.budget)}</th>
      <th class="num">${money(T.actual)}</th>
      <th class="num ${T.variance < 0 ? "neg" : "pos"}">${money(T.variance)}</th>
      <th></th><th class="num ${T.over ? "neg" : "muted"}">${T.used_pct != null ? T.used_pct + "%" : ""}</th></tr></tfoot>
    </table>
    <p class="muted small">${t("fin_budget_window_hint").replace("{months}", B.months)}</p>`;
}

// One modal for the whole year's budget: every category, what it is allowed,
// and whether that figure is monthly or annual. Only changed rows are sent.
function budgetForm(d) {
  const year = (d.from || "").slice(0, 4);
  const set = {};
  (d.budget && d.budget.categories || []).forEach(r => {
    if (r.set_amount != null) set[r.category] = r;
  });
  const cats = d.budget_categories || COST_CATEGORIES;
  const rows = cats.map(c => {
    const r = set[c] || {};
    return `<tr data-cat="${c}">
      <td>${esc(catLabel(c))}</td>
      <td><select class="bud-period">
        <option value="monthly" ${r.period !== "annual" ? "selected" : ""}>${t("budget_monthly")}</option>
        <option value="annual" ${r.period === "annual" ? "selected" : ""}>${t("budget_annual")}</option>
      </select></td>
      <td><input class="bud-amount" type="number" step="0.01" min="0"
        value="${r.set_amount != null ? r.set_amount : ""}" placeholder="—"
        data-was="${r.set_amount != null ? r.set_amount : ""}"
        data-was-period="${r.period || "monthly"}" data-id="${r.budget_id || ""}"></td></tr>`;
  }).join("");
  openModal(`${t("fin_set_budgets")} — ${esc(year)}`, `<form id="budf">
    <p class="muted small">${t("fin_budget_hint")}</p>
    <table class="bud-form"><thead><tr><th>${t("cost_category")}</th>
      <th>${t("fin_budget_period")}</th><th>${t("cost_amount")}</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <div class="form-actions"><button type="button" class="btn secondary" id="budf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("budf-x").addEventListener("click", closeModal);
    root.querySelector("#budf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const jobs = [];
      root.querySelectorAll("tr[data-cat]").forEach(tr => {
        const amountEl = tr.querySelector(".bud-amount");
        const period = tr.querySelector(".bud-period").value;
        const val = amountEl.value.trim();
        const was = amountEl.dataset.was;
        const wasPeriod = amountEl.dataset.wasPeriod;
        if (val === was && (val === "" || period === wasPeriod)) return;   // untouched
        if (val === "") {
          // Cleared: drop the budget rather than storing a zero, which would
          // read as "allowed to spend nothing" and flag the category forever.
          if (amountEl.dataset.id) jobs.push(API.del(`/budgets/${amountEl.dataset.id}`));
        } else {
          jobs.push(API.post("/budgets", { category: tr.dataset.cat, year,
                                           period, amount: val }));
        }
      });
      if (!jobs.length) { closeModal(); return; }
      try {
        await Promise.all(jobs);
        closeModal(); toast(t("saved")); navigate("finance");
      } catch (err) { alert(err.message); }
    });
  });
}

function financeUpcoming(d) {
  const up = d.upcoming || [];
  if (!up.length) return `<div class="empty">${t("fin_nothing_due")}</div>`;
  return `<table><tbody>${up.map(u => `<tr>
      <td>${esc(catLabel(u.category))}</td>
      <td><strong>${esc(u.name)}</strong></td>
      <td>${fmtDate(u.next_due)} ${u.overdue ? `<span class="badge b-overdue">${t("fin_due")}</span>` : ""}</td>
      <td class="num">${money(u.amount)}</td></tr>`).join("")}</tbody></table>`;
}

// Contracts running out inside 90 days. The cheapest revenue a company keeps is
// the contract it renews before the customer notices it lapsed.
function financeExpiring(d) {
  const rows = d.expiring || [];
  if (!rows.length) return "";
  return `<div class="section-title" style="margin-top:14px"><h4>📅 ${t("fin_expiring")}</h4></div>
    <table><tbody>${rows.map(c => `<tr>
      <td><strong>${esc(localized(c, "client"))}</strong>
        <div class="muted small">${esc(t("freq_" + c.frequency))} · ${money(c.price)}</div></td>
      <td>${fmtDate(c.end_date)}</td>
      <td class="num ${c.days_left <= 30 ? "neg" : ""}">${c.days_left} ${t("days")}</td>
    </tr>`).join("")}</tbody></table>
    <p class="muted small">${t("fin_expiring_hint")}</p>`;
}

function financePayroll(d) {
  const rows = (d.payroll || []).filter(p => p.monthly || p.paid || p.visits);
  if (!rows.length) return `<div class="empty">${t("fin_no_salaries")}</div>`;
  const editable = can("finance.create");
  return `<table class="util-table"><thead><tr>
      <th>${t("full_name")}</th><th>${t("role")}</th><th class="num">${t("fin_salary_month")}</th>
      <th class="num">${t("fin_paid_period")}</th><th class="num">${t("fin_visits_done")}</th>
      <th class="num">${t("fin_hours")}</th><th class="num">${t("fin_cost_per_visit")}</th>
      <th class="num">${t("fin_cost_per_hour")}</th>${editable ? "<th></th>" : ""}</tr></thead>
    <tbody>${rows.map(p => `<tr>
      <td><strong>${esc(p.name)}</strong>${p.active ? "" : ` <span class="badge b-inactive">${t("fin_person_left")}</span>`}</td>
      <td>${p.role ? esc(t("role_" + p.role)) : "—"}</td>
      <td class="num">${p.monthly ? money(p.monthly) : "—"}</td>
      <td class="num">${money(p.paid)}</td>
      <td class="num">${p.visits}</td>
      <td class="num">${p.hours ? p.hours.toFixed(1) : "—"}</td>
      <td class="num">${p.cost_per_visit ? money(p.cost_per_visit) : "—"}</td>
      <td class="num">${p.cost_per_hour ? money(p.cost_per_hour) : "—"}</td>
      ${editable ? `<td><button class="link-btn sm" data-sal="${p.user_id || ""}" data-rec="${p.recurring_id || ""}">
        ${p.recurring_id ? t("edit") : t("fin_set_salary")}</button></td>` : ""}</tr>`).join("")}
    </tbody></table>`;
}

// Which company is worth serving. Revenue is that customer's own money; the
// four cost columns are what reaching it took — the last one, overhead, is a
// share of the bills nobody in particular runs up.
async function loadClientProfit(d) {
  const box = $("fin-clients");
  if (!box) return;
  box.innerHTML = `<div class="empty">${t("loading")}</div>`;
  let res;
  try {
    res = await API.get(`/finance/clients?from=${d.from}&to=${d.to}&basis=${profitBasis}`);
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  clientProfitData = res;
  const rows = res.clients || [];
  if (!rows.length) { box.innerHTML = `<div class="empty">${t("fin_no_client_data")}</div>`; return; }
  const T = res.totals;
  box.innerHTML = `<table class="fin-clients"><thead><tr>
      <th>${t("client")}</th><th class="num">${t("fin_visits_done")}</th>
      <th class="num">${t("fin_hours")}</th>
      <th class="num">${t("fin_revenue")}</th><th class="num">${t("exp_cat_materials")}</th>
      <th class="num">${t("exp_cat_transport")}</th><th class="num">${t("exp_cat_pocket")}</th>
      <th class="num">${t("fin_labour")}</th>
      <th class="num">${t("fin_overhead")}</th><th class="num">${t("fin_costs")}</th>
      <th class="num">${t("fin_profit")}</th><th class="num">${t("fin_margin")}</th></tr></thead>
    <tbody>${rows.map((c, i) => `<tr data-client="${c.client_id}">
      <td><strong>${i === 0 && c.profit > 0 ? "🥇 " : ""}${esc(localized(c, "name"))}</strong>
        ${c.last_visit ? `<div class="muted small">${t("last_service")}: ${fmtDate(c.last_visit)}</div>` : ""}</td>
      <td class="num">${c.visits}</td>
      <td class="num">${c.hours ? c.hours.toFixed(1) : "—"}</td>
      <td class="num">${money(c.revenue)}</td>
      <td class="num">${money(c.materials)}</td>
      <td class="num">${money(c.travel)}</td>
      <td class="num">${money(c.pocket || 0)}</td>
      <td class="num">${money(c.labour)}</td>
      <td class="num muted">${money(c.overhead)}</td>
      <td class="num">${money(c.cost)}</td>
      <td class="num ${c.profit < 0 ? "neg" : "pos"}"><strong>${money(c.profit)}</strong></td>
      <td class="num ${c.profit < 0 ? "neg" : "pos"}">${c.margin}%</td></tr>`).join("")}
    </tbody><tfoot><tr><th>${t("total")}</th><th class="num">${T.visits}</th>
      <th class="num">${T.hours ? T.hours.toFixed(1) : "—"}</th>
      <th class="num">${money(T.revenue)}</th><th class="num">${money(T.materials)}</th>
      <th class="num">${money(T.travel)}</th><th class="num">${money(T.pocket || 0)}</th>
      <th class="num">${money(T.labour)}</th>
      <th class="num">${money(T.overhead)}</th><th class="num">${money(T.cost)}</th>
      <th class="num ${T.profit < 0 ? "neg" : "pos"}">${money(T.profit)}</th><th></th></tr></tfoot></table>`;
  box.insertAdjacentHTML("beforeend",
    `<p class="muted small">${t(res.labour_basis === "hours" ? "fin_labour_by_hours" : "fin_labour_by_visits")}</p>`);
  box.querySelectorAll("[data-client]").forEach(tr => tr.addEventListener("click", () =>
    navigate("client-analytics", { id: tr.dataset.client })));
}

// Which deal is priced right. `expected` is what the contract's own price and
// cadence should have brought in over the window — revenue far below it is a
// billing problem, not a bad contract, and the two are worth telling apart.
async function loadContractProfit(d) {
  const box = $("fin-contracts");
  if (!box) return;
  box.innerHTML = `<div class="empty">${t("loading")}</div>`;
  let res;
  try {
    res = await API.get(`/finance/contracts?from=${d.from}&to=${d.to}&basis=${profitBasis}`);
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  contractProfitData = res;
  const rows = res.contracts || [];
  if (!rows.length && !res.unattributed) {
    box.innerHTML = `<div class="empty">${t("fin_no_contract_data")}</div>`; return;
  }
  const T = res.totals;
  const cells = (c) => `<td class="num">${c.visits}</td>
      <td class="num">${c.hours ? c.hours.toFixed(1) : "—"}</td>
      <td class="num">${money(c.revenue)}</td>
      <td class="num muted">${c.expected != null ? money(c.expected) : "—"}</td>
      <td class="num">${money(c.materials)}</td>
      <td class="num">${money(c.travel)}</td>
      <td class="num">${money(c.pocket || 0)}</td>
      <td class="num">${money(c.labour)}</td>
      <td class="num muted">${money(c.overhead)}</td>
      <td class="num">${money(c.cost)}</td>
      <td class="num ${c.profit < 0 ? "neg" : "pos"}"><strong>${money(c.profit)}</strong></td>
      <td class="num ${c.profit < 0 ? "neg" : "pos"}">${c.margin}%</td>`;
  const u = res.unattributed;
  box.innerHTML = `<table class="fin-clients"><thead><tr>
      <th>${t("nav_contracts")}</th><th class="num">${t("fin_visits_done")}</th>
      <th class="num">${t("fin_hours")}</th>
      <th class="num">${t("fin_revenue")}</th><th class="num">${t("fin_expected")}</th>
      <th class="num">${t("exp_cat_materials")}</th><th class="num">${t("exp_cat_transport")}</th>
      <th class="num">${t("exp_cat_pocket")}</th>
      <th class="num">${t("fin_labour")}</th><th class="num">${t("fin_overhead")}</th>
      <th class="num">${t("fin_costs")}</th><th class="num">${t("fin_profit")}</th>
      <th class="num">${t("fin_margin")}</th></tr></thead>
    <tbody>${rows.map((c, i) => `<tr data-client="${c.client_id}">
      <td><strong>${i === 0 && c.profit > 0 ? "🥇 " : ""}${esc(localized(c, "client"))}</strong>
        <div class="muted small">#${c.contract_id} · ${esc(t("freq_" + c.frequency))}
          ${c.service_en ? "· " + esc(localized(c, "service")) : ""}
          · ${money(c.price)}${c.status !== "active" ? " · " + esc(t("ct_" + c.status)) : ""}</div></td>
      ${cells(c)}</tr>`).join("")}
      ${u ? `<tr class="row-off"><td><strong>${t("fin_no_contract_work")}</strong>
        <div class="muted small">${t("fin_no_contract_work_hint")}</div></td>${cells(u)}</tr>` : ""}
    </tbody><tfoot><tr><th>${t("total")}</th><th class="num">${T.visits}</th>
      <th class="num">${T.hours ? T.hours.toFixed(1) : "—"}</th>
      <th class="num">${money(T.revenue)}</th><th></th>
      <th class="num">${money(T.materials)}</th><th class="num">${money(T.travel)}</th>
      <th class="num">${money(T.pocket || 0)}</th>
      <th class="num">${money(T.labour)}</th><th class="num">${money(T.overhead)}</th>
      <th class="num">${money(T.cost)}</th>
      <th class="num ${T.profit < 0 ? "neg" : "pos"}">${money(T.profit)}</th><th></th></tr></tfoot></table>`;
  box.querySelectorAll("[data-client]").forEach(tr => tr.addEventListener("click", () =>
    navigate("client-analytics", { id: tr.dataset.client })));
}

async function loadRecurringCosts(d) {
  const box = $("fin-recurring");
  if (!box) return;
  let rows = [];
  try { rows = await API.get("/recurring-costs"); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const canEdit = can("finance.edit"), canDel = can("finance.delete");
  box.innerHTML = rows.length ? `<table><thead><tr>
      <th>${t("cost_name")}</th><th>${t("cost_category")}</th><th class="num">${t("cost_amount")}</th>
      <th>${t("cost_cycle")}</th><th class="num">${t("cost_monthly_equiv")}</th>
      <th>${t("cost_next_due")}</th><th>${t("cost_person")}</th>
      ${canEdit || canDel ? `<th>${t("actions")}</th>` : ""}</tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.active ? "" : "row-off"}">
      <td><strong>${esc(r.name)}</strong>${r.vendor ? `<div class="muted small">${esc(r.vendor)}</div>` : ""}</td>
      <td>${esc(catLabel(r.category))}</td>
      <td class="num">${money(r.amount)}</td>
      <td>${esc(t("freq_" + r.frequency))}${r.auto_post ? "" : `<br><span class="badge b-draft">${t("cost_manual")}</span>`}</td>
      <td class="num">${money(r.monthly_equiv)}</td>
      <td>${r.next_due ? fmtDate(r.next_due) : "—"} ${r.due_now ? `<span class="badge b-overdue">${t("fin_due")}</span>` : ""}</td>
      <td>${esc(r.user_name || "—")}${r.user_name && r.user_active === 0
        ? ` <span class="badge b-inactive">${t("fin_person_left")}</span>` : ""}</td>
      ${canEdit || canDel ? `<td>
        ${canEdit ? `<button class="link-btn sm" data-rec-edit="${r.id}">${t("edit")}</button>` : ""}
        ${canEdit && canDel ? " · " : ""}
        ${canDel ? `<button class="link-btn danger sm" data-rec-del="${r.id}">${t("delete")}</button>` : ""}
      </td>` : ""}</tr>`).join("")}</tbody></table>`
    : `<div class="empty">${t("fin_no_standing")}</div>`;
  box.querySelectorAll("[data-rec-edit]").forEach(b => b.addEventListener("click", () =>
    costForm(rows.find(r => r.id == b.dataset.recEdit), d)));
  box.querySelectorAll("[data-rec-del]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("fin_delete_standing_confirm"))) return;
    try { await API.del("/recurring-costs/" + b.dataset.recDel); toast(t("deleted")); navigate("finance"); }
    catch (e) { alert(e.message); }
  }));
  // The payroll table's Set salary / Edit buttons open the same standing-order
  // form, pre-pointed at that person.
  document.querySelectorAll("[data-sal]").forEach(b => b.addEventListener("click", () => {
    const rec = rows.find(r => r.id == b.dataset.rec);
    if (rec) costForm(rec, d);
    else costForm({ category: "salary", frequency: "monthly", user_id: b.dataset.sal }, d);
  }));
}

async function loadExpenseLedger(d) {
  const box = $("fin-ledger");
  if (!box) return;
  box.innerHTML = `<div class="empty">${t("loading")}</div>`;
  const q = `?from=${d.from}&to=${d.to}&page=${expenseFilter.page}&limit=25`
    + (expenseFilter.category ? `&category=${expenseFilter.category}` : "");
  let res;
  try { res = await API.get("/expenses" + q); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const rows = res.items || res;
  const canEdit = can("finance.edit"), canDel = can("finance.delete");
  box.innerHTML = rows.length ? `<table><thead><tr>
      <th>${t("date")}</th><th>${t("cost_category")}</th><th>${t("description")}</th>
      <th>${t("cost_person")}</th><th>${t("supplier")}</th><th class="num">${t("cost_amount")}</th>
      <th>${t("exp_source")}</th><th>${t("fin_receipt")}</th>
      ${canEdit || canDel ? `<th>${t("actions")}</th>` : ""}</tr></thead>
    <tbody>${rows.map(e => `<tr>
      <td>${fmtDate(e.spent_on)}</td>
      <td>${esc(catLabel(e.category))}</td>
      <td>${esc(e.description || "—")}${e.reference ? `<div class="muted small">${esc(e.reference)}</div>` : ""}</td>
      <td>${esc(e.user_name || "—")}</td>
      <td>${esc(e.vendor || "—")}</td>
      <td class="num">${money(e.amount)}</td>
      <td>${e.source === "recurring"
        ? `<span class="badge b-active" title="${esc(e.recurring_name || "")}">🔁 ${t("exp_auto")}</span>`
        : `<span class="muted small">${t("exp_manual")}</span>`}</td>
      <td><button class="link-btn sm" data-exp-rec="${e.id}"
        title="${esc(t("fin_receipts"))}">📎 ${e.receipts || 0}</button></td>
      ${canEdit || canDel ? `<td>
        ${canEdit ? `<button class="link-btn sm" data-exp-edit="${e.id}">${t("edit")}</button>` : ""}
        ${canEdit && canDel ? " · " : ""}
        ${canDel ? `<button class="link-btn danger sm" data-exp-del="${e.id}">${t("delete")}</button>` : ""}
      </td>` : ""}</tr>`).join("")}</tbody></table>${pagerHTML(res)}`
    : `<div class="empty">${t("fin_no_expenses")}</div>`;
  wirePager(box, res, (p) => { expenseFilter.page = p; loadExpenseLedger(d); });
  box.querySelectorAll("[data-exp-rec]").forEach(b => b.addEventListener("click", () =>
    expenseReceipts(rows.find(e => e.id == b.dataset.expRec), d)));
  box.querySelectorAll("[data-exp-edit]").forEach(b => b.addEventListener("click", () =>
    expenseForm(rows.find(e => e.id == b.dataset.expEdit), d)));
  box.querySelectorAll("[data-exp-del]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("confirm_delete"))) return;
    try { await API.del("/expenses/" + b.dataset.expDel); toast(t("deleted")); loadExpenseLedger(d); }
    catch (e) { alert(e.message); }
  }));
}

// Everyone a cost can be attached to. Comes from the summary (which lists all
// staff) so the page needs no extra permission to name a person.
function costPeopleOptions(d, selected) {
  const people = (d && d.payroll || []).filter(p => p.user_id);
  return [{ v: "", l: t("none") }].concat(people.map(p => ({ v: p.user_id, l: p.name })))
    .map(o => `<option value="${esc(o.v)}" ${String(o.v) === String(selected || "") ? "selected" : ""}>${esc(o.l)}</option>`).join("");
}

// A standing order: the rent, one salary, the annual licence. Saving it does
// not spend anything — it posts an expense each time its date comes round.
function costForm(rec, d) {
  const isEdit = !!(rec && rec.id);
  const r = rec || {};
  const today = ymd(new Date());
  openModal(isEdit ? t("edit") : t("fin_add_recurring"), `<form id="costf"><div class="form-grid">
    ${field(t("cost_name"), "name", { value: r.name, cls: "full", attrs: "required" })}
    ${field(t("cost_category"), "category", { options: COST_CATEGORIES.map(c => ({ v: c, l: t("exp_cat_" + c) })), value: r.category || "rent" })}
    ${field(t("cost_amount"), "amount", { type: "number", value: r.amount != null ? r.amount : "", attrs: 'step="0.01" min="0" required' })}
    ${field(t("cost_cycle"), "frequency", { options: FREQS.map(f => ({ v: f, l: t("freq_" + f) })), value: r.frequency || "monthly" })}
    ${field(t("cost_start"), "start_date", { type: "date", value: (r.start_date || today).slice(0, 10) })}
    ${field(t("cost_next_due"), "next_due", { type: "date", value: (r.next_due || r.start_date || today).slice(0, 10) })}
    ${field(t("cost_end"), "end_date", { type: "date", value: (r.end_date || "").slice(0, 10) })}
    <div class="field"><label>${t("cost_person")}</label>
      <select name="user_id">${costPeopleOptions(d, r.user_id)}</select>
      <div class="muted small">${t("cost_person_hint")}</div></div>
    ${field(t("supplier"), "vendor", { value: r.vendor })}
    ${field(t("notes"), "note", { value: r.note, textarea: true, cls: "full" })}
    <div class="field full"><label><input type="checkbox" id="cost-auto" ${r.auto_post === 0 ? "" : "checked"}>
      ${t("cost_auto_post")}</label><div class="muted small">${t("cost_auto_post_hint")}</div></div>
    <div class="field full"><label><input type="checkbox" id="cost-active" ${isEdit && !r.active ? "" : "checked"}>
      ${t("cost_active")}</label></div>
    </div><div class="form-actions"><button type="button" class="btn secondary" id="costf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("costf-x").addEventListener("click", closeModal);
    root.querySelector("#costf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = formData(root);
      body.auto_post = $("cost-auto").checked ? 1 : 0;
      body.active = $("cost-active").checked ? 1 : 0;
      try {
        if (isEdit) await API.put("/recurring-costs/" + r.id, body);
        else await API.post("/recurring-costs", body);
        closeModal(); toast(t("saved")); navigate("finance");
      } catch (err) { alert(err.message); }
    });
  });
}

// One amount that left the company on one day.
function expenseForm(exp, d) {
  const isEdit = !!(exp && exp.id);
  const e = exp || {};
  const today = ymd(new Date());
  openModal(isEdit ? t("edit") : t("fin_add_expense"), `<form id="expf"><div class="form-grid">
    ${field(t("exp_date"), "spent_on", { type: "date", value: (e.spent_on || today).slice(0, 10), attrs: "required" })}
    ${field(t("cost_category"), "category", { options: COST_CATEGORIES.map(c => ({ v: c, l: t("exp_cat_" + c) })), value: e.category || "other" })}
    ${field(t("cost_amount"), "amount", { type: "number", value: e.amount != null ? e.amount : "", attrs: 'step="0.01" min="0" required' })}
    ${field(t("description"), "description", { value: e.description, cls: "full" })}
    <div class="field"><label>${t("cost_person")}</label>
      <select name="user_id">${costPeopleOptions(d, e.user_id)}</select></div>
    ${field(t("supplier"), "vendor", { value: e.vendor })}
    ${field(t("exp_method"), "method", { value: e.method })}
    ${field(t("exp_reference"), "reference", { value: e.reference })}
    ${field(t("notes"), "note", { value: e.note, textarea: true, cls: "full" })}
    </div><div class="form-actions"><button type="button" class="btn secondary" id="expf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("expf-x").addEventListener("click", closeModal);
    root.querySelector("#expf").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const body = formData(root);
      try {
        if (isEdit) await API.put("/expenses/" + e.id, body);
        else await API.post("/expenses", body);
        closeModal(); toast(t("saved"));
        if (currentView === "finance") navigate("finance");
      } catch (err) { alert(err.message); }
    });
  });
}

// Receipts for one cost. An expense without one is a claim, not a record —
// which is the difference that matters when the tax office asks.
async function expenseReceipts(exp, d) {
  if (!exp) return;
  const render = async () => {
    let files = [];
    try {
      files = await API.get(`/photos?entity_type=expense&entity_id=${exp.id}`);
    } catch (e) { /* shown as empty below */ }
    const body = files.length ? `<table><tbody>${files.map(f => `<tr>
        <td>${/\.pdf$/i.test(f.filename) ? "📄" : "🖼️"}
          <a href="/uploads/${esc(f.filename)}" target="_blank" rel="noopener">${esc(f.original_name || f.filename)}</a>
          ${f.caption ? `<div class="muted small">${esc(f.caption)}</div>` : ""}</td>
        <td>${fmtDate(f.uploaded_at)}</td>
        <td>${can("finance.edit") ? `<button class="link-btn danger sm" data-rec-del="${f.id}">${t("delete")}</button>` : ""}</td>
      </tr>`).join("")}</tbody></table>`
      : `<div class="empty">${t("fin_no_receipts")}</div>`;
    openModal(`${t("fin_receipts")} — ${esc(exp.description || catLabel(exp.category))} · ${money(exp.amount)}`,
      `<p class="muted small">${t("fin_receipt_hint")}</p>${body}
       <div class="form-actions"><button type="button" class="btn secondary" id="rec-x">${t("close")}</button>
       ${can("finance.edit") ? `<button type="button" class="btn" id="rec-add">📎 ${t("fin_add_receipt")}</button>` : ""}</div>`,
      (root) => {
        $("rec-x").addEventListener("click", () => { closeModal(); loadExpenseLedger(d); });
        if ($("rec-add")) $("rec-add").addEventListener("click", () =>
          uploadPhotoDialog("expense", exp.id, render));
        root.querySelectorAll("[data-rec-del]").forEach(b => b.addEventListener("click", async () => {
          if (!confirm(t("confirm_delete"))) return;
          try { await API.del("/photos/" + b.dataset.recDel); render(); }
          catch (e) { alert(e.message); }
        }));
      });
  };
  await render();
}

// The printable profit & loss: the same numbers the page shows, on the
// company's letterhead.
function printFinance(d) {
  const T = d.totals;
  const line = (label, val, cls = "") =>
    `<tr class="${cls}"><td>${esc(label)}</td><td class="num">${money(val)}</td></tr>`;
  const cats = (d.by_category || []).map(c =>
    line(t("exp_cat_" + c.category) + (c.derived ? ` (${t("fin_auto")})` : ""), c.amount)).join("");
  const months = d.months.map(m => `<tr>
      <td>${esc(monthShort(m.m))} ${esc(m.m.slice(0, 4))}</td>
      <td class="num">${money(m.revenue)}</td><td class="num">${money(m.costs)}</td>
      <td class="num">${money(m.profit)}</td></tr>`).join("");
  const pay = (d.payroll || []).filter(p => p.monthly || p.paid).map(p => `<tr>
      <td>${esc(p.name)}</td><td>${p.role ? esc(t("role_" + p.role)) : "—"}</td>
      <td class="num">${p.monthly ? money(p.monthly) : "—"}</td>
      <td class="num">${money(p.paid)}</td><td class="num">${p.visits}</td></tr>`).join("");
  const body = `<div class="panel"><h3>${esc(t("fin_summary"))}</h3>
      <table><tbody>
        ${line(t("fin_revenue"), T.revenue)}
        ${line(t("fin_invoiced"), T.invoiced)}
        ${line(t("fin_costs"), T.costs)}
        ${line(t("fin_profit"), T.profit, "fin-total")}
      </tbody><tfoot><tr><th>${esc(t("fin_margin"))}</th><th class="num">${T.margin}%</th></tr></tfoot></table></div>
    <div class="panel"><h3>${esc(t("fin_by_category"))}</h3><table><tbody>${cats}</tbody></table></div>
    <div class="panel"><h3>${esc(t("fin_rev_vs_cost"))}</h3><table><thead><tr>
        <th>${esc(t("month"))}</th><th class="num">${esc(t("fin_revenue"))}</th>
        <th class="num">${esc(t("fin_costs"))}</th><th class="num">${esc(t("fin_profit"))}</th>
      </tr></thead><tbody>${months}</tbody></table></div>
    ${cashflowData && cashflowData.item_count ? `<div class="panel"><h3>${esc(t("fin_cashflow"))}</h3>
      <table><thead><tr><th>${esc(t("fin_week"))}</th><th class="num">${esc(t("fin_cash_in"))}</th>
        <th class="num">${esc(t("fin_cash_out"))}</th><th class="num">${esc(t("fin_net"))}</th>
        <th class="num">${esc(t("fin_balance"))}</th></tr></thead>
      <tbody>${cashflowData.buckets.map(b => `<tr>
        <td>${esc(fmtDayMonth(b.start))} – ${esc(fmtDayMonth(b.end))}</td>
        <td class="num">${money(b.in)}</td><td class="num">${money(b.out)}</td>
        <td class="num">${money(b.net)}</td><td class="num">${money(b.balance)}</td></tr>`).join("")}
      </tbody><tfoot><tr><th>${esc(t("fin_closing"))}</th>
        <th class="num">${money(cashflowData.totals.in)}</th>
        <th class="num">${money(cashflowData.totals.out)}</th>
        <th class="num">${money(cashflowData.totals.net)}</th>
        <th class="num">${money(cashflowData.totals.closing)}</th></tr></tfoot></table>
      <p class="muted small">${esc(t("fin_cashflow_hint"))}</p></div>` : ""}
    ${(d.budget && d.budget.set_count) ? `<div class="panel"><h3>${esc(t("fin_budget_vs_actual"))}</h3>
      <table><thead><tr><th>${esc(t("cost_category"))}</th>
        <th class="num">${esc(t("fin_budget"))}</th><th class="num">${esc(t("fin_actual"))}</th>
        <th class="num">${esc(t("fin_variance"))}</th><th class="num">${esc(t("fin_used"))}</th></tr></thead>
      <tbody>${(d.budget.categories || []).map(r => `<tr>
        <td>${esc(t("exp_cat_" + r.category))}</td>
        <td class="num">${r.budget ? money(r.budget) : "—"}</td>
        <td class="num">${money(r.actual)}</td>
        <td class="num">${r.budget ? money(r.variance) : "—"}</td>
        <td class="num">${r.used_pct != null ? r.used_pct + "%" : ""}</td></tr>`).join("")}
      </tbody><tfoot><tr><th>${esc(t("total"))}</th>
        <th class="num">${money(d.budget.totals.budget)}</th>
        <th class="num">${money(d.budget.totals.actual)}</th>
        <th class="num">${money(d.budget.totals.variance)}</th>
        <th class="num">${d.budget.totals.used_pct != null ? d.budget.totals.used_pct + "%" : ""}</th></tr></tfoot>
      </table></div>` : ""}
    ${clientProfitData ? `<div class="panel"><h3>${esc(t("fin_per_client"))}</h3><table><thead><tr>
        <th>${esc(t("client"))}</th><th class="num">${esc(t("fin_visits_done"))}</th>
        <th class="num">${esc(t("fin_revenue"))}</th><th class="num">${esc(t("fin_costs"))}</th>
        <th class="num">${esc(t("fin_profit"))}</th><th class="num">${esc(t("fin_margin"))}</th>
      </tr></thead><tbody>${(clientProfitData.clients || []).map(c => `<tr>
        <td>${esc(localized(c, "name"))}</td><td class="num">${c.visits}</td>
        <td class="num">${money(c.revenue)}</td><td class="num">${money(c.cost)}</td>
        <td class="num">${money(c.profit)}</td><td class="num">${c.margin}%</td></tr>`).join("")}
      </tbody></table><p class="muted small">${esc(t("fin_per_client_hint"))}</p></div>` : ""}
    ${contractProfitData ? `<div class="panel"><h3>${esc(t("fin_per_contract"))}</h3><table><thead><tr>
        <th>${esc(t("nav_contracts"))}</th><th class="num">${esc(t("fin_visits_done"))}</th>
        <th class="num">${esc(t("fin_revenue"))}</th><th class="num">${esc(t("fin_expected"))}</th>
        <th class="num">${esc(t("fin_costs"))}</th><th class="num">${esc(t("fin_profit"))}</th>
        <th class="num">${esc(t("fin_margin"))}</th></tr></thead>
      <tbody>${(contractProfitData.contracts || []).map(c => `<tr>
        <td>${esc(localized(c, "client"))} <span class="muted">#${c.contract_id} · ${esc(t("freq_" + c.frequency))}</span></td>
        <td class="num">${c.visits}</td><td class="num">${money(c.revenue)}</td>
        <td class="num">${money(c.expected)}</td><td class="num">${money(c.cost)}</td>
        <td class="num">${money(c.profit)}</td><td class="num">${c.margin}%</td></tr>`).join("")}
        ${contractProfitData.unattributed ? `<tr><td>${esc(t("fin_no_contract_work"))}</td>
          <td class="num">${contractProfitData.unattributed.visits}</td>
          <td class="num">${money(contractProfitData.unattributed.revenue)}</td><td></td>
          <td class="num">${money(contractProfitData.unattributed.cost)}</td>
          <td class="num">${money(contractProfitData.unattributed.profit)}</td><td></td></tr>` : ""}
      </tbody></table></div>` : ""}
    ${pay ? `<div class="panel"><h3>${esc(t("fin_payroll"))}</h3><table><thead><tr>
        <th>${esc(t("full_name"))}</th><th>${esc(t("role"))}</th>
        <th class="num">${esc(t("fin_salary_month"))}</th><th class="num">${esc(t("fin_paid_period"))}</th>
        <th class="num">${esc(t("fin_visits_done"))}</th></tr></thead><tbody>${pay}</tbody></table></div>` : ""}`;
  analyticsReportDoc(t("fin_pl_statement"), `${d.from} — ${d.to}`, body);
}

// ====================================================================
// Notifications (topbar bell)
// ====================================================================
let notifTimer = null;
let notifLastMaxId = null;            // baseline; sound plays when it grows
let notifMuted = localStorage.getItem("notifMuted") === "1";
let _audioCtx = null;
// Short two-tone chime via Web Audio (no asset needed). Unlocked on first click.
function playNotifSound() {
  if (notifMuted) return;
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const beep = (freq, at, dur) => {
      const o = _audioCtx.createOscillator(), g = _audioCtx.createGain();
      o.connect(g); g.connect(_audioCtx.destination); o.type = "sine"; o.frequency.value = freq;
      const t0 = _audioCtx.currentTime + at;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.start(t0); o.stop(t0 + dur);
    };
    beep(880, 0, 0.35); beep(1175, 0.18, 0.4);
  } catch (e) {}
}
// Browsers require a user gesture before audio can play — unlock on first click.
document.addEventListener("click", function unlockAudio() {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
  } catch (e) {}
  document.removeEventListener("click", unlockAudio);
}, { once: true });

async function initNotifications() {
  if (role() === "client") { $("topbar-right").innerHTML = ""; return; }
  // Scanning belongs to the work, not to the chrome: the scan buttons live in
  // the visit's Device Coverage panel, one per device type.
  $("topbar-right").innerHTML = `<div class="bell-wrap">
    <button id="bell" class="icon-btn" style="font-size:20px;position:relative">🔔<span id="bell-count" class="bell-badge hidden">0</span></button>
    <div id="bell-menu" class="bell-menu hidden"></div></div>`;
  $("bell").addEventListener("click", toggleBell);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".bell-wrap")) $("bell-menu").classList.add("hidden");
  });
  notifLastMaxId = null;   // reset baseline on (re)login so we don't replay old ones
  await refreshNotifications();
  clearInterval(notifTimer);
  notifTimer = setInterval(refreshNotifications, 60000);
}
async function refreshNotifications() {
  try {
    const d = await API.get(`/notifications?lang=${LANG}`);
    const c = $("bell-count");
    if (!c) return;
    if (d.unread > 0) { c.textContent = d.unread; c.classList.remove("hidden"); }
    else c.classList.add("hidden");
    window._notifs = d.items;
    // play a sound when a genuinely new notification has arrived since last poll
    const maxId = (d.items || []).reduce((m, n) => Math.max(m, n.id || 0), 0);
    if (notifLastMaxId !== null && maxId > notifLastMaxId && d.unread > 0) playNotifSound();
    notifLastMaxId = maxId;
  } catch (e) {}
}
function toggleBell() {
  const menu = $("bell-menu");
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
  const items = window._notifs || [];
  menu.innerHTML = `<div class="bell-head"><strong>${t("notifications_title")}</strong>
    <span style="display:flex;gap:10px;align-items:center">
      <button class="link-btn sm" id="bell-mute" title="${t("sound")}">${notifMuted ? "🔇" : "🔊"}</button>
      <button class="link-btn sm" id="bell-prefs" title="${t("notif_prefs")}">⚙️</button>
      <button class="link-btn sm" id="bell-read">${t("mark_all_read")}</button></span></div>
    ${items.length ? items.map(n => `<div class="notif ${n.is_read ? "" : "unread"}" data-link="${n.link_view || ""}" data-id="${n.link_id || ""}">
      <div class="nt">${esc(n.title)}</div><div class="nb muted small">${esc(n.body || "")}</div></div>`).join("")
      : `<div class="empty">${t("no_notifications")}</div>`}`;
  menu.classList.remove("hidden");
  $("bell-mute").addEventListener("click", (e) => {
    e.stopPropagation();
    notifMuted = !notifMuted;
    localStorage.setItem("notifMuted", notifMuted ? "1" : "0");
    $("bell-mute").textContent = notifMuted ? "🔇" : "🔊";
    if (!notifMuted) playNotifSound();   // confirm sound when re-enabling
  });
  $("bell-prefs").addEventListener("click", (e) => {
    e.stopPropagation(); menu.classList.add("hidden"); notifPrefsDialog();
  });
  $("bell-read").addEventListener("click", async (e) => { e.stopPropagation(); await API.post("/notifications/read", {}); refreshNotifications(); menu.classList.add("hidden"); });
  menu.querySelectorAll(".notif").forEach(n => n.addEventListener("click", () => {
    const view = n.dataset.link, id = n.dataset.id;
    menu.classList.add("hidden");
    if (view) navigate(view, { id });
  }));
}

// ====================================================================
// Calendar + agent day view
// ====================================================================
// A Date -> "YYYY-MM-DD" using its LOCAL calendar date. Never toISOString():
// every Date here is built at local midnight (new Date(s + "T00:00:00")), and
// east of UTC that is the previous day in UTC — which silently shifted every
// date this returns one day back, so Next/Prev/Today all landed a day early.
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// A Date -> "YYYY-MM-DD HH:MM:SS" on the LOCAL clock — the one the person
// holding the phone is reading. The same warning as ymd, and it had bitten
// harder: a check-in was sent as toISOString(), which is UTC, so an engineer
// arriving at 11:00 in Cairo was filed as arriving at 08:00 — and that is the
// time now printed on the customer's report as "Visit started".
function localStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${ymd(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// The calendar has two views: the whole month, or one day on its own. Which one
// you get is remembered per device — a dispatcher plans in the month, while an
// engineer on a phone usually only wants today.
function calMode(arg) {
  const m = (arg && arg.mode) || localStorage.getItem("calMode") || "month";
  return m === "day" ? "day" : "month";
}
function calModeSwitch(mode) {
  return `<div class="cal-modes">
    <button class="btn sm ${mode === "month" ? "" : "secondary"}" data-calmode="month">${t("month_view")}</button>
    <button class="btn sm ${mode === "day" ? "" : "secondary"}" data-calmode="day">${t("day_view")}</button></div>`;
}
// day = which date the day view should land on when switching into it.
function wireCalModes(v, day) {
  v.querySelectorAll("[data-calmode]").forEach(b => b.addEventListener("click", () => {
    const mode = b.dataset.calmode;
    localStorage.setItem("calMode", mode);
    // Switching between the month and one day is a change of VIEW, not of who
    // is being looked at, so the engineer in the filter comes along.
    const agent = (document.getElementById("cal-agent") || {}).value || undefined;
    navigate("calendar", mode === "day"
      ? { mode, day, agent } : { mode, month: day.slice(0, 7), agent });
  }));
}

async function viewCalendar(v, arg) {
  if (calMode(arg) === "day") return viewCalendarDay(v, arg);
  const base = (arg && arg.month) ? new Date(arg.month + "-01") : new Date();
  base.setDate(1);
  const y = base.getFullYear(), m = base.getMonth();
  const monthStr = `${y}-${String(m + 1).padStart(2, "0")}`;
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const visits = await API.get(`/visits?from=${y}-${String(m + 1).padStart(2, "0")}-01&to=${ymd(last)}`);
  const byDay = {};
  visits.forEach(vi => { const k = (vi.scheduled_start || "").slice(0, 10); (byDay[k] = byDay[k] || []).push(vi); });
  // A day reads DOWNWARDS through the working day. The list arrives newest
  // first (that is right for the Schedule screen, not for a calendar cell).
  Object.keys(byDay).forEach(k => byDay[k].sort((a, b) =>
    String(a.scheduled_start || "").localeCompare(String(b.scheduled_start || ""))));
  // The engineer the month is being read for. It travels in the address of the
  // screen, so stepping to the next month keeps showing the same man's work
  // instead of quietly going back to everybody's.
  const chosen = (arg && arg.agent) ? String(arg.agent) : "";
  const agentFilter = hasAgentList() ? `<select id="cal-agent"><option value="">${t("all")} ${t("nav_agents")}</option>
    ${cache.agents.map(a => `<option value="${a.id}"${String(a.id) === chosen ? " selected" : ""}>${esc(a.full_name)}</option>`).join("")}</select>` : "";
  const monthName = base.toLocaleDateString(LANG === "ar" ? "ar" : "en-GB", { month: "long", year: "numeric" });
  const startDow = (first.getDay() + 1) % 7; // Saturday-first, matching the roster week
  const CELL_MAX = 4;                        // what fits in a month cell
  // ONE DAY'S CELL, FOR WHOEVER IS BEING LOOKED AT. The filter is applied to
  // the day's work BEFORE the cell is cut down to what fits: cutting first and
  // hiding afterwards is what made an engineer's own day look blank — his job
  // was rarely among the four the cell had drawn, and the rest sat behind a
  // "+N" that no filter could open. Whoever is chosen, the cell now shows HIS
  // first four and counts the rest of HIS day.
  const cellsHTML = (agentId) => {
    let out = "";
    for (let i = 0; i < startDow; i++) out += `<div class="cal-cell empty-cell"></div>`;
    for (let day = 1; day <= last.getDate(); day++) {
      const k = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const all = byDay[k] || [];
      const dayVisits = agentId
        ? all.filter(vi => String(vi.agent_id || "") === String(agentId)) : all;
      const isToday = k === ymd(new Date());
      out += `<div class="cal-cell ${isToday ? "today" : ""}"><div class="cal-day" data-calday="${k}" title="${t("day_view")}">${day}</div>
      ${dayVisits.slice(0, CELL_MAX).map(vi => { const loc = vi.site_name || vi.location || ""; return `<div class="cal-ev b-${vi.status}" data-visit="${vi.id}" data-agent="${vi.agent_id || ""}"
        title="${esc(localized(vi, "client"))}${loc ? " — " + esc(loc) : ""}">${esc((localized(vi, "client") || "").slice(0, 16))}${loc ? `<span class="cal-ev-site">📍 ${esc(loc.slice(0, 16))}</span>` : ""}</div>`; }).join("")}
      ${dayVisits.length > CELL_MAX ? `<div class="muted small">+${dayVisits.length - CELL_MAX}</div>` : ""}</div>`;
    }
    return out;
  };
  const cells = cellsHTML(chosen);
  const dows = (LANG === "ar" ? ["سب", "أح", "إث", "ثل", "أر", "خم", "جم"] : ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"]);
  v.innerHTML = `<div class="page-head"><h2>${t("calendar_title")}</h2><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${calModeSwitch("month")}
      ${agentFilter}
      <button class="btn secondary sm" id="cal-prev">${t("prev")}</button>
      <strong style="min-width:140px;text-align:center">${monthName}</strong>
      <button class="btn secondary sm" id="cal-next">${t("next")}</button>
      <button class="btn secondary sm" id="cal-today">${t("today")}</button>
      <button class="btn secondary sm" id="cal-print">🖨 ${t("cal_print")}</button></div></div>
    <p class="muted small" style="margin:-6px 0 10px">${t("cal_day_hint")}</p>
    <div class="cal-scroll">
      <div class="cal-grid head">${dows.map(d => `<div class="cal-dow">${d}</div>`).join("")}</div>
      <div class="cal-grid" id="cal-body">${cells}</div>
    </div>`;
  // Switching to the day view lands on today when today is in view, else on the
  // first of the month being looked at.
  const todayIso = ymd(new Date());
  wireCalModes(v, todayIso.slice(0, 7) === monthStr ? todayIso : `${monthStr}-01`);
  const picked = () => ($("cal-agent") ? $("cal-agent").value : "");
  const go = (delta) => {
    const nd = new Date(y, m + delta, 1);
    navigate("calendar", { month: `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}`,
                           agent: picked() || undefined });
  };
  $("cal-prev").addEventListener("click", () => go(-1));
  $("cal-next").addEventListener("click", () => go(1));
  $("cal-today").addEventListener("click", () => navigate("calendar", { agent: picked() || undefined }));
  // A SHEET FOR THE OFFICE. Asks the two things that change what is printed —
  // how much of the calendar, and whose — then fetches exactly that range.
  $("cal-print").addEventListener("click", () => {
    const one = picked();
    const who = (cache.agents || []).filter(a => !one || String(a.id) === String(one));
    openModal(t("cal_print"), `<form id="cal-pf" class="form-grid">
        <div class="field"><label>${t("cal_period")}</label>
          <select name="period">
            <option value="week">${t("this_week_lc")}</option>
            <option value="month" selected>${t("this_month_lc")}</option></select></div>
        <div class="field"><label>${t("nav_agents")}</label>
          <select name="agent">
            <option value="">${t("cal_all_engineers")}</option>
            ${(cache.agents || []).map(a => `<option value="${a.id}"${
              String(a.id) === String(one) ? " selected" : ""}>${esc(a.full_name)}</option>`).join("")}
          </select></div>
        <div class="modal-actions full"><button class="btn" type="submit">🖨 ${t("cal_print")}</button></div>
      </form>`);
    $("cal-pf").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      let from, to;
      if (f.period.value === "week") {
        // The week the calendar is sitting in, Saturday to Friday — the roster
        // week the office already thinks in.
        const base = new Date(`${monthStr}-01T00:00:00`);
        const today = new Date();
        const anchor = (ymd(today).slice(0, 7) === monthStr) ? today : base;
        const back = (anchor.getDay() + 1) % 7;              // Saturday = 0
        const s0 = new Date(anchor); s0.setDate(anchor.getDate() - back);
        from = ymd(s0);
        const e0 = new Date(s0); e0.setDate(s0.getDate() + 6); to = ymd(e0);
      } else {
        from = `${monthStr}-01`; to = ymd(last);
      }
      const pickedAgent = f.agent.value;
      const agents = (cache.agents || []).filter(a => !pickedAgent || String(a.id) === String(pickedAgent));
      closeModal();
      try {
        const [vis, posts] = await Promise.all([
          API.get(`/visits?from=${from}&to=${to}`),
          can("shifts.view") ? API.get("/fixed-assignments").catch(() => ({ items: [] }))
                             : Promise.resolve({ items: [] }),
        ]);
        printHtmlDoc(scheduleDocHtml({
          from, to, agents,
          visits: Array.isArray(vis) ? vis : (vis.items || []),
          posts: posts.items || [],
        }));
      } catch (e) { alert(e.message || t("error")); }
    });
  });
  // Only the grid is redrawn, from the month already in hand — choosing an
  // engineer asks the server for nothing.
  const wireCells = () => {
    v.querySelectorAll("[data-calday]").forEach(el => el.addEventListener("click", () => {
      localStorage.setItem("calMode", "day");
      navigate("calendar", { mode: "day", day: el.dataset.calday, agent: picked() || undefined });
    }));
    v.querySelectorAll(".cal-ev").forEach(ev =>
      ev.addEventListener("click", () => navigate("visit", { id: ev.dataset.visit })));
  };
  if ($("cal-agent")) $("cal-agent").addEventListener("change", () => {
    $("cal-body").innerHTML = cellsHTML(picked());
    wireCells();
  });
  wireCells();
}

// One day on its own: every visit of that date in time order, stepping a day at
// a time. Reuses visitsTable, so a phone gets the same cards as every other
// list and a row still opens the visit.
// ONE ENGINEER'S SCHEDULE AS A SHEET FOR THE OFFICE — a week or a month,
// every call with its hour, its customer, its branch and its patch. Built as a
// PURE FUNCTION of the data so it can be tested without a printer: it takes
// what it is given and returns a whole HTML document.
//
// Fixed posts are expanded here from the posts themselves rather than from the
// diary, because a post is NOT a visit and never appears in it — and an
// engineer standing at a factory all day whose sheet says "no work" would be
// worse than useless.
// o.heading  — what the sheet calls itself (the Calendar's own wording by
//              default; the dispatch board names itself instead).
// o.note     — a line under the dates saying what was filtered.
// o.compact  — run the engineers on from one another instead of starting each
//              on a fresh page. A month is handed out a man at a time, so it
//              wants the page break; ONE DAY for the whole crew does not, or
//              twenty-five sheets come out of the printer for one morning.
// WHICH POSTS A MAN STANDS ON A GIVEN DAY. A fixed post is not a visit and is
// nowhere in the diary, so both the printed sheet and the downloaded table have
// to work it out from the post itself: is it live on that date, and is he its
// primary or its relief on that weekday?
function postsForDay(posts, agentId, iso) {
  const w = (new Date(iso + "T00:00:00").getDay() + 6) % 7;   // Mon=0
  return (posts || []).filter(p => {
    if (!p.active) return false;
    if (p.start_date && iso < p.start_date) return false;
    if (p.end_date && iso > p.end_date) return false;
    return (String(p.primary_agent_id) === String(agentId) && (p.primary_weekdays || []).includes(w))
        || (String(p.relief_agent_id) === String(agentId) && (p.relief_weekdays || []).includes(w));
  });
}

function scheduleDocHtml(o) {
  const ar = LANG === "ar";
  const S = SETTINGS || {};
  const days = [];
  for (let d = new Date(o.from + "T00:00:00"); ymd(d) <= o.to; d.setDate(d.getDate() + 1)) {
    days.push(ymd(new Date(d)));
  }
  const mins = (v) => {
    const a = (v.scheduled_start || ""), b = (v.scheduled_end || "");
    if (!a || !b) return 0;
    return Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
  };
  const postsFor = (agentId, iso) => postsForDay(o.posts, agentId, iso);
  const sections = (o.agents || []).map(a => {
    const mine = (o.visits || []).filter(v => String(v.agent_id || "") === String(a.id));
    let totalV = 0, totalM = 0, worked = 0;
    const rows = days.map(iso => {
      const posts = postsFor(a.id, iso);
      const list = mine.filter(v => (v.scheduled_start || "").slice(0, 10) === iso)
        .sort((x, y) => String(x.scheduled_start).localeCompare(String(y.scheduled_start)));
      if (!posts.length && !list.length) return "";
      worked += 1; totalV += list.length;
      list.forEach(v => { totalM += mins(v); });
      const d = new Date(iso + "T00:00:00");
      const head = `${t("wd_" + dgWd(iso))} ${fmtDate(iso)}`;
      const postRows = posts.map(p => `<tr class="pr">
          <td class="tm">${esc(p.from_time)}–${esc(p.to_time)}</td>
          <td colspan="2"><strong>${esc(p.site_name)}</strong>
            <span class="tag">${t("fixed_post")}</span></td>
          <td class="cl">${esc(p.client_en || "")}</td></tr>`).join("");
      const visitRows = list.map(v => `<tr>
          <td class="tm">${esc((v.scheduled_start || "").slice(11, 16))}${
            v.scheduled_end ? `–${esc((v.scheduled_end || "").slice(11, 16))}` : ""}</td>
          <td>${esc(localized(v, "client") || "")}</td>
          <td>${esc(v.site_name || v.location || "")}</td>
          <td>${esc(localized(v, "area") || "")}</td></tr>`).join("");
      return `<tr class="dh"><td colspan="4">${esc(head)}
          <span class="n">${list.length} ${t("visits_lc")}${
            posts.length ? ` · ${posts.length} ${t("fixed_post")}` : ""}</span></td></tr>
        ${postRows}${visitRows}`;
    }).join("");
    if (!rows) {
      return `<section><h2>${esc(a.full_name)}</h2>
        <p class="none">${t("none")}</p></section>`;
    }
    return `<section><h2>${esc(a.full_name)}</h2>
      <p class="sum">${totalV} ${t("visits_lc")} · ${worked} ${t("days_lc")} · ${
        hoursMins(totalM)}</p>
      <table><thead><tr><th class="tm">${t("time")}</th><th>${t("customer")}</th>
        <th>${t("location")}</th><th>${t("area")}</th></tr></thead>
        <tbody>${rows}</tbody></table></section>`;
  }).join("");
  return `<!doctype html><html dir="${ar ? "rtl" : "ltr"}"><head><meta charset="utf-8">
    <title>${esc(o.title || o.heading || t("cal_schedule_pdf"))}</title><style>
    @page { size: A4; margin: 14mm 12mm; }
    body { font: 12px/1.45 -apple-system, "Segoe UI", Tahoma, sans-serif; color: #111; margin: 0; }
    header { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 14px; }
    header h1 { margin: 0; font-size: 17px; letter-spacing: -.01em; }
    header .meta { color: #555; font-size: 11.5px; margin-top: 3px; }
    section { break-inside: auto; margin-bottom: 18px; }
    ${o.compact ? "section + section { margin-top: 14px; }"
                : "section + section { break-before: page; }"}
    section h2 { font-size: 14px; margin: 0 0 2px; }
    .sum { color: #555; font-size: 11.5px; margin: 0 0 8px; }
    .none { color: #777; font-style: italic; }
    table { width: 100%; border-collapse: collapse; }
    thead { display: table-header-group; }
    th { text-align: ${ar ? "right" : "left"}; font-size: 10.5px; text-transform: uppercase;
         letter-spacing: .05em; color: #444; border-bottom: 1px solid #999; padding: 4px 6px; }
    td { padding: 4px 6px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
    tr { break-inside: avoid; }
    tr.dh td { background: #f0f2f3; font-weight: 600; border-top: 1px solid #bbb;
               padding-top: 6px; }
    tr.dh .n { float: ${ar ? "left" : "right"}; font-weight: 400; color: #555; font-size: 11px; }
    tr.pr td { background: #fbfbe8; }
    .tag { border: 1px solid #999; border-radius: 3px; padding: 0 4px; font-size: 10px;
           margin-${ar ? "right" : "left"}: 6px; }
    /* An hour range is one LTR run even on an Arabic sheet — mirrored, 08:00
       to 09:30 prints as 09:30–08:00, a visit that ends before it starts. */
    td.tm, th.tm { white-space: nowrap; font-variant-numeric: tabular-nums;
           direction: ltr; unicode-bidi: isolate; text-align: ${ar ? "right" : "left"}; }
    td.cl { white-space: nowrap; }
    footer { margin-top: 10px; color: #777; font-size: 10.5px; }
    </style></head><body onload="window.print()">
    <header><h1>${esc(S.company_name || t("app_name"))} — ${
        esc(o.heading || t("cal_schedule_pdf"))}</h1>
      <div class="meta">${esc(fmtDate(o.from))} → ${esc(fmtDate(o.to))}${
        o.agents && o.agents.length === 1 ? ` · ${esc(o.agents[0].full_name)}` : ""}${
        o.note ? ` · ${esc(o.note)}` : ""}</div>
    </header>${sections}
    <footer>${esc(new Date().toLocaleString())}</footer></body></html>`;
}

async function viewCalendarDay(v, arg) {
  const day = (arg && arg.day) || ymd(new Date());
  const d = new Date(day + "T00:00:00");
  const all = await API.get(`/visits?from=${day}&to=${day}`);
  all.sort((a, b) => String(a.scheduled_start || "").localeCompare(String(b.scheduled_start || "")));
  const dayName = d.toLocaleDateString(LANG === "ar" ? "ar" : "en-GB",
    { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  // Whoever the month was being read for is still who the day is read for.
  const chosen = (arg && arg.agent) ? String(arg.agent) : "";
  const agentFilter = hasAgentList() ? `<select id="cal-agent"><option value="">${t("all")} ${t("nav_agents")}</option>
    ${cache.agents.map(a => `<option value="${a.id}"${String(a.id) === chosen ? " selected" : ""}>${esc(a.full_name)}</option>`).join("")}</select>` : "";
  v.innerHTML = `<div class="page-head"><h2>${t("calendar_title")}</h2><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${calModeSwitch("day")}
      ${agentFilter}
      <button class="btn secondary sm" id="cal-prev">${t("prev")}</button>
      <button class="btn secondary sm" id="cal-next">${t("next")}</button>
      <button class="btn secondary sm" id="cal-today">${t("today")}</button></div></div>
    <div class="panel"><div class="section-title">
        <h3>${esc(dayName)}${day === ymd(new Date()) ? ` · ${t("today")}` : ""}</h3>
        <span class="muted small" id="cal-day-count"></span></div>
      <div id="cal-day-list"></div></div>`;
  wireCalModes(v, day);
  const render = () => {
    const a = $("cal-agent") ? $("cal-agent").value : "";
    const list = a ? all.filter(vi => String(vi.agent_id || "") === a) : all;
    $("cal-day-count").textContent = list.length
      ? `${list.length} ${t(list.length === 1 ? "visit" : "nav_visits")}` : "";
    $("cal-day-list").innerHTML = list.length
      ? visitsTable(list) : `<div class="empty">${t("no_visits_today")}</div>`;
    wireVisitRows($("cal-day-list"));
  };
  render();
  if ($("cal-agent")) $("cal-agent").addEventListener("change", render);
  const picked = () => ($("cal-agent") ? $("cal-agent").value : "");
  const step = (delta) => {
    const nd = new Date(d);
    nd.setDate(d.getDate() + delta);
    navigate("calendar", { mode: "day", day: ymd(nd), agent: picked() || undefined });
  };
  $("cal-prev").addEventListener("click", () => step(-1));
  $("cal-next").addEventListener("click", () => step(1));
  $("cal-today").addEventListener("click", () => navigate("calendar",
    { mode: "day", day: ymd(new Date()), agent: picked() || undefined }));
}

// ====================================================================
// Shifts — the weekly roster. An agent can hold several shifts in a day
// (a short morning and a short evening), each with hand-typed hours.
// ====================================================================
// Saturday that starts the week containing dateStr — the roster week runs
// Saturday–Friday. Date.getDay() is Sun=0 … Sat=6, so Saturday maps to 0.
function weekStartOf(dateStr) {
  const dow = (new Date(dateStr + "T00:00:00").getDay() + 1) % 7;
  return shiftDate(dateStr, -dow);
}

function shiftLabel(s) { return localized(s, "shift_name") || localized(s, "name"); }

// "08:00 – 16:00", or nothing when the shift has no hours (a day off).
function shiftHours(from, to) {
  if (!from && !to) return "";
  return `${from || "—"} – ${to || "—"}`;
}

// Minutes a shift covers, wrapping past midnight the same way the server does.
function shiftMinutes(from, to) {
  const a = hhmmMin(from), b = hhmmMin(to);
  if (a === null || b === null) return 0;
  if (a === b) return 1440;
  return b > a ? b - a : (1440 - a) + b;
}

// "6h" / "6h 30m" — how the roster reports worked time.
function fmtHours(mins) {
  if (!mins) return "0" + t("hours_short");
  const h = Math.floor(mins / 60), m = mins % 60;
  return (h ? h + t("hours_short") : "") + (m ? (h ? " " : "") + m + t("mins_short") : "");
}

async function viewShifts(v, arg) {
  // The bell's "N visits still need a place" carries the run it came from, so
  // opening the notification opens that run's worklist and nothing else.
  if (arg && arg.id) unplacedModal(arg.id);
  const start = (arg && arg.start) ? weekStartOf(arg.start) : weekStartOf(ymd(new Date()));
  const d = await API.get("/shifts/week?start=" + start);
  if (d.areas) cache.areas = d.areas;   // the day editor offers these

  const editable = d.editable && can("shifts.create");
  const today = ymd(new Date());
  // A cell holds every shift that agent works that day, in time order.
  const byCell = {};
  d.shifts.forEach(s => {
    const k = s.agent_id + "|" + s.shift_date;
    (byCell[k] = byCell[k] || []).push(s);
  });

  const dayHead = day => {
    const dt = new Date(day + "T00:00:00");
    const loc = LANG === "ar" ? "ar" : "en-GB";
    return `<th class="${day === today ? "sh-today" : ""}">
      <div>${dt.toLocaleDateString(loc, { weekday: "short" })}</div>
      <div class="muted small">${dt.toLocaleDateString(loc, { day: "numeric", month: "short" })}</div></th>`;
  };

  const cell = (agent, day) => {
    const list = byCell[agent.id + "|" + day] || [];
    const load = d.visit_load[agent.id + "|" + day] || 0;
    const blocks = list.map(s =>
      `<div class="sh-block" title="${esc(s.note || "")}">
        <span class="sh-chip${s.is_off ? " off" : ""}" style="--sh:${esc(s.shift_color)}">${esc(shiftLabel(s))}</span>
        ${shiftHours(s.from_time, s.to_time) ? `<span class="sh-time">${esc(shiftHours(s.from_time, s.to_time))}</span>` : ""}
        ${s.note ? `<span class="sh-note">📝</span>` : ""}</div>`).join("");
    const mins = list.reduce((n, s) => n + (s.is_off ? 0 : shiftMinutes(s.from_time, s.to_time)), 0);
    // Two or more blocks in a day — show what it adds up to.
    const total = list.length > 1 && mins
      ? `<div class="sh-daytotal">${esc(fmtHours(mins))}</div>` : "";
    const inner = list.length ? blocks + total
      : `<span class="sh-empty">${editable ? "＋" : "—"}</span>`;
    // Visits booked on a day with no shift, or only a day off, are worth spotting.
    const working = list.some(s => !s.is_off);
    const clash = load > 0 && !working ? " sh-clash" : "";
    const loadChip = load ? `<span class="sh-load${clash}" title="${esc(t("shift_visits"))}">🗓️ ${load}</span>` : "";
    return `<td class="sh-cell${day === today ? " sh-today" : ""}${editable ? " editable" : ""}"
      data-agent="${agent.id}" data-day="${day}">${inner}${loadChip}</td>`;
  };

  const rows = d.agents.map(a => {
    const week = d.days.map(day => byCell[a.id + "|" + day] || []);
    const working = week.filter(list => list.some(s => !s.is_off)).length;
    const mins = week.reduce((n, list) => n + list.reduce(
      (m, s) => m + (s.is_off ? 0 : shiftMinutes(s.from_time, s.to_time)), 0), 0);
    return `<tr><th class="sh-agent">
        <div><strong>${esc(a.full_name)}</strong></div>
        <div class="muted small">${esc(a.specialization || t("role_" + a.role))}</div>
        ${editable ? `<button class="link-btn sm" data-fill="${a.id}">⚡ ${t("fill_week")}</button>` : ""}
      </th>${d.days.map(day => cell(a, day)).join("")}
      <td class="sh-total"><strong>${working}</strong><div class="muted small">${t("working_days")}</div>
        <div class="sh-weekhours">${esc(fmtHours(mins))}</div></td></tr>`;
  }).join("");

  const legend = d.types.map(ty =>
    `<span class="sh-chip${ty.is_off ? " off" : ""}" style="--sh:${esc(ty.color)}">${esc(shiftLabel(ty))}${
      shiftHours(ty.start_time, ty.end_time) ? ` <span class="sh-time">${esc(shiftHours(ty.start_time, ty.end_time))}</span>` : ""}</span>`).join("");

  const weekLabel = `${fmtDate(d.start)} – ${fmtDate(d.end)}`;
  v.innerHTML = `<div class="page-head"><h2>${t("shifts_title")}</h2>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn secondary sm" id="sh-prev">${t("prev")}</button>
      <strong style="min-width:190px;text-align:center">${weekLabel}</strong>
      <button class="btn secondary sm" id="sh-next">${t("next")}</button>
      <button class="btn secondary sm" id="sh-this">${t("this_week")}</button>
      ${editable ? `<button class="btn sm" id="sh-auto">⚡ ${t("auto_roster")}</button>` : ""}
      ${editable ? `<button class="btn warn sm hidden" id="sh-overasked"></button>` : ""}
      ${editable ? `<button class="btn secondary sm" id="sh-area">📍 ${t("shift_an_area")}</button>` : ""}
      ${editable ? `<button class="btn secondary sm" id="sh-copy">📋 ${t("copy_last_week")}</button>` : ""}
      ${editable && can("visits.delete") ? `<button class="btn secondary sm" id="sh-clear">🧹 ${t("clear_schedule")}</button>` : ""}
      ${can("shifts.edit") ? `<button class="btn secondary sm" id="sh-types">⚙️ ${t("manage_shifts")}</button>` : ""}
    </div></div>
    ${editable ? `<p class="muted small">${t("shifts_hint")}</p>` : ""}
    ${editable ? `<div id="sh-runs"></div>` : ""}
    ${editable ? `<div id="sh-gaps"></div>` : ""}
    <div class="sh-legend">${legend || `<span class="muted small">${t("none")}</span>`}</div>
    <div class="toolbar"><label>${t("view")}:
      <select id="sh-mode">
        <option value="agent">${t("by_engineer")}</option>
        <option value="area" ${_shMode === "area" ? "selected" : ""}>${t("by_area")}</option>
      </select></label></div>
    <div id="sh-grid">${_shMode === "area" ? areaRosterHTML(d, dayHead) : `
    <div class="panel"><table class="sh-table"><thead><tr><th>${t("agent")}</th>
      ${d.days.map(dayHead).join("")}<th>${t("working_days")}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="9" class="empty">${t("no_agents_to_roster")}</td></tr>`}</tbody>
      </table></div>`}</div>`;

  const reload = () => navigate("shifts", { start: d.start });
  $("sh-mode").addEventListener("change", (e) => { _shMode = e.target.value; reload(); });
  $("sh-prev").addEventListener("click", () => navigate("shifts", { start: shiftDate(d.start, -7) }));
  $("sh-next").addEventListener("click", () => navigate("shifts", { start: shiftDate(d.start, 7) }));
  $("sh-this").addEventListener("click", () => navigate("shifts"));
  if ($("sh-auto")) $("sh-auto").addEventListener("click", () => autoRosterModal(d.start, reload));
  // THE BRANCHES THE BOOK ASKS TOO MUCH OF, said before the button is pressed.
  // These do not need a plan to be found — the arithmetic is known from the
  // branch's own record — so the count is fetched with the page and the chip
  // only appears when there is something to fix. Silence means everything fits.
  if ($("sh-overasked")) {
    const month = String(d.start || "").slice(0, 7) || new Date().toISOString().slice(0, 7);
    const first = `${month}-01`;
    const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0);
    const lastISO = `${month}-${String(last.getDate()).padStart(2, "0")}`;
    API.get(`/shifts/auto/over-asked?from=${first}&to=${lastISO}`).then(res => {
      const n = ((res || {}).rows || []).length;
      const el = $("sh-overasked");
      if (!el || !n) return;                       // nothing wrong: say nothing
      el.textContent = `⚠️ ${t("oa_chip").replace("{n}", n)}`;
      el.classList.remove("hidden");
      el.addEventListener("click", () => overAskedModal(first, lastISO));
    }).catch(() => { /* a screen that cannot ask is not a screen that shouts */ });
  }
  if ($("sh-runs")) loadRosterRuns(reload);
  if ($("sh-gaps")) loadServiceGaps(reload);
  if ($("sh-area")) $("sh-area").addEventListener("click", () =>
    areaShiftModal(d.agents, d.days, d.types, d.shifts, reload));
  if ($("sh-copy")) $("sh-copy").addEventListener("click", () => copyLastWeek(d.start, reload));
  if ($("sh-clear")) $("sh-clear").addEventListener("click", () => clearScheduleModal(d.start, d.agents, reload));
  if ($("sh-types")) $("sh-types").addEventListener("click", () => shiftTypesModal(reload));
  if (editable && _shMode === "area") {
    // Clicking an area's day opens the same roster dialog, with that area and
    // that day already chosen — the fastest path from "nobody covers Maadi on
    // Tuesday" to fixing it.
    v.querySelectorAll("[data-arearow]").forEach(c => c.addEventListener("click", () =>
      areaShiftModal(d.agents, d.days, d.types, d.shifts, reload,
                     { area_id: c.dataset.arearow, day: c.dataset.day })));
  }
  if (editable && _shMode !== "area") {
    v.querySelectorAll(".sh-cell").forEach(c => c.addEventListener("click", () => {
      const a = d.agents.find(x => String(x.id) === c.dataset.agent);
      dayShiftsModal(a, c.dataset.day, byCell[c.dataset.agent + "|" + c.dataset.day] || [], d.types, reload);
    }));
    v.querySelectorAll("[data-fill]").forEach(b => b.addEventListener("click", (e) => {
      e.stopPropagation();
      fillWeekModal(d.agents.find(x => String(x.id) === b.dataset.fill), d.days, d.types, reload);
    }));
  }
}

// Everything one agent works on one day. Rows are added and removed freely, and
// every row's hours are typed by hand — picking a shift only prefills them — so
// a two-hour morning plus a four-hour evening is just two rows.
function dayShiftsModal(agent, day, current, types, done) {
  if (!agent) return;
  const typeOpts = types.map(ty =>
    `<option value="${ty.id}">${esc(shiftLabel(ty))}${
      shiftHours(ty.start_time, ty.end_time) ? ` (${esc(shiftHours(ty.start_time, ty.end_time))})` : ""}</option>`).join("");

  const rowHTML = (s) => `<div class="sh-row">
    <select class="sh-r-type">${typeOpts}</select>
    <select class="sh-r-area">${areaOptions(s && s.area_id, t("area_any"))}</select>
    <input type="text" class="sh-r-from hhmm" inputmode="numeric" maxlength="5" placeholder="HH:MM"
      autocomplete="off" value="${esc((s && s.from_time) || "")}">
    <input type="text" class="sh-r-to hhmm" inputmode="numeric" maxlength="5" placeholder="HH:MM"
      autocomplete="off" value="${esc((s && s.to_time) || "")}">
    <input type="text" class="sh-r-note" placeholder="${esc(t("notes"))}" value="${esc((s && s.note) || "")}">
    <span class="sh-r-len muted small"></span>
    <button type="button" class="link-btn danger sm sh-r-del" title="${esc(t("delete"))}">✕</button>
  </div>`;

  // Which shift's hours cover this time — so typing 17:00 lands on Evening.
  const typeForTime = (hhmm) => types.find(ty =>
    !ty.is_off && ty.start_time && ty.end_time && inShiftWindow(hhmm, ty.start_time, ty.end_time));

  openModal(`${t("assign_shift")} — ${agent.full_name} · ${fmtDate(day)}`,
    `<form id="dsf">
      <div class="sh-rows-head"><span>${t("shift_lbl")}</span><span>${t("area")}</span>
        <span>${t("shift_start")}</span>
        <span>${t("shift_end")}</span><span>${t("notes")}</span><span></span><span></span></div>
      <div id="ds-rows">${current.map(rowHTML).join("")}</div>
      <div class="sh-rows-foot">
        <button type="button" class="btn secondary sm" id="ds-add">+ ${t("add_shift")}</button>
        <span id="ds-total" class="sh-daytotal-lg"></span>
      </div>
      <p class="muted small">${t("multi_shift_hint")}</p>
      <div class="form-actions">
        <button type="button" class="btn secondary" id="ds-x">${t("cancel")}</button>
        <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    const rowsBox = $("ds-rows");

    const readRows = () => [...rowsBox.querySelectorAll(".sh-row")].map(r => ({
      shift_type_id: r.querySelector(".sh-r-type").value,
      area_id: r.querySelector(".sh-r-area").value || null,
      start_time: normHHMM(r.querySelector(".sh-r-from").value),
      end_time: normHHMM(r.querySelector(".sh-r-to").value),
      note: r.querySelector(".sh-r-note").value,
    }));

    // Live per-row length and a day total, so a split day is easy to sanity-check.
    const retotal = () => {
      let mins = 0;
      rowsBox.querySelectorAll(".sh-row").forEach(r => {
        const ty = types.find(x => String(x.id) === r.querySelector(".sh-r-type").value);
        const from = normHHMM(r.querySelector(".sh-r-from").value) || (ty && ty.start_time);
        const to = normHHMM(r.querySelector(".sh-r-to").value) || (ty && ty.end_time);
        const m = (ty && ty.is_off) ? 0 : shiftMinutes(from, to);
        r.querySelector(".sh-r-len").textContent = m ? fmtHours(m) : "";
        mins += m;
      });
      $("ds-total").textContent = rowsBox.querySelector(".sh-row")
        ? `${t("day_total")}: ${fmtHours(mins)}` : t("day_cleared");
    };

    const wireRow = (r, s) => {
      const sel = r.querySelector(".sh-r-type");
      const from = r.querySelector(".sh-r-from"), to = r.querySelector(".sh-r-to");
      if (s) {
        sel.value = String(s.shift_type_id);
        if (s.area_id != null) r.querySelector(".sh-r-area").value = String(s.area_id);
      }
      let lastType = types.find(x => String(x.id) === sel.value);
      // Tidy "17" into "17:00" first, so the handlers below see a real time.
      wireTimeInputs(r, retotal);
      // Choosing a shift drops in its standard hours — but never over hours that
      // were typed by hand, only over empty fields or the last shift's defaults.
      sel.addEventListener("change", () => {
        const ty = types.find(x => String(x.id) === sel.value);
        const untouched = (!from.value && !to.value) || (lastType
          && from.value === (lastType.start_time || "") && to.value === (lastType.end_time || ""));
        if (untouched) {
          from.value = (ty && ty.start_time) || "";
          to.value = (ty && ty.end_time) || "";
        }
        lastType = ty;
        retotal();
      });
      // Typing a start time picks the shift it belongs to: enter 17:00 and the
      // row becomes Evening on its own.
      from.addEventListener("change", () => {
        const hhmm = normHHMM(from.value);
        const ty = hhmm && typeForTime(hhmm);
        if (ty && String(ty.id) !== sel.value) { sel.value = String(ty.id); lastType = ty; }
        retotal();
      });
      r.querySelectorAll("input:not(.hhmm)").forEach(i => i.addEventListener("input", retotal));
      r.querySelector(".sh-r-del").addEventListener("click", () => { r.remove(); retotal(); });
    };

    [...rowsBox.querySelectorAll(".sh-row")].forEach((r, i) => wireRow(r, current[i]));
    retotal();

    $("ds-add").addEventListener("click", () => {
      rowsBox.insertAdjacentHTML("beforeend", rowHTML(null));
      const r = rowsBox.lastElementChild;
      wireRow(r, null);
      // A fresh row starts on the first shift with its standard hours filled in.
      r.querySelector(".sh-r-type").dispatchEvent(new Event("change"));
    });
    $("ds-x").addEventListener("click", closeModal);

    root.querySelector("#dsf").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const saved = await API.post("/shifts/day",
          { agent_id: agent.id, date: day, shifts: readRows() });
        if (handledOffline(saved)) return;
        closeModal(); toast(t("saved")); done();
      } catch (err) { alert(err.message); }
    });
  });
}

// ONE BUTTON: plan the roster and the diary together, from the availability
// board and each branch's window and frequency. Always PREVIEWS first — the
// office sees exactly what it is about to agree to, and the same plan is what
// gets written, because the server builds both from one function.
// The last press of the button, and the way back from it. Applying books real
// customer visits in bulk; without this the only way to undo one is to delete
// them by hand, which is enough to stop anybody pressing it at all.
let _lastRosterRun = null;

async function loadRosterRuns(reload) {
  const box = $("sh-runs");
  if (!box) return;
  let runs = [];
  try { runs = await API.get("/shifts/auto/runs"); } catch (e) { box.remove(); return; }
  const open = (runs || []).filter(r => !r.undone_at).slice(0, 3);
  if (!open.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="panel run-strip">
    <strong>${t("recent_plans")}</strong>
    ${open.map(r => `<div class="run-row${r.id === _lastRosterRun ? " run-new" : ""}">
      <span>${esc(fmtDate(r.from_date))} – ${esc(fmtDate(r.to_date))}
        <span class="muted small">· ${t("auto_done")
          .replace("{v}", (r.visits || 0) + (r.assigned || 0)).replace("{s}", r.shifts || 0)}${
          r.created_name ? ` · ${esc(r.created_name)}` : ""}</span></span>
      ${r.unplaced ? `<button class="btn warn sm" data-unplaced="${r.id}">⚠️ ${
        t("up_chip").replace("{n}", r.unplaced)}</button>` : ""}
      <button class="btn secondary sm" data-undorun="${r.id}">↩︎ ${t("undo_plan")}</button>
    </div>`).join("")}</div>`;
  box.querySelectorAll("[data-unplaced]").forEach(b =>
    b.addEventListener("click", () => unplacedModal(b.dataset.unplaced)));
  box.querySelectorAll("[data-undorun]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("undo_plan_confirm"))) return;
    try {
      const res = await API.post(`/shifts/auto/runs/${b.dataset.undorun}/undo`, {});
      if (handledOffline(res)) return;
      // "kept" is work the field had already started — say so plainly rather
      // than letting the office think the undo missed something.
      toast(res.kept
        ? t("undo_done_kept").replace("{v}", res.visits + res.assigned).replace("{k}", res.kept)
        : t("undo_done").replace("{v}", res.visits + res.assigned));
      if (String(_lastRosterRun) === String(b.dataset.undorun)) _lastRosterRun = null;
      reload();
    } catch (err) { alert(err.message); }
  }));
}

// MISSING OWED VISITS. The office's scenario, in their own words: the roster
// applies the month, somebody deletes one future visit from the diary by hand,
// and nobody presses the button again. Nothing anywhere used to change — the
// branch was simply a visit short and no screen said so.
//
// This says so, and does nothing else. It never re-runs the planner, never
// creates a replacement and never touches a frequency. Like the unplaced
// worklist, a line clears itself the moment the visit is back on the book —
// booked here, booked anywhere else, or restored by the next Auto Roster.
let _gapCache = null;

const gapLine = (r) => (r.missing > 1
  ? t("gap_lines").replace("{n}", r.missing)
  : t("gap_line")).replace("{a}", r.scheduled).replace("{b}", r.owed);

// "September 2026" — the month a shortfall is in, in the reader's language.
function gapMonthLabel(key) {
  const [y, m] = String(key || "").split("-").map(Number);
  if (!y || !m) return key || "";
  return new Date(y, m - 1, 1).toLocaleDateString(LANG === "ar" ? "ar" : "en-GB",
    { month: "long", year: "numeric" });
}

async function loadServiceGaps(reload) {
  const box = $("sh-gaps");
  if (!box) return;
  let d;
  try { d = await API.get("/service-gaps"); } catch (e) { box.remove(); return; }
  _gapCache = d;
  if (!d || !d.missing_visits) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="panel run-strip gap-strip">
    <strong>⚠️ ${t("gap_title")}</strong>
    <span class="muted small">${t("gap_chip").replace("{n}", d.missing_visits)}</span>
    <button class="btn warn sm" id="sh-gaps-open">${t("view")}</button></div>`;
  $("sh-gaps-open").addEventListener("click", () => serviceGapModal(reload));
}

// The first date in the month worth offering when booking one by hand: never
// yesterday, and otherwise the middle of the month, where the round is.
function gapDefaultDate(monthKey) {
  const [y, m] = String(monthKey || "").split("-").map(Number);
  if (!y || !m) return "";
  const today = new Date();
  const mid = new Date(y, m - 1, 15);
  const soonest = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const pick = mid < soonest && soonest.getMonth() === m - 1 ? soonest : mid;
  return `${pick.getFullYear()}-${String(pick.getMonth() + 1).padStart(2, "0")}-${
    String(pick.getDate()).padStart(2, "0")}`;
}

async function serviceGapModal(after) {
  let d;
  try { d = await API.get("/service-gaps"); } catch (e) { alert(e.message); return; }
  _gapCache = d;
  const items = (d && d.items) || [];
  if (!items.length) { toast(t("gap_none")); return; }
  // Grouped by the month they are short in — a branch can be behind in more
  // than one, and "3 of 4" means nothing without saying which month.
  const byMonth = {};
  items.forEach(r => { (byMonth[r.month] = byMonth[r.month] || []).push(r); });
  const rowHTML = (r) => `<div class="up-row" data-gap="${r.site_id}">
      <div class="up-what">
        <span class="up-branch">${esc(r.site_name || "—")}</span>
        <span class="muted small">${esc(localized(r, "client"))}${
          r.area_en ? ` · ${esc(localized({ name_en: r.area_en, name_ar: r.area_ar }, "name"))}` : ""}</span>
        <span class="gap-count">${esc(gapLine(r))}</span>
      </div>
      <div class="up-act">${can("visits.create")
        ? `<button class="btn sm" data-gapbook="${r.site_id}" data-month="${r.month}"
             >${t("gap_book")}</button>` : ""}</div>
    </div>`;
  openModal(t("gap_title"),
    `<p class="muted small">${t("gap_hint")}</p>
     ${Object.keys(byMonth).sort().map(mk => `<div class="up-group">
        <div class="up-why">${esc(gapMonthLabel(mk))}</div>
        ${byMonth[mk].map(rowHTML).join("")}</div>`).join("")}
     <div class="form-actions"><button class="btn secondary" id="gap-x">${t("close")}</button></div>`,
    (root) => {
      $("gap-x").addEventListener("click", closeModal);
      // Booking one opens the ordinary visit form with the branch, the customer
      // and a date inside the month it is short in already filled in. The
      // office chooses who and when; nothing is created on their behalf.
      root.querySelectorAll("[data-gapbook]").forEach(b => b.addEventListener("click", () => {
        const r = items.find(x => String(x.site_id) === b.dataset.gapbook
                                  && x.month === b.dataset.month);
        if (!r) return;
        visitForm({ client_id: r.client_id, site_id: r.site_id,
                    scheduled_start: `${gapDefaultDate(r.month)}T09:00` },
                  { after: () => { serviceGapModal(after); if (after) after(); } });
      }));
    });
}

// THE LEFTOVERS, AS A WORKLIST. The office's own instruction: apply everything
// that fits, then hand back what did not so they can place it by hand. A line
// clears itself the moment a visit exists for that branch on that date, so
// booking one here (or anywhere else in the CRM) is all it takes — there is
// nothing to remember to tick. Dismiss is for the other case: the visit was
// not needed, or the branch's own details were fixed for next time.
// ====================================================================
// THE BRANCHES THE BOOK ASKS TOO MUCH OF
// ====================================================================
// His request (2026-09-06): "i want to make me view that branches ... and
// ofcourse to see the branches that wants more visits to fix it manual."
//
// The planner has always worked this out before it plans and printed it as a
// sentence in the plan preview. A sentence cannot be acted on: you cannot open
// the branch from it, and it is gone the moment the dialog closes. Here it is a
// list, reachable from the Shifts page at any time, with the numbers spelled
// out and the branch one press away — because every one of these is fixed in
// the branch's own record and nowhere else.
// Python weekday order: Monday is 0, which is what the roster stores.
const OA_DAYS = ["wd_mon", "wd_tue", "wd_wed", "wd_thu", "wd_fri", "wd_sat", "wd_sun"];
function oaWhy(r) {
  if (r.kind === "no_day") return t("oa_kind_no_day");
  if (r.kind === "window") {
    return t(r.overnight ? "oa_kind_window_night" : "oa_kind_window")
      .replace("{w}", r.window_minutes).replace("{m}", r.needs_minutes);
  }
  return t("oa_kind_days").replace("{asked}", r.asked).replace("{n}", r.possible);
}
function oaFix(r) {
  if (r.kind === "no_day") return t("oa_fix_nobody");
  if (r.kind === "window") return t("oa_fix_window").replace("{m}", r.window_minutes);
  return t("oa_fix_number").replace("{n}", r.fits);
}
function oaRowHTML(r) {
  const served = (r.served_on || []).map(d => t(OA_DAYS[d])).join(", ");
  return `<div class="oa-row">
    <div class="oa-head">
      <strong>${esc(r.site_name || "—")}</strong>
      <span class="muted small">${esc(localized(r, "client"))}${
        r.area_en ? ` · ${esc(localized({ name_en: r.area_en, name_ar: r.area_ar }, "name"))}` : ""}</span>
    </div>
    <div class="oa-why">${esc(oaWhy(r))}</div>
    <div class="oa-fix">${esc(oaFix(r))}</div>
    <div class="muted small">${
      (r.engineers || []).length ? esc(t("oa_engineers").replace("{e}", r.engineers.join(", ")))
                                 : esc(t("oa_nobody_allowed"))}${
      served ? ` · ${esc(t("oa_served_on").replace("{d}", served))}` : ""}</div>
    <div class="oa-act">
      <button class="btn sm" data-oaopen="${r.site_id}" data-client="${r.client_id}">${t("oa_open_branch")}</button>
    </div></div>`;
}
// Opened from the Shifts page, and from the plan preview's own warning. `after`
// brings the list back once a branch has been edited, so the row he just fixed
// disappears in front of him — which is the whole point of the screen.
async function overAskedModal(from, to) {
  let d;
  try { d = await API.get(`/shifts/auto/over-asked?from=${from}&to=${to}`); }
  catch (e) { alert(e.message); return; }
  const rows = d.rows || [];
  openModal(`${t("oa_title")} · ${esc(fmtDate(d.from))} – ${esc(fmtDate(d.to))}`,
    `<p class="muted small">${rows.length ? t("oa_hint") : t("oa_none")}</p>
     ${rows.map(oaRowHTML).join("")}
     <div class="form-actions"><button class="btn secondary" id="oa-x">${t("close")}</button></div>`,
    (root) => {
      $("oa-x").addEventListener("click", closeModal);
      // FIXED BY HAND, IN THE BRANCH'S OWN FORM. Nothing on this screen edits
      // the branch itself: the numbers here are the office's own data, and a
      // screen that quietly rewrote a customer's agreed frequency would be
      // deciding something it has no business deciding.
      root.querySelectorAll("[data-oaopen]").forEach(b => b.addEventListener("click", async () => {
        const r = rows.find(x => String(x.site_id) === b.dataset.oaopen);
        // The branch form wants the branch's whole record, and there is no
        // single-branch GET — the Locations board reads the same list, so this
        // reads it the same way rather than adding a route for one screen.
        let site = null;
        try {
          const all = await API.get("/sites");
          const list = Array.isArray(all) ? all : (all.items || []);
          site = list.find(x => x.id === r.site_id);
        } catch (e) { /* fall through to the message below */ }
        if (!site) { toast(t("none")); return; }
        siteForm(r.client_id, site, () => overAskedModal(from, to));
      }));
    });
}

// ====================================================================
// WHO CAN TAKE THIS VISIT
// ====================================================================
// The office's own words (2026-09-06): "it tells me the numbers of ... the
// branches that not assigned in schedule but i want to click it and see it and
// write what the issue and recommend the nearst engineer free can have that
// visit and if he had a visit before and after and where."
//
// So every branch the plan could not book is a BUTTON, in both places it is
// named — the preview after pressing the button, and the worklist of what is
// still waiting. It opens the same panel: who could go, at what time, and what
// he has either side of that gap and where. The server works it out from the
// planner's own book (who-can-take in server.py); nothing here decides
// anything, and nothing is written until the office presses Book.
function wctPlace(x, key) {
  if (!x) return `<div class="wct-side muted">${t(key === "before" ? "wct_nothing_before" : "wct_nothing_after")}</div>`;
  const km = x.km == null ? "" : ` <span class="wct-km">${t("wct_km").replace("{n}", x.km)}</span>`;
  return `<div class="wct-side">${t(key === "before" ? "wct_before" : "wct_after")
    .replace("{t}", `${esc(x.start)}–${esc(x.end)}`)
    .replace("{b}", esc(x.site_name || "—"))}${km}</div>`;
}
function wctHTML(d, canBook) {
  if (d.shut) return `<div class="wct-note warn-line">${t("wct_shut")}</div>`;
  const fits = d.fits || [], blocked = d.blocked || [];
  const men = fits.map(f => `<div class="wct-man">
      <div class="wct-head">
        <strong>${esc(f.agent_name)}</strong>
        <span class="wct-why">${t("wct_why_" + f.why)}</span>
        ${f.km != null ? `<span class="wct-km">${t("wct_km").replace("{n}", f.km)}</span>` : ""}
      </div>
      <div class="wct-slot">${t("wct_suggest")
        .replace("{a}", esc(f.gap_from)).replace("{b}", esc(f.gap_to))
        .replace("{s}", `${esc(f.suggested_start)}–${esc(f.suggested_end)}`)}</div>
      ${wctPlace(f.before, "before")}
      ${wctPlace(f.after, "after")}
      <div class="muted small">${f.visits_that_day
        ? t("wct_day_load").replace("{n}", f.visits_that_day) : t("wct_day_empty")}</div>
      ${canBook ? `<div class="wct-act">
        <button class="btn sm" data-wctaccept="${f.agent_id}"
          data-start="${esc(f.suggested_start)}">${t("wct_accept")}</button>
        <button class="btn secondary sm" data-wctbook="${f.agent_id}"
          data-start="${esc(f.suggested_start)}">${t("wct_change")}</button></div>` : ""}
    </div>`).join("");
  // WHY THE OTHERS CANNOT is the half he asked for in the same breath — "write
  // what the issue". Folded away when somebody CAN go, because then it is
  // background; open by itself when nobody can, because then it is the answer.
  const why = blocked.map(b => `<div class="wct-no">
      <span>${esc(b.agent_name)}</span>
      <span class="muted small">${t("wct_" + b.why)
        .replace("{n}", b.visits_that_day == null ? "" : b.visits_that_day)
        .replace("{s}", t(d.site.shift === "night" ? "shift_night" : "shift_day"))}</span>
    </div>`).join("");
  return `${fits.length ? `<div class="wct-men">${men}</div>`
                        : `<div class="wct-note warn-line">${t("wct_none")}</div>`}
    ${blocked.length ? `<details class="wct-blocked"${fits.length ? "" : " open"}>
       <summary>${t("wct_blocked").replace("{n}", blocked.length)}</summary>${why}</details>` : ""}`;
}
// Load the answer into an element that is already on the screen. `after` is
// called with the chosen engineer when the office presses Book, so the two
// callers can each do the right thing with it.
async function wctLoad(el, siteId, date, onBook) {
  if (!date) { el.innerHTML = `<div class="wct-note muted">${t("wct_no_date")}</div>`; return; }
  el.innerHTML = `<div class="muted small">${t("wct_thinking")}</div>`;
  let d;
  try { d = await API.post("/shifts/auto/who-can-take", { site_id: siteId, date }); }
  catch (e) { el.innerHTML = `<div class="wct-note warn-line">${esc(e.message)}</div>`; return; }
  el.innerHTML = wctHTML(d, !!onBook && can("visits.create"));
  // ACCEPT takes the recommendation as it stands and books it. CHANGE opens the
  // ordinary visit form with it filled in, so the time or the man can be
  // altered first — and pressing Accept beside a DIFFERENT engineer is itself
  // changing who goes, which is how he asked for it: "let me accept or change
  // the engineer you recomend".
  el.querySelectorAll("[data-wctaccept]").forEach(b => b.addEventListener("click",
    () => onBook(d, Number(b.dataset.wctaccept), b.dataset.start, "accept")));
  el.querySelectorAll("[data-wctbook]").forEach(b => b.addEventListener("click",
    () => onBook(d, Number(b.dataset.wctbook), b.dataset.start, "change")));
}
// OPENED IN PLACE, NEVER AS A SECOND DIALOG. The plan preview is itself a
// modal, and this app has one: a dialog on top of it would REPLACE the plan the
// office is reading, and closing it would leave them with nothing. So the answer
// unfolds under the branch that was pressed, and pressing it again folds it away.
function wctToggle(btn, host, onBook) {
  const id = btn.dataset.wct || btn.dataset.who;
  let box = host.querySelector(".up-who");
  if (box && box.dataset.for === id) { box.remove(); return false; }
  if (!box) { box = document.createElement("div"); box.className = "up-who"; host.appendChild(box); }
  box.dataset.for = id;
  wctLoad(box, Number(id), btn.dataset.date, onBook);
  return true;
}

async function unplacedModal(runId) {
  let d;
  try { d = await API.get(`/shifts/auto/runs/${runId}/unplaced`); }
  catch (e) { alert(e.message); return; }
  const items = d.items || [];
  if (!items.length) { toast(t("up_none")); return; }
  const order = ["no_engineer", "nobody_working", "window_too_short", "not_reached",
                 "window_taken", "day_full", "agent_off", "agent_busy"];
  const byReason = {};
  items.forEach(u => { (byReason[u.reason] = byReason[u.reason] || []).push(u); });
  const groups = order.filter(r => byReason[r]).concat(
    Object.keys(byReason).filter(r => !order.includes(r)));

  const rowHTML = (u) => {
    const done = u.booked || u.dismissed_at;
    return `<div class="up-row${done ? " up-done" : ""}" data-up="${u.id}">
      <div class="up-when">${esc(fmtDate(u.visit_date))}</div>
      <div class="up-what">
        <span class="up-branch">${esc(u.site_name || "—")}</span>
        <span class="muted small">${esc(localized(u, "client"))}${
          u.area_en ? ` · ${esc(localized({ name_en: u.area_en, name_ar: u.area_ar }, "name"))}` : ""}${
          u.minutes ? ` · ${hoursMins(u.minutes)}` : ""}</span>
      </div>
      <div class="up-act">${
        u.booked ? `<span class="up-tag ok">✓ ${t("up_booked")}</span>`
        : u.dismissed_at ? `<span class="up-tag">${t("up_dismissed")}</span>
            <button class="link-btn sm" data-undismiss="${u.id}">${t("up_restore")}</button>`
        : `${can("visits.create") ? `<button class="btn sm" data-book="${u.id}">${t("up_book")}</button>` : ""}
           <button class="btn secondary sm" data-who="${u.id}">${t("wct_open")}</button>
           <button class="btn secondary sm" data-dismiss="${u.id}">${t("up_dismiss")}</button>`}</div>
    </div>
    ${done ? "" : `<div class="up-who hidden" data-whobox="${u.id}"></div>`}`;
  };

  openModal(`${t("up_title")} · ${esc(fmtDate(d.run.from_date))} – ${esc(fmtDate(d.run.to_date))}`,
    `<p class="muted small">${t("up_hint").replace("{n}", d.open)}</p>
     ${groups.map(r => `<div class="up-group">
        <div class="up-why">${t("reason_" + r)}</div>
        ${byReason[r].map(rowHTML).join("")}</div>`).join("")}
     <div class="form-actions"><button class="btn secondary" id="up-x">${t("close")}</button></div>`,
    (root) => {
      $("up-x").addEventListener("click", closeModal);
      // Booking one opens the ordinary visit form with the branch, the customer
      // and the date it was due already filled in — the office only chooses who
      // and when. Saving it brings the list straight back, one line shorter.
      root.querySelectorAll("[data-book]").forEach(b => b.addEventListener("click", () => {
        const u = items.find(x => String(x.id) === b.dataset.book);
        visitForm({ client_id: u.client_id, site_id: u.site_id,
                    scheduled_start: `${u.visit_date}T09:00` },
                  { after: () => unplacedModal(runId) });
      }));
      const mark = async (id, undo) => {
        try {
          const res = await API.post(`/shifts/auto/unplaced/${id}/dismiss`, undo ? { undo: true } : {});
          if (handledOffline(res)) return;
          unplacedModal(runId);
        } catch (err) { alert(err.message); }
      };
      // WHO COULD GO INSTEAD, opened under the line it is about rather than in
      // a dialog on top of a dialog — the office is comparing several of these
      // against each other, and a modal would hide the list they are reading.
      root.querySelectorAll("[data-who]").forEach(b => b.addEventListener("click", () => {
        const u = items.find(x => String(x.id) === b.dataset.who);
        const box = root.querySelector(`[data-whobox="${b.dataset.who}"]`);
        if (!box) return;
        if (!box.classList.contains("hidden")) {
          box.classList.add("hidden"); b.textContent = t("wct_open"); return;
        }
        box.classList.remove("hidden");
        b.textContent = t("wct_hide");
        wctLoad(box, u.site_id, u.visit_date, async (d, agentId, start, mode) => {
          const when = `${u.visit_date}T${start}`;
          if (mode !== "accept") {
            visitForm({ client_id: u.client_id, site_id: u.site_id, agent_id: agentId,
                        scheduled_start: when },
                      { after: () => unplacedModal(runId) });
            return;
          }
          // One press books it, at the time and the length the answer offered —
          // and through the same clash check the visit form uses, so accepting
          // a recommendation can never quietly double-book somebody.
          const fit = (d.fits || []).find(f => f.agent_id === agentId) || {};
          try {
            const saved = await postVisitWithConflictCheck({
              client_id: u.client_id, site_id: u.site_id, agent_id: agentId,
              scheduled_start: `${when}:00`,
              // The end the answer offered, not a default: the branch's own
              // visit length is what made the gap fit in the first place.
              scheduled_end: fit.suggested_end
                ? `${u.visit_date}T${fit.suggested_end}:00` : undefined,
            });
            if (!saved) return;                     // he answered no to the clash
            if (handledOffline(saved)) return;
            toast(t("wct_booked").replace("{a}", fit.agent_name || "")
                                 .replace("{t}", start));
            unplacedModal(runId);
          } catch (err) { alert(err.message); }
        });
      }));
      root.querySelectorAll("[data-dismiss]").forEach(b =>
        b.addEventListener("click", () => mark(b.dataset.dismiss, false)));
      root.querySelectorAll("[data-undismiss]").forEach(b =>
        b.addEventListener("click", () => mark(b.dataset.undismiss, true)));
    });
}

// THE BOARD, WIPED CLEAN. The office's own request: "a button with a filter to
// delete all the shifts and schedules — by client and location, or engineer, or
// a specific day — or delete all of them, to design it again."
//
// It NEVER deletes on the first press. Preview, read the counts, then confirm:
// this is the one screen in the app that can take a month of work off the book,
// and it must not be able to surprise anyone. What has already happened — a
// visit done, started, or checked into — is not deletable at all; the server
// holds those back and the preview names them.
function clearScheduleModal(weekStart, agents, done) {
  const areaOpts = [{ v: "", l: t("all_areas") }].concat(
    (cache.areas || []).filter(a => a.active !== 0).map(a => ({ v: a.id, l: areaLabel(a) })));
  const agentOpts = [{ v: "", l: t("clear_any_engineer") }].concat(
    (agents || []).map(a => ({ v: a.id, l: a.full_name })));
  const clientOpts = [{ v: "", l: t("clear_any_client") }].concat(
    (cache.clients || []).map(c => ({ v: c.id, l: clientLabel(c) })));
  openModal(`🧹 ${t("clear_schedule")}`, `<form id="clf">
    <p class="muted small">${t("clear_hint")}</p>
    <div class="form-grid">
      ${field(t("from"), "from", { type: "date", value: weekStart })}
      ${field(t("to"), "to", { type: "date", value: shiftDate(weekStart, 6) })}
    </div>
    <div class="form-actions" style="justify-content:flex-start;flex-wrap:wrap">
      <button type="button" class="btn secondary sm" data-cspan="day">${t("span_day")}</button>
      <button type="button" class="btn secondary sm" data-cspan="week">${t("span_week")}</button>
      <button type="button" class="btn secondary sm" data-cspan="month">${t("span_month")}</button>
    </div>
    <div class="form-grid">
      ${field(t("engineer"), "agent_id", { options: agentOpts })}
      ${field(t("nav_areas"), "area_id", { options: areaOpts })}
      ${field(t("client"), "client_id", { options: clientOpts, cls: "full" })}
      ${field(t("location_lbl"), "site_id", { options: [{ v: "", l: t("clear_any_site") }], cls: "full" })}
      ${field(t("clear_what"), "what", { options: [
        { v: "both", l: t("clear_both") }, { v: "visits", l: t("clear_visits_only") },
        { v: "shifts", l: t("clear_shifts_only") }], cls: "full" })}
    </div>
    <label class="opt-pick"><input type="checkbox" name="include_off">
      <span>${t("clear_include_off")}</span></label>
    ${can("schedule.clear_all") ? `<label class="opt-pick danger-pick">
      <input type="checkbox" name="everything">
      <span>⚠️ ${t("clear_everything")}</span></label>` : ""}
    <div id="cl-out"></div>
    <div class="form-actions"><button type="button" class="btn secondary" id="clf-x">${t("cancel")}</button>
      <button class="btn" type="submit" id="clf-go">${t("clear_preview")}</button>
      <button type="button" class="btn danger" id="clf-do" style="display:none">${t("clear_go")}</button>
    </div></form>`, (root) => {
    $("clf-x").addEventListener("click", closeModal);
    const el = (n) => root.querySelector(`[name=${n}]`);
    const fromEl = el("from"), toEl = el("to");
    const forget = () => { $("cl-out").innerHTML = ""; $("clf-do").style.display = "none"; };
    root.querySelectorAll("[data-cspan]").forEach(b => b.addEventListener("click", () => {
      const span = b.dataset.cspan;
      if (!fromEl.value) fromEl.value = weekStart;
      toEl.value = span === "day" ? fromEl.value
        : span === "week" ? shiftDate(fromEl.value, 6) : shiftDate(fromEl.value, 29);
      forget();
    }));
    // THE WHOLE BOOK IS A DIFFERENT REQUEST, and it looks like one: the dates
    // stop meaning anything and the button turns into a warning. It used to be
    // a small grey button called "Every date" sitting beside Day/Week/Month,
    // one click from Month and reading almost the same in the confirm box.
    const everyEl = el("everything");
    const paintScope = () => {
      const whole = !!(everyEl && everyEl.checked);
      fromEl.disabled = toEl.disabled = whole;
      root.querySelectorAll("[data-cspan]").forEach(b => b.disabled = whole);
      $("clf-do").classList.toggle("danger", true);
      forget();
    };
    if (everyEl) everyEl.addEventListener("change", paintScope);
    // Picking a customer narrows the branch list, exactly as it does when
    // booking a visit — the same two fields, the same behaviour.
    const siteSel = el("site_id");
    el("client_id").addEventListener("change", () => {
      const cid = el("client_id").value;
      if (cid) loadSiteOptions(cid, siteSel);
      else siteSel.innerHTML = `<option value="">${esc(t("clear_any_site"))}</option>`;
      forget();
    });
    root.querySelectorAll("select, input").forEach(x => x.addEventListener("change", forget));

    const body = () => {
      const whole = !!(everyEl && everyEl.checked);
      const b = { from: whole ? "" : (fromEl.value || ""),
                  to: whole ? "" : (toEl.value || ""),
                  agent_id: el("agent_id").value, area_id: el("area_id").value,
                  client_id: el("client_id").value, site_id: siteSel.value,
                  what: el("what").value, include_off: el("include_off").checked,
                  scope: whole ? "everything" : "range" };
      // NOTHING IS INFERRED HERE ANY MORE. This used to set an `all` flag on
      // your behalf the moment the date boxes happened to be empty, which is
      // how a whole applied month came off the book in one press: the server's
      // "say it out loud" gate was being said out loud by the browser.
      return b;
    };
    let pending = null;
    root.querySelector("#clf").addEventListener("submit", async (e) => {
      e.preventDefault();
      $("cl-out").innerHTML = `<div class="muted">${t("loading")}</div>`;
      try {
        const r = await API.post("/schedule/clear", body());
        pending = r;
        const lines = (r.sample || []).map(x =>
          `<li>${esc(fmtDate(x.d))} · ${esc(x.site_name || "")}${
            x.agent_name ? ` · ${esc(x.agent_name)}` : ""}</li>`).join("");
        const total = (r.visits || 0) + (r.shifts || 0);
        $("cl-out").innerHTML = total
          ? `<div class="panel"><strong>${
              t("clear_result").replace("{v}", r.visits).replace("{s}", r.shifts)}</strong>
             ${r.kept ? `<div class="warn-line">🔒 ${t("clear_kept").replace("{n}", r.kept)}</div>` : ""}
             ${r.shifts_skipped ? `<div class="muted small">${t("clear_shifts_skipped")}</div>` : ""}
             ${lines ? `<ul class="small">${lines}</ul>` : ""}</div>`
          : `<div class="empty">${t("clear_nothing")}${
              r.kept ? ` · 🔒 ${t("clear_kept").replace("{n}", r.kept)}` : ""}</div>`;
        $("clf-do").style.display = total ? "" : "none";
      } catch (err) { $("cl-out").innerHTML = `<div class="empty">⚠️ ${esc(err.message)}</div>`; }
    });
    $("clf-do").addEventListener("click", async () => {
      if (!pending) return;
      // WHAT AND OVER WHICH DATES — both, always. "Delete 848 visit(s)?" read
      // exactly the same for one month as for the entire book.
      const whole = pending.scope === "everything";
      const span = whole ? t("clear_scope_everything")
        : `${fmtDate(pending.range.from)} → ${fmtDate(pending.range.to)}`;
      const msg = t(whole ? "clear_confirm_all" : "clear_confirm")
        .replace("{v}", pending.visits).replace("{s}", pending.shifts)
        .replace("{range}", span);
      if (!confirm(msg)) return;
      // The whole book is never one click. It has to be written out.
      if (whole) {
        const typed = prompt(t("clear_type_everything"));
        if (!typed || typed.trim().toUpperCase() !== "EVERYTHING") {
          toast(t("clear_not_confirmed"));
          return;
        }
      }
      try {
        const r = await API.post("/schedule/clear", {
          ...body(), apply: true,
          // Hand back exactly what was on screen. If the book moved while it
          // was being read, the server refuses rather than deleting more.
          expect_visits: pending.visits, expect_shifts: pending.shifts,
          ...(whole ? { confirm: "EVERYTHING" } : {}) });
        if (handledOffline(r)) return;
        closeModal();
        toast(t("clear_done").replace("{v}", r.visits).replace("{s}", r.shifts));
        done();
      } catch (err) { alert(err.message); }
    });
  });
}


function autoRosterModal(weekStart, done) {
  const to = shiftDate(weekStart, 6);
  openModal(`⚡ ${t("auto_roster")}`, `<form id="arf">
    <p class="muted small">${t("auto_roster_hint")}</p>
    <div class="form-grid">
      ${field(t("from"), "from", { type: "date", value: weekStart })}
      ${field(t("to"), "to", { type: "date", value: to })}
    </div>
    <div class="form-actions" style="justify-content:flex-start;flex-wrap:wrap">
      <button type="button" class="btn secondary sm" data-span="day">${t("span_day")}</button>
      <button type="button" class="btn secondary sm" data-span="week">${t("span_week")}</button>
      <button type="button" class="btn secondary sm" data-span="month">${t("span_month")}</button>
    </div>
    <div id="ar-out"></div>
    <div class="form-actions"><button type="button" class="btn secondary" id="arf-x">${t("cancel")}</button>
      <button class="btn" type="submit" id="arf-go">${t("auto_preview")}</button>
      <button type="button" class="btn" id="arf-apply" style="display:none">${t("auto_apply")}</button>
    </div></form>`, (root) => {
    $("arf-x").addEventListener("click", closeModal);
    const fromEl = root.querySelector("[name=from]");
    const toEl = root.querySelector("[name=to]");
    root.querySelectorAll("[data-span]").forEach(b => b.addEventListener("click", () => {
      const span = b.dataset.span;
      // A MONTH IS THE CALENDAR MONTH — 28, 29, 30 or 31 days. A contract of
      // four a month is four visits in February and four in October; the
      // planner counts on the calendar now, so the button plans to the last
      // day of the month the office picked rather than twenty-eight days on.
      toEl.value = span === "day" ? fromEl.value
        : span === "week" ? shiftDate(fromEl.value, 6) : endOfMonth(fromEl.value);
      $("ar-out").innerHTML = "";
      $("arf-apply").style.display = "none";
    }));
    const range = () => ({ from: fromEl.value, to: toEl.value });
    const preview = async (e) => {
      if (e) e.preventDefault();
      $("ar-out").innerHTML = `<div class="muted">${t("loading")}</div>`;
      try {
        const plan = await API.post("/shifts/auto", range());
        $("ar-out").innerHTML = autoPlanHTML(plan);
        // The branches the plan could not book are buttons — one press says who
        // could take that one and what is in the way. No Book button here: this
        // plan has not been applied yet, and booking a visit from underneath it
        // is the office arguing with a proposal they have not accepted. The
        // worklist AFTER applying is where a visit gets booked.
        $("ar-out").querySelectorAll("[data-wct]").forEach(b => b.addEventListener("click", () => {
          const on = wctToggle(b, b.closest(".un-group"), null);
          b.classList.toggle("open", on);
        }));
        $("arf-apply").style.display = plan.summary.visits ? "" : "none";
      } catch (err) { $("ar-out").innerHTML = `<div class="empty">⚠️ ${esc(err.message)}</div>`; }
    };
    root.querySelector("#arf").addEventListener("submit", preview);
    $("arf-apply").addEventListener("click", async () => {
      if (!confirm(t("auto_apply_confirm"))) return;
      try {
        const res = await API.post("/shifts/auto", { ...range(), apply: true });
        if (handledOffline(res)) return;
        closeModal();
        // Say in the same breath what did NOT get booked. The office asked for
        // the plan to go in regardless and to be handed the leftovers — so the
        // count that matters most is the one they still have to act on.
        const left = (res.unplaced || []).length;
        const clashes = (res.shift_clashes || []).length;
        toast(t("auto_done").replace("{v}", res.booked + res.assigned).replace("{s}", res.shifts)
              + (left ? ` · ${t("up_chip").replace("{n}", left)}` : "")
              // A cover row the engineer's day would not take. The diary went in
              // regardless, so this is a note, not a failure — but say it, or the
              // shift board looks short for no visible reason.
              + (clashes ? ` · ${t("auto_shift_clash").replace("{n}", clashes)}` : ""));
        // The moment after applying is when somebody realises it is wrong, so
        // the way back is offered right there rather than hunted for later.
        if (res.run_id) _lastRosterRun = res.run_id;
        done();
      } catch (err) { alert(err.message); }
    });
  });
}

// Which kinds of alert a person wants. Offered by KIND rather than as thirty
// switches: somebody wants to mute "the money", not to reason about
// invoice_overdue against vat_due. Anything about their own work stays on.
async function notifPrefsDialog() {
  let d;
  try { d = await API.get("/notification-prefs"); } catch (err) { alert(err.message); return; }
  openModal(`⚙️ ${t("notif_prefs")}`, `<form id="np">
    <p class="muted small">${t("notif_prefs_hint")}</p>
    <div class="chk-grid">${d.groups.map(g => `<label class="chk-item">
      <input type="checkbox" class="np-g" value="${g.key}"${g.enabled ? " checked" : ""}>
      <span>${t("notif_grp_" + g.key)}</span></label>`).join("")}</div>
    <div class="form-actions"><button type="button" class="btn secondary" id="np-x">${t("cancel")}</button>
      <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("np-x").addEventListener("click", closeModal);
    root.querySelector("#np").addEventListener("submit", async (e) => {
      e.preventDefault();
      // formData() reads .value only, so the ticks are collected by hand.
      const groups = {};
      root.querySelectorAll(".np-g").forEach(cb => { groups[cb.value] = cb.checked; });
      try {
        const res = await API.put("/notification-prefs", { groups });
        if (handledOffline(res)) return;
        closeModal(); toast(t("saved"));
      } catch (err) { alert(err.message); }
    });
  });
}

// Billing a visit that was actually done. The contract cycle bills contracted
// work; everything else — the extra call-out, the emergency — was completed,
// written up and quietly given away.
function billVisitDialog(visit) {
  openModal(`🧾 ${t("bill_this_visit")}`, `<form id="bv">
    <p class="muted small">${t("bill_visit_hint")}</p>
    ${field(t("amount"), "amount", { attrs: 'type="number" min="0" step="0.01" required' })}
    ${field(t("description"), "description", { value: "" })}
    <label class="chk-item"><input type="checkbox" id="bv-mat" checked>
      <span>${t("bill_include_materials")}</span></label>
    <div class="form-actions"><button type="button" class="btn secondary" id="bv-x">${t("cancel")}</button>
      <button class="btn" type="submit">${t("create_invoice")}</button></div></form>`, (root) => {
    $("bv-x").addEventListener("click", closeModal);
    root.querySelector("#bv").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      d.include_materials = $("bv-mat").checked;   // formData reads .value only
      try {
        const inv = await API.post(`/visits/${visit.id}/invoice`, d);
        if (handledOffline(inv)) return;
        closeModal();
        toast(t("saved"));
        navigate("invoice", { id: inv.id });
      } catch (err) { alert(err.message); }
    });
  });
}

// What the contract promises, written onto the branches that must deliver it.
// Shown before it is written, because overwriting a frequency somebody tuned by
// hand should be a decision rather than a side effect.
async function contractToBranchesDialog(ct) {
  if (!ct) return;
  let prev;
  try { prev = await API.post(`/contracts/${ct.id}/apply-to-branches`, {}); }
  catch (err) { alert(err.message); return; }
  const rows = prev.branches || [];
  openModal(`📤 ${t("apply_to_branches")}`, `<form id="c2b">
    <p class="muted small">${t("apply_to_branches_intro")
      .replace("{f}", t("freq_" + prev.frequency)).replace("{n}", prev.visits_per_month)}</p>
    <div class="panel"><table><thead><tr><th>${t("site_name")}</th>
      <th>${t("visits_per_month")}</th></tr></thead>
      <tbody>${rows.map(r => `<tr${r.changed ? "" : ' class="muted"'}>
        <td>${esc(r.name)}</td>
        <td>${r.changed ? `${r.was} → <strong>${r.now}</strong>`
                        : `${r.now} <span class="muted small">${t("unchanged")}</span>`}</td>
      </tr>`).join("")}</tbody></table></div>
    <div class="form-grid">
      ${field(t("service_from"), "service_from", { attrs: HHMM_ATTRS })}
      ${field(t("service_to"), "service_to", { attrs: HHMM_ATTRS })}
      ${field(t("visit_minutes"), "visit_minutes", { attrs: 'type="number" min="10" max="480" step="5"' })}
    </div>
    <p class="muted small">${t("apply_to_branches_optional")}</p>
    <div class="form-actions"><button type="button" class="btn secondary" id="c2b-x">${t("cancel")}</button>
      <button class="btn" type="submit">${t("apply_to_branches")}</button></div></form>`, (root) => {
    $("c2b-x").addEventListener("click", closeModal);
    wireTimeInputs(root);
    root.querySelector("#c2b").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      d.service_from = normHHMM(d.service_from) || "";
      d.service_to = normHHMM(d.service_to) || "";
      d.apply = true;
      try {
        const res = await API.post(`/contracts/${ct.id}/apply-to-branches`, d);
        if (handledOffline(res)) return;
        closeModal();
        toast(t("apply_to_branches_done").replace("{n}", res.updated));
      } catch (err) { alert(err.message); }
    });
  });
}

// A won quote is not yet work anybody is scheduled to do. This is the step that
// makes it so: the price and the branches it covers become the contract that
// the roster, the SLA and the billing cycle all read from.
async function quoteToContractDialog(inv) {
  let sites = [];
  try { sites = (await API.get(`/clients/${inv.client_id}`)).sites || []; } catch (e) {}
  openModal(`📑 ${t("make_contract")}`, `<form id="q2c">
    <p class="muted small">${t("make_contract_hint")}</p>
    <div class="form-grid">
      ${field(t("frequency"), "frequency", { options: FREQS.map(
        f => ({ v: f, l: t("freq_" + f) })), value: "monthly" })}
      ${field(t("start_date"), "start_date", { type: "date", value: ymd(new Date()) })}
    </div>
    ${sites.length ? `<div class="field"><label>${t("sites")}</label>
      <div class="chk-grid">${sites.map(s => `<label class="chk-item">
        <input type="checkbox" class="q2c-site" value="${s.id}"${
          String(inv.site_id) === String(s.id) ? " checked" : ""}>
        <span>${esc(s.name)}</span></label>`).join("")}</div>
      <p class="muted small">${t("make_contract_sites_hint")}</p></div>` : ""}
    <div class="form-actions"><button type="button" class="btn secondary" id="q2c-x">${t("cancel")}</button>
      <button class="btn" type="submit">${t("make_contract")}</button></div></form>`, (root) => {
    $("q2c-x").addEventListener("click", closeModal);
    root.querySelector("#q2c").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      // formData() reads .value only, so the branch ticks are collected by hand.
      d.site_ids = [...root.querySelectorAll(".q2c-site:checked")].map(c => Number(c.value));
      try {
        const ct = await API.post(`/invoices/${inv.id}/to-contract`, d);
        if (handledOffline(ct)) return;
        closeModal();
        toast(t("contract_created"));
        navigate("contracts");
      } catch (err) { alert(err.message); }
    });
  });
}

// Minutes as a person would say them: 45m, 2h, 2h 30m.
function hoursMins(n) {
  const m = Math.round(n || 0);
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

// What the office is agreeing to: every day, who works it, which areas they
// were given and how many calls — plus an honest count of what could NOT be
// placed, which is the number that tells them to hire or to widen a window.
function autoPlanHTML(plan) {
  const s = plan.summary || {};
  // A branch asking for more visits than it opens its doors for, or opening
  // only on a day nobody works, is the office's to fix and not the planner's
  // to paper over. Shown even when the plan is otherwise EMPTY — that is
  // precisely the case where "nothing to schedule" needs explaining.
  const capped = plan.capped || [];
  // THE HEADING NOW MATCHES THE ROWS. One sentence — "some branches ask for
  // more visits than there are days" — used to stand over rows that were just
  // as often about a door open for less time than the visit takes, which sent
  // the office to change a frequency that was never the problem.
  const cappedDays = capped.some(c => !c.needs_minutes);
  const cappedHTML = capped.length ? `<div class="auto-capped">
      <strong>⚠️ ${cappedDays ? t("auto_capped") : t("auto_capped_window_head")}</strong>
      <ul>${capped.map(c => `<li>${esc(localized(c, "client"))} — ${esc(c.name)}: ${
        c.needs_minutes
          ? t(c.overnight ? "auto_capped_night" : "auto_capped_short")
              .replace("{w}", c.window_minutes).replace("{m}", c.needs_minutes)
          : c.possible
            ? t("auto_capped_row").replace("{asked}", c.asked)
                .replace("{needs}", c.needs_days ?? c.asked).replace("{n}", c.possible)
                // The number to TYPE. `possible` is now counted on the
                // CALENDAR month the plan covers — the days this branch
                // actually opens in it — so it is the number itself, not a
                // weekly figure multiplied by a nominal four.
                .replace("{fits}", c.possible)
            : t("auto_capped_none")}</li>`).join("")}</ul></div>` : "";
  // VISITS THAT ONLY FIT BECAUSE THE ROUND GAVE WAY. The office's ruling is
  // that a customer's visit beats a tidy route, so the planner bends rule 5
  // rather than drop the call — but a bent round is a longer day for somebody,
  // so it is shown, named, and countable. Every line here is a visit that
  // would otherwise be in the unplaced list above.
  const bent = plan.compromises || [];
  const bentHTML = bent.length ? `<div class="auto-bent">
      <strong>🛈 ${t("auto_bent").replace("{n}", bent.length)}</strong>
      <ul>${bent.map(c => `<li>${esc(localized(c, "client"))} — ${esc(c.site_name)}: ${
        t("auto_bent_" + c.kind)} <span class="muted small">(${
        esc(c.agent_name)}, ${fmtDate(c.date)})</span></li>`).join("")}</ul>
      <div class="muted small">${t("auto_bent_hint")}</div></div>` : "";
  // Work that did not get booked, grouped by WHAT TO DO ABOUT IT. A bare count
  // tells the office something is wrong; this tells them which lever to pull.
  const un = plan.unplaced || [];
  let unplacedHTML = "";
  if (un.length) {
    const byReason = {};
    un.forEach(u => { (byReason[u.reason] = byReason[u.reason] || []).push(u); });
    // Worst first: a branch nobody may work never gets served at all, whereas
    // a full day is only this week's problem.
    const order = ["no_engineer", "nobody_working", "window_too_short", "not_reached",
                 "window_taken", "day_full", "agent_off", "agent_busy"];
    unplacedHTML = `<div class="auto-unplaced">
      <strong>⚠️ ${t("auto_unplaced_title").replace("{n}", un.length)}</strong>
      ${order.filter(r => byReason[r]).map(r => {
        const rows = byReason[r];
        // One line per BRANCH, not per missed visit — the office fixes the
        // branch once, however many of its visits fell over.
        // `site_name` is what the planner sends; `name` is what the stored
        // worklist calls the same thing. Read either, or the office is handed
        // a warning with a blank where the branch name should be.
        // EVERY BRANCH HERE IS A BUTTON. His words: "i want to click it and see
        // it and write what the issue and recommend the nearst engineer free
        // can have that visit". One line per branch still — the office fixes
        // the branch once, however many of its visits fell over — and the date
        // kept with it is the first one that failed, which is the day the
        // suggestion is worked out for.
        const seen = new Map();
        rows.forEach(u => {
          const key = u.site_id || `${localized(u, "client")}|${u.site_name || u.name}`;
          if (!seen.has(key)) {
            seen.set(key, { site_id: u.site_id, date: u.date,
                            label: `${localized(u, "client")} — ${u.site_name || u.name || ""}` });
          }
        });
        const names = [...seen.values()];
        return `<div class="un-group"><div class="un-why">${t("reason_" + r)}
            <span class="muted small">(${names.length})</span></div>
          <div class="un-names">${names.slice(0, 12).map(n => n.site_id
            // type="button" is load-bearing: this sits INSIDE the plan's own
            // form, and a button with no type is a submit button — one press
            // re-ran the whole plan and wiped the answer off the screen.
            ? `<button type="button" class="un-branch" data-wct="${n.site_id}"
                 data-date="${esc(n.date || "")}" data-label="${esc(n.label)}">${esc(n.label)}</button>`
            : `<span class="muted small">${esc(n.label)}</span>`).join("")}${
            names.length > 12 ? ` <span class="muted small">… +${names.length - 12}</span>` : ""}</div></div>`;
      }).join("")}</div>`;
  }
  if (!s.visits && !(plan.posts || []).length && !(plan.uncovered_posts || []).length) {
    return `${cappedHTML}${unplacedHTML}${bentHTML}<div class="empty">${t("auto_nothing")}</div>`;
  }
  const unplaced = (plan.problems || []).reduce((n, p) => n + ((p && p.unplaced) || 0), 0);
  // FIXED POSTS ARE NOT VISITS and are never counted as any. They are hours
  // already sold to one site, so they get their own line on the day — the
  // site, the man standing there and the hours — and a post nobody can man is
  // said out loud rather than quietly missing.
  const postsByDay = {}, uncByDay = {};
  (plan.posts || []).forEach(x => (postsByDay[x.date] = postsByDay[x.date] || []).push(x));
  (plan.uncovered_posts || []).forEach(x => (uncByDay[x.date] = uncByDay[x.date] || []).push(x));
  const postLines = (date) => [
    ...(postsByDay[date] || []).map(x => `<div class="ar-line ar-post">
        <span class="badge b-post">${t("fixed_post")}</span>
        <span class="ar-who">${esc(x.agent_name || "—")}</span>
        <span class="dp-area">${esc(x.site_name)}</span>
        <span class="muted small">${esc(x.from)}–${esc(x.to)}</span></div>`),
    ...(uncByDay[date] || []).map(x => `<div class="ar-line ar-post ar-uncovered">
        <span class="badge b-danger">${t("fixed_post_uncovered")}</span>
        <span class="dp-area">${esc(x.site_name)}</span>
        <span class="muted small">${esc(x.from)}–${esc(x.to)}</span></div>`),
  ].join("");
  const rows = (plan.days || []).map(d => `<tr>
      <td><strong>${fmtDate(d.date)}</strong></td>
      <td>${postLines(d.date)}${d.assignments.map(a => `<div class="ar-line"><span class="ar-who">${esc(a.agent_name)}</span>
        ${a.zone ? `<span class="dp-area">${esc(localized(a.zone, "name"))}</span>` : ""}
        ${a.areas.map(x => `<span class="dp-area">${esc(localized(x, "name"))}</span>`).join(" ")}
        ${// Rule 3 on the face of the plan: whose branches he is standing in for.
          (() => { const c = [...new Set(a.visits.map(v => v.cover_for).filter(Boolean))];
            return c.length ? `<span class="badge b-paused">${
              esc(t("covering_for").replace("{who}", c.join(", ")))}</span>` : ""; })()}
        <span class="muted small">${a.visits.length} ${t("visits_lc")} ·
          ${esc(a.visits[0].start)}–${esc(a.visits[a.visits.length - 1].end)}${
          // A night round finishes on the NEXT date. Saying "22:00–01:30" and
          // leaving it there is exactly the misreading this marker prevents.
          a.visits[a.visits.length - 1].end_day ? ` <span class="next-day">${
            t("next_morning")}</span>` : ""}</span></div>`).join("")}</td>
    </tr>`).join("");
  // A POST NOBODY CAN MAN IS THE LOUDEST THING ON THE PAGE. It is a site the
  // company has contracted to have somebody standing in, with nobody standing
  // there — which is worse than a visit that slipped.
  const unc = plan.uncovered_posts || [];
  const uncHTML = unc.length ? `<div class="auto-unplaced auto-uncovered">
      <strong>🚨 ${t("fixed_post_uncovered_n").replace("{n}", unc.length)}</strong>
      ${[...new Set(unc.map(x => x.site_name))].map(nm => {
        const days = unc.filter(x => x.site_name === nm);
        return `<div class="un-group"><div class="un-why">${esc(nm)}
            <span class="muted small">(${days.length})</span></div>
          <div class="muted small">${days.slice(0, 8).map(x => esc(fmtDate(x.date))).join(" · ")}${
            days.length > 8 ? ` … +${days.length - 8}` : ""}</div></div>`;
      }).join("")}</div>` : "";
  return `${cappedHTML}${uncHTML}<div class="auto-summary">
      <span class="sc-chip">${s.days} ${t("days_lc")}</span>
      <span class="sc-chip">${s.visits} ${t("visits_lc")}</span>
      <span class="sc-chip">${s.engineers} ${t("engineers_lc")}</span>
      ${s.travel_minutes ? `<span class="sc-chip">🚗 ${hoursMins(s.travel_minutes)} ${
        t("travel_lc")}</span>` : ""}
      ${plan.overdue_branches ? `<span class="sc-chip warn">⏰ ${
        t("auto_overdue_n").replace("{n}", plan.overdue_branches)}</span>` : ""}
      ${s.posts ? `<span class="sc-chip">📌 ${
        t("fixed_posts_n").replace("{n}", s.posts)}</span>` : ""}
      ${s.uncovered_posts ? `<span class="sc-chip danger">🚨 ${
        t("fixed_post_uncovered_n").replace("{n}", s.uncovered_posts)}</span>` : ""}
      ${unplaced ? `<span class="sc-chip warn">${t("auto_unplaced").replace("{n}", unplaced)}</span>` : ""}
      ${bent.length ? `<span class="sc-chip">🛈 ${
        t("auto_bent_n").replace("{n}", bent.length)}</span>` : ""}
    </div>
    ${unplacedHTML}
    ${bentHTML}
    <div class="panel" style="max-height:340px;overflow:auto"><table>
      <thead><tr><th>${t("date")}</th><th>${t("plan")}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

// Which grid the roster shows. "area" answers the question an office that works
// geographically actually asks — who is covering Maadi on Tuesday — which the
// engineer-by-day grid can only answer by reading down every row.
let _shMode = "agent";

// The roster seen from the areas' side: one row per area, one cell per day,
// naming whoever covers it. An area with nobody on it is the point of the
// screen, so an empty cell says so rather than being blank.
function areaRosterHTML(d, dayHead) {
  const areas = (cache.areas || []).filter(a => a.active !== 0);
  if (!areas.length) return `<div class="empty">${t("no_areas_yet")}</div>`;
  const nameOf = (id) => {
    const a = (d.agents || []).find(x => String(x.id) === String(id));
    return a ? a.full_name : "";
  };
  // agent ids per area per day, deduped — one engineer covering an area twice
  // in a day (two shifts) is one name, not two.
  const cell = {};
  (d.shifts || []).forEach(sh => {
    if (!sh.area_id) return;
    const k = sh.area_id + "|" + sh.shift_date;
    (cell[k] = cell[k] || new Set()).add(String(sh.agent_id));
  });
  // Shifts carrying no area at all: not a restriction, but the office should be
  // able to see that someone is rostered without a patch.
  const loose = {};
  (d.shifts || []).forEach(sh => {
    if (sh.area_id) return;
    (loose[sh.shift_date] = loose[sh.shift_date] || new Set()).add(String(sh.agent_id));
  });
  const dayCells = (areaId) => d.days.map(day => {
    const who = [...(cell[areaId + "|" + day] || [])];
    return `<td class="sh-cell ar-cell${who.length ? "" : " ar-empty"}"
      data-arearow="${areaId}" data-day="${day}">${who.length
        ? who.map(id => `<span class="ar-who">${esc(nameOf(id))}</span>`).join("")
        : `<span class="muted small">—</span>`}</td>`;
  }).join("");
  const rows = areas.map(a => `<tr>
      <td><strong>${esc(areaLabel(a))}</strong></td>${dayCells(a.id)}
      <td class="num">${d.days.reduce((n, day) =>
        n + ((cell[a.id + "|" + day] || new Set()).size ? 1 : 0), 0)}</td></tr>`).join("");
  const looseRow = Object.keys(loose).length ? `<tr class="ar-loose">
      <td><span class="muted">${t("area_none")}</span></td>
      ${d.days.map(day => `<td>${[...(loose[day] || [])].map(id =>
        `<span class="ar-who">${esc(nameOf(id))}</span>`).join("") || `<span class="muted small">—</span>`}</td>`).join("")}
      <td></td></tr>` : "";
  return `<div class="panel"><table class="sh-table"><thead><tr><th>${t("area")}</th>
      ${d.days.map(dayHead).join("")}<th>${t("days_covered")}</th></tr></thead>
      <tbody>${rows}${looseRow}</tbody></table></div>`;
}

// Roster a whole area in one go: who covers it, on which days. Every shift
// created is tagged with the area, which is what drives the dispatch board's
// area filter, the out-of-area warning and a team leader's team.
//
// HOURS ARE OPTIONAL. An office that works by area rather than by clock rosters
// with the open-ended "Area cover" shift and never opens the times at all; the
// clock fields appear only if a shift WITH hours is chosen. Because this
// appends instead of rewriting the day, one engineer can cover two areas on the
// same day — the normal case when the roster is geographic.
function areaShiftModal(agents, days, types, current, done, pre) {
  pre = pre || {};
  const areas = (cache.areas || []).filter(a => a.active !== 0);
  if (!areas.length) { alert(t("no_areas_yet")); return; }
  const working = types.filter(ty => !ty.is_off);
  // The hours-free shift leads the list, so the simple case is the default one.
  working.sort((x, y) => (y.open_ended ? 1 : 0) - (x.open_ended ? 1 : 0));
  const typeOpts = working.map(ty => ({ v: ty.id, l: shiftLabel(ty) }));
  if (!typeOpts.length) { alert(t("no_shift_types_yet")); return; }
  const areaOpts = areas.map(a => ({ v: a.id, l: areaLabel(a) }));
  const boxes = days.map(day => {
    const dt = new Date(day + "T00:00:00");
    // Opened from an area cell: just that day is ticked, since the office
    // clicked one square. Opened from the toolbar: the working week.
    const on = pre.day ? day === pre.day : dt.getDay() !== 5;
    return `<label class="sh-daybox"><input type="checkbox" class="sh-day" value="${day}" ${on ? "checked" : ""}>
      ${dt.toLocaleDateString(LANG === "ar" ? "ar" : "en-GB", { weekday: "short", day: "numeric" })}</label>`;
  }).join("");
  // Who already works this area this week is the best guess at who works it
  // next week, so picking an area ticks them.
  const worksArea = (agentId, areaId) => (current || []).some(s =>
    String(s.agent_id) === String(agentId) && String(s.area_id || "") === String(areaId));
  const people = agents.map(a => `<label class="opt-pick">
      <input type="checkbox" class="sh-who" value="${a.id}" data-name="${esc(a.full_name)}">
      <span>${esc(a.full_name)}<span class="muted small"> · ${esc(a.specialization || t("role_" + a.role))}</span></span>
    </label>`).join("");
  openModal(`📍 ${t("shift_an_area")}`, `<form id="saf"><div class="form-grid">
      ${field(t("area"), "area_id", { options: areaOpts })}
      ${field(t("shift_lbl"), "shift_type_id", { options: typeOpts })}
      ${field(t("shift_start"), "start_time", { attrs: HHMM_ATTRS, cls: "saf-hours" })}
      ${field(t("shift_end"), "end_time", { attrs: HHMM_ATTRS, cls: "saf-hours" })}</div>
    <div class="field"><label>${t("select_days")}</label><div class="sh-daybar">${boxes}</div></div>
    <div class="field"><label>${t("engineers_on_it")}
        <button type="button" class="link-btn sm" id="saf-all">${t("select_all")}</button></label>
      <div class="opt-picks">${people || `<div class="empty">${t("no_agents_to_roster")}</div>`}</div></div>
    <p class="muted small" id="saf-openhint">${t("area_cover_hint")}</p>
    <p class="muted small">${t("shift_an_area_hint")}</p>
    <div class="form-actions"><button type="button" class="btn secondary" id="saf-x">${t("cancel")}</button>
    <button class="btn" type="submit" id="saf-save">${t("save")}</button></div></form>`, (root) => {
    $("saf-x").addEventListener("click", closeModal);
    wireTimeInputs(root);
    const areaSel = root.querySelector("[name=area_id]");
    const typeSel = root.querySelector("[name=shift_type_id]");
    if (pre.area_id) areaSel.value = pre.area_id;
    const prefill = () => {
      const ty = types.find(x => String(x.id) === typeSel.value);
      root.querySelector("[name=start_time]").value = (ty && ty.start_time) || "";
      root.querySelector("[name=end_time]").value = (ty && ty.end_time) || "";
      // No clock on an open-ended shift — showing empty time boxes that are
      // ignored on save would only invite someone to fill them in.
      const openEnded = !!(ty && ty.open_ended);
      root.querySelectorAll(".saf-hours").forEach(el => {
        el.style.display = openEnded ? "none" : "";
      });
      const note = root.querySelector("#saf-openhint");
      if (note) note.style.display = openEnded ? "" : "none";
    };
    const tickArea = () => root.querySelectorAll(".sh-who").forEach(cb => {
      cb.checked = worksArea(cb.value, areaSel.value);
    });
    typeSel.addEventListener("change", prefill);
    areaSel.addEventListener("change", tickArea);
    prefill(); tickArea();
    $("saf-all").addEventListener("click", () => {
      const boxes = [...root.querySelectorAll(".sh-who")];
      const on = boxes.some(b => !b.checked);
      boxes.forEach(b => { b.checked = on; });
    });
    const save = async (e) => {
      if (e) e.preventDefault();
      const picked = [...root.querySelectorAll(".sh-day:checked")].map(c => c.value);
      const who = [...root.querySelectorAll(".sh-who:checked")].map(c => c.value);
      if (!picked.length) { alert(t("select_days")); return; }
      if (!who.length) { alert(t("engineers_on_it")); return; }
      try {
        // /shifts/area APPENDS. The older /shifts/bulk rewrites each day, which
        // would have wiped an engineer's first area when a second was added.
        const saved = await API.post("/shifts/area", {
          area_id: areaSel.value, agent_ids: who, dates: picked,
          shift_type_id: typeSel.value,
          start_time: normHHMM(root.querySelector("[name=start_time]").value),
          end_time: normHHMM(root.querySelector("[name=end_time]").value),
        });
        if (handledOffline(saved)) return;
        closeModal();
        toast(saved.skipped
          ? t("rostered_some").replace("{n}", saved.saved).replace("{s}", saved.skipped)
          : t("saved"));
        done();
      } catch (err) { alert(err.message); }
    };
    root.querySelector("#saf").addEventListener("submit", save);
    $("saf-save").addEventListener("click", save);
  });
}

// Put one shift across a whole week for a single agent, days chosen by checkbox.
function fillWeekModal(agent, days, types, done) {
  if (!agent) return;
  const opts = [{ v: "", l: t("no_shift") }].concat(types.map(ty => ({ v: ty.id, l: shiftLabel(ty) })));
  const boxes = days.map(day => {
    const dt = new Date(day + "T00:00:00");
    const working = dt.getDay() !== 5;   // everything but Friday pre-ticked
    return `<label class="sh-daybox"><input type="checkbox" class="sh-day" value="${day}" ${working ? "checked" : ""}>
      ${dt.toLocaleDateString(LANG === "ar" ? "ar" : "en-GB", { weekday: "short", day: "numeric" })}</label>`;
  }).join("");
  openModal(`${t("fill_week")} — ${agent.full_name}`,
    `<form id="fwf"><div class="form-grid">
      ${field(t("shift_lbl"), "shift_type_id", { options: opts })}
      ${field(t("shift_start"), "start_time", { attrs: HHMM_ATTRS })}
      ${field(t("shift_end"), "end_time", { attrs: HHMM_ATTRS })}</div>
      <div class="field"><label>${t("select_days")}</label><div class="sh-daybar">${boxes}</div></div>
      <p class="muted small">${t("fill_week_hint")}</p>
      <div class="form-actions"><button type="button" class="btn secondary" id="fwf-x">${t("cancel")}</button>
      <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("fwf-x").addEventListener("click", closeModal);
    wireTimeInputs(root);
    const sel = root.querySelector("[name=shift_type_id]");
    // Prefill the hours from the chosen shift so they can be trimmed to a
    // shorter block before applying them across the week.
    sel.addEventListener("change", () => {
      const ty = types.find(x => String(x.id) === sel.value);
      root.querySelector("[name=start_time]").value = (ty && ty.start_time) || "";
      root.querySelector("[name=end_time]").value = (ty && ty.end_time) || "";
    });
    root.querySelector("#fwf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const typeId = sel.value;
      const picked = [...root.querySelectorAll(".sh-day:checked")].map(c => c.value);
      if (!picked.length) { alert(t("select_days")); return; }
      const shifts = typeId ? [{
        shift_type_id: typeId,
        start_time: normHHMM(root.querySelector("[name=start_time]").value),
        end_time: normHHMM(root.querySelector("[name=end_time]").value),
      }] : [];
      const items = picked.map(day => ({ agent_id: agent.id, date: day, shifts }));
      try {
        const saved = await API.post("/shifts/bulk", { items });
        if (handledOffline(saved)) return;
        closeModal(); toast(t("saved")); done();
      } catch (err) { alert(err.message); }
    });
  });
}

// Repeat the previous week's roster onto this one.
async function copyLastWeek(weekStart, done) {
  const prevStart = shiftDate(weekStart, -7);
  let prev = [];
  try { prev = await API.get(`/shifts?from=${prevStart}&to=${shiftDate(prevStart, 6)}`); }
  catch (e) { alert(e.message); return; }
  if (!prev.length) { toast(t("nothing_to_copy")); return; }
  if (!confirm(t("confirm_copy_week"))) return;
  // Each item replaces a whole agent-day, so a day's shifts must travel together
  // — sending them as separate items would make each one wipe the last.
  const byDay = {};
  prev.forEach(s => {
    const key = s.agent_id + "|" + shiftDate(s.shift_date, 7);
    (byDay[key] = byDay[key] || []).push({
      shift_type_id: s.shift_type_id, start_time: s.start_time,
      end_time: s.end_time, note: s.note,
    });
  });
  const items = Object.keys(byDay).map(key => {
    const [agentId, date] = key.split("|");
    return { agent_id: +agentId, date, shifts: byDay[key] };
  });
  try {
    const saved = await API.post("/shifts/bulk", { items });
    if (handledOffline(saved)) return;
    toast(t("week_copied")); done();
  } catch (err) { alert(err.message); }
}

// The shift catalog itself — rename, re-time, recolour or retire a shift.
async function shiftTypesModal(done) {
  let types = [];
  try { types = await API.get("/shift-types?all=1"); } catch (e) { alert(e.message); return; }
  const rows = types.map(ty => `<tr class="${ty.active ? "" : "sh-retired"}">
    <td><span class="sh-chip${ty.is_off ? " off" : ""}" style="--sh:${esc(ty.color)}">${esc(shiftLabel(ty))}</span></td>
    <td>${esc(shiftHours(ty.start_time, ty.end_time) || t("off_day"))}</td>
    <td>${ty.active ? "" : `<span class="muted small">${t("shift_retired")}</span>`}</td>
    <td><button class="link-btn sm" data-tedit="${ty.id}">${t("edit")}</button>
      ${can("shifts.delete") && ty.active ? `<button class="link-btn danger sm" data-tdel="${ty.id}">${t("delete")}</button>` : ""}</td></tr>`).join("");
  openModal(t("manage_shifts"), `<table><thead><tr><th>${t("shift_lbl")}</th><th>${t("shift_hours")}</th>
    <th>${t("status")}</th><th>${t("actions")}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="form-actions"><button class="btn" id="st-new">+ ${t("new_shift_type")}</button></div>`, (root) => {
    $("st-new").addEventListener("click", () => shiftTypeForm(null, done));
    root.querySelectorAll("[data-tedit]").forEach(b => b.addEventListener("click", () =>
      shiftTypeForm(types.find(x => String(x.id) === b.dataset.tedit), done)));
    root.querySelectorAll("[data-tdel]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm(t("confirm_retire_shift"))) return;
      try { await API.del("/shift-types/" + b.dataset.tdel); closeModal(); toast(t("saved")); done(); }
      catch (err) { alert(err.message); }
    }));
  });
}

function shiftTypeForm(ty, done) {
  const isEdit = !!ty; ty = ty || {};
  openModal(isEdit ? t("edit") : t("new_shift_type"), `<form id="stf"><div class="form-grid">
    ${field(t("name_en"), "name_en", { value: ty.name_en })}
    ${field(t("name_ar"), "name_ar", { value: ty.name_ar })}
    ${field(t("shift_start"), "start_time", { value: ty.start_time || "", attrs: HHMM_ATTRS })}
    ${field(t("shift_end"), "end_time", { value: ty.end_time || "", attrs: HHMM_ATTRS })}
    ${field(t("shift_color"), "color", { type: "color", value: ty.color || "#1f74d6" })}
    </div>
    <label class="sh-daybox"><input type="checkbox" id="stf-off" ${ty.is_off ? "checked" : ""}> ${t("is_off_day")}</label>
    <label class="sh-daybox"><input type="checkbox" id="stf-open" ${ty.open_ended ? "checked" : ""}> ${t("is_open_ended")}</label>
    <p class="muted small">${t("is_open_ended_hint")}</p>
    <div class="form-actions"><button type="button" class="btn secondary" id="stf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("stf-x").addEventListener("click", closeModal);
    wireTimeInputs(root);
    root.querySelector("#stf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      d.is_off = $("stf-off").checked;
      d.open_ended = $("stf-open").checked;     // checkboxes are invisible to formData()
      d.start_time = normHHMM(d.start_time);
      d.end_time = normHHMM(d.end_time);
      try {
        const saved = isEdit ? await API.put("/shift-types/" + ty.id, d) : await API.post("/shift-types", d);
        if (handledOffline(saved)) return;
        closeModal(); toast(t("saved")); done();
      } catch (err) { alert(err.message); }
    });
  });
}

// ====================================================================
// Locations — every site across all clients
// ====================================================================
async function viewLocations(v) {
  // Every client is listed — with its sites, or a "no locations" row when it
  // has none yet (independent of whether the client has any contracts).
  const [clients, sites] = await Promise.all([API.get("/clients"), API.get("/sites")]);
  const list = Array.isArray(clients) ? clients : (clients.items || []);
  list.sort((a, b) => localized(a, "name").localeCompare(localized(b, "name")));
  const byClient = {};
  sites.forEach(s => { (byClient[s.client_id] = byClient[s.client_id] || []).push(s); });
  const canEdit = can("clients.edit");
  const clink = c => `<a href="#" class="link-btn" data-open="${c.id}">${esc(localized(c, "name"))}</a>`;
  const locCell = addr => addr
    ? `<a class="link-btn" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}" target="_blank" rel="noopener">📍 ${t("map_pin")}</a>` : "—";
  // The site-map column: a thumbnail of the uploaded map picture (if any) plus
  // an upload/replace button and a remove button (for editors).
  const mapImgCell = s => {
    // The plan may be a PDF, which has no thumbnail — show it as a document
    // link instead (the viewer opens it in-page on a phone).
    const thumb = !s.map_image ? ""
      : attachKind(s.map_image) === "pdf"
        ? `<a class="link-btn sm" href="/uploads/${esc(s.map_image)}" target="_blank" rel="noopener"
             data-file-name="${esc(s.name || "")} — ${esc(t("site_map"))}">📄 ${t("view_map_img")}</a>`
        : `<a href="/uploads/${esc(s.map_image)}" target="_blank" rel="noopener" title="${t("view_map_img")}"><img src="/uploads/${esc(s.map_image)}" alt="" style="height:36px;border-radius:6px;border:1px solid var(--line);vertical-align:middle"></a>`;
    const editBtn = canEdit
      ? `<button class="link-btn sm" data-mapedit="${s.id}">✏️ ${s.map_image ? t("replace") : t("upload_site_map")}</button>` : "";
    const delBtn = (canEdit && s.map_image)
      ? `<button class="link-btn danger sm" data-mapdel="${s.id}">✕</button>` : "";
    const parts = [thumb, editBtn, delBtn].filter(Boolean);
    return parts.length ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${parts.join("")}</div>` : "—";
  };
  // Coordinates cell: a maps pin when the site is geocoded (needed for route
  // optimization), plus an edit button to set / change them.
  // Coordinates alone: the branch's ✏️ used to live here, where it read as
  // "edit the coordinates" — it opens the whole branch, so it now sits in its
  // own Edit column at the end of the row where it can be found.
  const geoCell = s => {
    const has = s.lat != null && s.lng != null;
    // His own link if he pasted one — it opens the exact place he pinned,
    // which is how he checks a pin is the right door.
    const href = s.map_url || (has
      ? `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}` : "");
    return has
      ? `<a class="link-btn" href="${esc(href)}" target="_blank" rel="noopener">📍 ${(+s.lat).toFixed(4)}, ${(+s.lng).toFixed(4)}</a>`
      : `<span class="muted small">${t("no_coords")}</span>`;
  };
  const editCell = s => canEdit
    ? `<button class="link-btn sm" data-siteedit="${s.id}">✏️ ${t("edit")}</button>
       ${statusToggleBtn(s, "site")}` : "—";
  const byId = {};
  sites.forEach(s => { byId[s.id] = s; });
  // The branch carries the area, and the area is what puts work on a team
  // manager's patch and on the dispatch board's filter. So the two gaps worth
  // naming are a company with no branch at all and a branch with no area —
  // either way that work belongs to nobody.
  // A branch nobody services is not a gap to chase: switching one off is how
  // the office CLEARS these lists, so it must not go on being counted by them.
  const live = s => !isOff(s) && s.client_status !== "inactive";
  const gapOf = s => !live(s) ? "" : !s.area_id ? "area" : (!(+s.visits_per_month > 0) ? "sched" : "");
  // ONE ROW, BUILT IN ONE PLACE — because a save now re-runs this for the single
  // branch that changed and swaps that <tr>, instead of re-reading all 210
  // branches and rebuilding the screen (2026-08-25 audit: 835 ms -> one PUT).
  const siteRowHTML = (c, s) => {
    const gap = gapOf(s);
    return `<tr data-site="${s.id}" data-client="${c.id}"${gap ? ` data-gap="${gap}"` : ""}${
      live(s) ? "" : ` class="row-off" data-off="1"`}><td>${clink(c)}</td>
      <td>${esc(s.name)}</td><td>${esc(s.address || "—")}</td><td>${esc(areaOf(s) || s.area || "—")}</td>
      <td>${branchScheduleHTML(s)}</td>
      <td>${geoCell(s)}</td><td>${locCell(s.address)}</td><td>${mapImgCell(s)}</td>
      <td>${statusBadge(s.status || "active")}</td>
      <td class="row-actions">${editCell(s)}</td></tr>`;
  };
  const rows = list.map(c => {
    const cs = byClient[c.id] || [];
    if (!cs.length) {
      return `<tr data-client="${c.id}"${isOff(c) ? "" : ` data-gap="branch"`} class="${isOff(c) ? "row-off" : ""}"><td>${clink(c)}</td>
        <td colspan="8" class="muted">${t("no_locations")}</td><td>—</td></tr>`;
    }
    return cs.map(s => siteRowHTML(c, s)).join("");
  }).join("");
  // The gap counters are DERIVED from the branches this screen is holding, so
  // they are recomputed — not re-fetched — when one of those branches changes.
  // Taking a branch's area away has to move the "branches with no area" number
  // the moment it is saved, or the office is reading yesterday's gap.
  const gapBarHTML = () => {
    const noBranch = list.filter(c => !isOff(c) && !(byClient[c.id] || []).length);
    const noArea = sites.filter(s => live(s) && !s.area_id);
    // A branch with an area but no visits_per_month is invisible to the automatic
    // scheduler — it has somewhere to be and nobody asking for it. That is the
    // third gap, and the one standing between the office and the ⚡ button.
    const noSched = sites.filter(s => live(s) && s.area_id && !(+s.visits_per_month > 0));
    return (noBranch.length || noArea.length || noSched.length) ? `<div class="panel loc-gaps">
      <strong>⚠️ ${t("area_gaps")}</strong>
      <p class="muted small" style="margin:4px 0 8px">${t("area_gaps_hint")}</p>
      ${noBranch.length ? `<button class="btn secondary sm" data-gapfilter="branch">${
        t("gap_no_branch").replace("{n}", noBranch.length)}</button>` : ""}
      ${noArea.length ? `<button class="btn secondary sm" data-gapfilter="area">${
        t("gap_no_area").replace("{n}", noArea.length)}</button>` : ""}
      ${noSched.length ? `<button class="btn secondary sm" data-gapfilter="sched">${
        t("gap_no_schedule").replace("{n}", noSched.length)}</button>` : ""}
      <button class="btn secondary sm" data-gapfilter="">${t("show_all")}</button></div>` : "";
  };
  const offCount = sites.filter(s => !live(s)).length;
  v.innerHTML = `<div class="page-head"><h2>${t("locations_title")}</h2>
    <span class="muted">${list.length} ${t("nav_clients")} · ${sites.length} ${t("sites_count")}</span></div>
    <div id="loc-gapbar">${gapBarHTML()}</div>
    <div class="panel">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <input id="loc-q" type="search" placeholder="${t("search")}…" style="max-width:340px;width:100%;margin:0">
        ${offCount ? `<label class="muted small"><input type="checkbox" id="loc-hide-off">
          ${t("hide_inactive").replace("{n}", offCount)}</label>` : ""}</div>
      <table><thead><tr><th>${t("client")}</th><th>${t("site_name")}</th><th>${t("address_en")}</th>
        <th>${t("area")}</th><th>${t("visiting_schedule")}</th>
        <th>${t("coordinates")}</th><th>${t("location_lbl")}</th><th>${t("site_map")}</th>
        <th>${t("status")}</th><th>${t("edit")}</th></tr></thead>
      <tbody id="loc-body">${rows || `<tr><td colspan="10" class="empty">${t("none")}</td></tr>`}</tbody>
      </table></div>`;
  // Filtering to a gap is how the office works through it: show only the
  // companies with no branch, add one to each, and the list empties itself.
  // Both filters write the same property, so each applies the other's rule too
  // — otherwise "show all" quietly un-hides the branches the office just hid.
  const applyLocFilters = (want) => {
    const hideOff = !!($("loc-hide-off") && $("loc-hide-off").checked);
    v.querySelectorAll("#loc-body tr").forEach(tr => {
      const wanted = !want || tr.dataset.gap === want;
      tr.style.display = (wanted && !(hideOff && tr.dataset.off)) ? "" : "none";
    });
  };
  let locGap = "";
  const wireGapBar = () => {
    v.querySelectorAll("#loc-gapbar [data-gapfilter]").forEach(b => b.addEventListener("click", () => {
      locGap = b.dataset.gapfilter;
      applyLocFilters(locGap);
    }));
  };
  const q = $("loc-q");
  const applySearch = (scope) => {
    const term = q ? q.value.trim().toLowerCase() : "";
    (scope || v).querySelectorAll("#loc-body tr").forEach(tr =>
      tr.classList.toggle("hidden", !!term && !tr.textContent.toLowerCase().includes(term)));
  };
  // Everything one row needs, so a row that has just been swapped can be given
  // its handlers back without touching the other 209.
  const wireRow = (tr) => {
    tr.querySelectorAll("[data-siteedit]").forEach(b => b.addEventListener("click", () =>
      siteForm(byId[b.dataset.siteedit].client_id, byId[b.dataset.siteedit], patchSite)));
    tr.querySelectorAll("[data-open]").forEach(a => a.addEventListener("click", (e) => {
      e.preventDefault(); navigate("client", { id: a.dataset.open });
    }));
    tr.querySelectorAll("[data-mapedit]").forEach(b => b.addEventListener("click", () =>
      siteMapDialog(b.dataset.mapedit, () => navigate("locations"))));
    tr.querySelectorAll("[data-mapdel]").forEach(b => b.addEventListener("click", async () => {
      if (confirm(t("confirm_delete"))) { await API.del("/sites/" + b.dataset.mapdel + "/map"); navigate("locations"); }
    }));
    // Switching a branch off cancels visits and changes what the whole screen
    // counts, so that one still reloads the screen. It is a rarer gesture than
    // an edit and it is not what the audit was about.
    wireStatusToggles(tr, (kind, id) => byId[id], () => navigate("locations"));
  };
  // THE SAVE. The row is rebuilt from what the server just confirmed, the gap
  // counters are recomputed from the branches already in hand, and the filters
  // are re-applied so a row that no longer belongs to the current filter stops
  // showing. No list is re-read; the page does not move.
  function patchSite(saved) {
    if (!saved || !byId[saved.id]) { navigate("locations"); return; }
    const merged = withAreaName(saved, byId[saved.id]);
    byId[saved.id] = merged;
    const i = sites.findIndex(x => String(x.id) === String(merged.id));
    if (i >= 0) sites[i] = merged;
    const cs = byClient[merged.client_id] || [];
    const j = cs.findIndex(x => String(x.id) === String(merged.id));
    if (j >= 0) cs[j] = merged;
    const owner = list.find(c => String(c.id) === String(merged.client_id)) || {};
    swapRow(v.querySelector(`#loc-body tr[data-site="${merged.id}"]`),
            siteRowHTML(owner, merged), wireRow);
    $("loc-gapbar").innerHTML = gapBarHTML();
    wireGapBar();
    applySearch();
    applyLocFilters(locGap);
  }
  wireGapBar();
  v.querySelectorAll("#loc-body tr").forEach(wireRow);
  if ($("loc-hide-off")) $("loc-hide-off").addEventListener("change", () => applyLocFilters(locGap));
  if (q) q.addEventListener("input", () => applySearch());
}
// Upload / replace the map-design picture for a single site.
function siteMapDialog(siteId, after) {
  openModal(t("upload_site_map"), `<form id="smf">
    <div class="field"><label>${t("site_map")}</label>
      <input type="file" name="file" accept="image/*,application/pdf,.pdf" required />
      <div class="muted small">${t("site_map_hint")}</div></div>
    <div class="form-actions"><button type="button" class="btn secondary" id="smf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("upload")}</button></div></form>`, (root) => {
    $("smf-x").addEventListener("click", closeModal);
    root.querySelector("#smf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = root.querySelector("[name=file]").files[0];
      if (!file) return;
      try { await API.uploadSiteMap(siteId, file); closeModal(); toast(t("saved")); after && after(); }
      catch (err) { alert(err.message); }
    });
  });
}

// ====================================================================
// Contracts (recurring)
// ====================================================================
const FREQS = ["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"];
// Maps a location string to a Google Maps URL (a maps link is used as-is;
// anything else is treated as a search query / coordinates).
function mapsUrl(loc) {
  const v = (loc || "").trim();
  return /^https?:\/\//i.test(v) ? v : "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(v);
}
// One contract: the summary row plus a hidden detail row listing its sites.
function contractRow(c, ncols) {
  const sites = c.sites || [];
  const acts = can("contracts.edit") || can("contracts.delete");
  const toggle = sites.length
    ? `<button class="link-btn sm ct-toggle" data-toggle="${c.id}" style="margin-inline-end:6px">▸</button>` : "";
  const main = `<tr data-row="${c.id}"><td>${toggle}${esc(localized(c, "client"))}
      ${sites.length ? `<span class="muted small">(${sites.length} ${t("sites_count")})</span>` : ""}
      ${can("targets.view") && c.sold_by_name
        ? `<div class="muted small">${esc(t("mkt_brought_by"))}: ${esc(c.sold_by_name)}</div>` : ""}</td>
    <td>${esc(localized(c, "service") || "—")}</td>
    <td>${esc(c.agent_name || "—")}</td><td>${t("freq_" + c.frequency)}${c.auto_invoice ? `<br><span class="badge b-active" title="${esc(t("auto_bill_on_hint"))}">💸 ${t("auto_bill")}${c.next_bill_date ? " · " + fmtDate(c.next_bill_date) : ""}</span>` : ""}</td><td>${fmtDate(c.next_run_date)}</td>
    <td>${money(c.price)}</td><td><span class="badge b-${c.status === "active" ? "active" : "inactive"}">${t("ct_" + c.status)}</span></td>
    ${acts ? `<td>${can("clients.edit") ? `<button class="link-btn sm" data-tobranch="${c.id}" title="${esc(t("apply_to_branches_hint"))}">📤 ${t("apply_to_branches")}</button> · ` : ""}${can("contracts.edit") ? `<button class="link-btn sm" data-edit="${c.id}">${t("edit")}</button>` : ""}${(can("contracts.edit") && can("contracts.delete")) ? " · " : ""}${can("contracts.delete") ? `<button class="link-btn danger sm" data-del="${c.id}">${t("delete")}</button>` : ""}</td>` : ""}</tr>`;
  if (!sites.length) return main;
  const rows = sites.map(s => `<tr><td>${esc(s.site_name || t("unassigned"))}</td>
    <td>${s.map_location ? `<a href="${esc(mapsUrl(s.map_location))}" target="_blank" rel="noopener">📍 ${esc(s.map_location)}</a>` : "—"}</td>
    <td style="text-align:end">${money(s.price)}</td></tr>`).join("");
  const detail = `<tr class="ct-sites-detail hidden" data-detail="${c.id}"><td colspan="${ncols}">
    <table><thead><tr><th>${t("location_lbl")}</th><th>${t("map_pin")}</th><th style="text-align:end">${t("price")}</th></tr></thead>
    <tbody>${rows}</tbody></table></td></tr>`;
  return main + detail;
}
async function viewContracts(v) {
  const list = await API.get("/contracts");
  const ncols = 7 + ((can("contracts.edit") || can("contracts.delete")) ? 1 : 0);
  v.innerHTML = `<div class="page-head"><h2>${t("contracts_title")}</h2>
    <div style="display:flex;gap:8px">
      ${can("contracts.edit") ? `<button class="btn secondary" id="run-ct">⚙ ${t("run_now")}</button>` : ""}
      ${can("invoices.create") ? `<button class="btn secondary" id="bill-ct">💸 ${t("bill_now")}</button>` : ""}
      ${can("contracts.create") ? `<button class="btn" id="add-ct">+ ${t("new_contract")}</button>` : ""}</div></div>
    <div class="panel"><table><thead><tr><th>${t("client")}</th><th>${t("service")}</th><th>${t("agent")}</th>
      <th>${t("frequency")}</th><th>${t("next_run")}</th><th>${t("price")}</th><th>${t("contract_status")}</th>${(can("contracts.edit") || can("contracts.delete")) ? `<th></th>` : ""}</tr></thead>
      <tbody>${list.map(c => contractRow(c, ncols)).join("")
        || `<tr><td colspan="${ncols}" class="empty">${t("none")}</td></tr>`}</tbody></table></div>`;
  if ($("add-ct")) $("add-ct").addEventListener("click", () => contractForm());
  if ($("run-ct")) $("run-ct").addEventListener("click", async () => {
    const r = await API.post("/contracts/run", {}); toast(`${r.created} ${t("generated")}`); navigate("contracts");
  });
  if ($("bill-ct")) $("bill-ct").addEventListener("click", async () => {
    const r = await API.post("/contracts/bill", {}); toast(`${r.created} ${t("invoices_generated")}`); navigate("contracts");
  });
  v.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => contractForm(list.find(c => c.id == b.dataset.edit))));
  v.querySelectorAll("[data-tobranch]").forEach(b => b.addEventListener("click",
    () => contractToBranchesDialog(list.find(c => c.id == b.dataset.tobranch))));
  v.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    if (confirm(t("confirm_delete"))) { const r = await API.del("/contracts/" + b.dataset.del); if (handledOffline(r, b.closest("tr"))) return; navigate("contracts"); }
  }));
  v.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", () => {
    const det = v.querySelector(`[data-detail="${b.dataset.toggle}"]`);
    if (!det) return;
    const open = det.classList.toggle("hidden");
    b.textContent = open ? "▸" : "▾";
  }));
}
// Lazily load the Google Maps JS API (Places library) using the key saved in
// Settings. Resolves to the google namespace, or null when no key is configured.
// The promise is cached so the script is only ever injected once.
let _mapsPromise = null;
function ensureMapsApi() {
  const key = (typeof SETTINGS !== "undefined" && SETTINGS && SETTINGS.google_maps_api_key) || "";
  if (!key) return Promise.resolve(null);
  if (_mapsPromise) return _mapsPromise;
  _mapsPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps && window.google.maps.places) return resolve(window.google);
    window.__crmMapsReady = () => resolve(window.google);
    const sc = document.createElement("script");
    sc.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) +
             "&libraries=places&callback=__crmMapsReady";
    sc.async = true;
    sc.onerror = () => { _mapsPromise = null; reject(new Error("maps load failed")); };
    document.head.appendChild(sc);
  });
  return _mapsPromise;
}
// Attach Places search to a contract site-location input (no-op without a key).
function attachPlaces(input) {
  ensureMapsApi().then(g => {
    if (!g || input.dataset.ac) return;
    input.dataset.ac = "1";
    const ac = new g.maps.places.Autocomplete(input, { fields: ["formatted_address", "geometry", "name"] });
    ac.addListener("place_changed", () => {
      const p = ac.getPlace();
      if (p && p.geometry) input.dataset.latlng = p.geometry.location.lat() + "," + p.geometry.location.lng();
      if (p && !input.value && p.name) input.value = p.name;
    });
  }).catch(() => {});
}

// Who may be credited with bringing a contract in. The engineer list drives it;
// a contract already credited to somebody outside that list (a manager who
// sells, a colleague since moved to the office) keeps its name rather than
// silently losing the credit the moment anybody edits the contract.
function soldByOptions(c) {
  const opts = [{ v: "", l: t("mkt_nobody") }].concat(
    (cache.agents || []).map(a => ({ v: a.id, l: a.full_name })));
  if (c && c.sold_by && !opts.some(o => String(o.v) === String(c.sold_by))) {
    opts.push({ v: c.sold_by, l: c.sold_by_name || ("#" + c.sold_by) });
  }
  return opts;
}

function contractForm(c) {
  const isEdit = !!c; c = c || {};
  const clientOpts = cache.clients.map(x => ({ v: x.id, l: clientLabel(x) }));
  const svcOpts = [{ v: "", l: t("none") }].concat(cache.services.map(s => ({ v: s.id, l: localized(s, "name") })));
  const freqOpts = FREQS.map(f => ({ v: f, l: t("freq_" + f) }));
  const statusOpts = ["active", "paused", "ended"].map(s => ({ v: s, l: t("ct_" + s) }));
  openModal(isEdit ? t("edit") : t("new_contract"), `<form id="ctf"><div class="form-grid">
    ${field(t("client"), "client_id", { options: clientOpts, value: c.client_id, cls: "full" })}
    ${field(t("service"), "service_type_id", { options: svcOpts, value: c.service_type_id })}
    ${field(t("frequency"), "frequency", { options: freqOpts, value: c.frequency || "monthly" })}
    ${field(t("start_date"), "start_date", { type: "date", value: c.start_date })}
    ${field(t("end_date"), "end_date", { type: "date", value: c.end_date })}
    ${isEdit ? field(t("contract_status"), "status", { options: statusOpts, value: c.status }) : ""}
    ${field(t("mkt_brought_by"), "sold_by", { options: soldByOptions(c), value: c.sold_by || "" })}
    ${field(t("mkt_rate_override"), "commission_rate",
            { type: "number", value: c.commission_rate != null ? c.commission_rate : "",
              attrs: 'step="0.1" min="0" max="100" placeholder="' + esc(SETTINGS.commission_rate || "25") + '"' })}
    <div class="field full muted small">${t("mkt_brought_by_hint")}</div>
    ${field(t("notes"), "notes", { textarea: true, cls: "full", value: c.notes })}
    <div class="field full"><label class="muted small" style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="ct-auto" style="width:auto" ${c.auto_invoice ? "checked" : ""}> ${t("auto_bill")}</label>
      <div class="muted small">${t("auto_bill_hint")}</div></div>
    ${field(t("bill_every"), "bill_every", { options: [{ v: "", l: t("bill_same_as_service") }].concat(FREQS.map(f => ({ v: f, l: t("freq_" + f) }))), value: c.bill_every || "" })}
    ${field(t("next_bill_date"), "next_bill_date", { type: "date", value: c.next_bill_date })}
    </div>
    <div class="section-title" style="margin-top:14px"><h3>${t("sites_pricing")}</h3>
      <button type="button" class="btn sm" id="ct-add-site">+ ${t("add_site_row")}</button></div>
    <table class="table"><thead><tr>
      <th>${t("location_lbl")}</th><th>${t("map_location")}</th><th style="width:110px">${t("price")}</th><th></th>
    </tr></thead><tbody id="ct-sites-body"></tbody>
    <tfoot><tr><td colspan="2" style="text-align:right"><b>${t("total")}</b></td>
      <td><b id="ct-total">0</b></td><td></td></tr></tfoot></table>
    <div class="form-actions"><button type="button" class="btn secondary" id="ctf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    const clientSel = root.querySelector("[name=client_id]");
    const tbody = root.querySelector("#ct-sites-body");
    let clientSites = [];

    const siteOptionsHtml = (selected) =>
      [`<option value="">${esc(t("none"))}</option>`].concat(clientSites.map(s =>
        `<option value="${esc(s.id)}" ${String(s.id) === String(selected || "") ? "selected" : ""}>${esc(s.name)}</option>`)).join("");

    function recalc() {
      let tot = 0;
      tbody.querySelectorAll(".cs-price").forEach(i => { tot += parseFloat(i.value) || 0; });
      root.querySelector("#ct-total").textContent = tot.toFixed(2);
    }
    function addRow(row) {
      row = row || {};
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><select class="cs-site">${siteOptionsHtml(row.site_id)}</select></td>
         <td style="display:flex;gap:4px;align-items:center">
           <input class="cs-map" type="text" placeholder="https://maps.google.com/…" value="${esc(row.map_location || "")}" style="flex:1" />
           <button type="button" class="link-btn cs-open" title="${esc(t("open_map"))}">📍</button></td>
         <td><input class="cs-price" type="number" min="0" step="0.01" value="${esc(row.price != null ? row.price : 0)}" style="width:100px" /></td>
         <td><button type="button" class="link-btn danger sm cs-rm">${esc(t("delete"))}</button></td>`;
      tbody.appendChild(tr);
      const mapInput = tr.querySelector(".cs-map");
      tr.querySelector(".cs-rm").addEventListener("click", () => { tr.remove(); recalc(); });
      tr.querySelector(".cs-price").addEventListener("input", recalc);
      tr.querySelector(".cs-open").addEventListener("click", () => {
        const v = mapInput.value.trim();
        const q = mapInput.dataset.latlng || v;
        if (!q) return;
        const url = /^https?:\/\//i.test(q) ? q : "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
        window.open(url, "_blank", "noopener");
      });
      if (row.latlng) mapInput.dataset.latlng = row.latlng;
      attachPlaces(mapInput);   // Places search when a Maps API key is configured
      recalc();
    }
    async function loadSites(clientId) {
      clientSites = [];
      if (clientId) { try { const cl = await API.get("/clients/" + clientId); clientSites = cl.sites || []; } catch (e) {} }
      tbody.querySelectorAll(".cs-site").forEach(sel => { sel.innerHTML = siteOptionsHtml(sel.value); });
    }

    root.querySelector("#ct-add-site").addEventListener("click", () => addRow());
    clientSel.addEventListener("change", () => loadSites(clientSel.value));

    (async () => {
      await loadSites(clientSel.value);
      const existing = c.sites || [];
      if (existing.length) existing.forEach(addRow);
      else addRow();   // start with one empty row
    })();

    $("ctf-x").addEventListener("click", closeModal);
    root.querySelector("#ctf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      d.auto_invoice = root.querySelector("#ct-auto").checked ? 1 : 0;
      const credited = d.sold_by, rate = d.commission_rate;
      Object.keys(d).forEach(k => { if (d[k] === "") delete d[k]; });
      // Blank means "nobody" for these two, not "leave as it was" — otherwise
      // credit and a special rate could be given but never taken away.
      if (isEdit) { d.sold_by = credited || null; d.commission_rate = rate === "" ? null : rate; }
      d.sites = Array.from(tbody.querySelectorAll("tr")).map(tr => ({
        site_id: tr.querySelector(".cs-site").value || null,
        map_location: tr.querySelector(".cs-map").value.trim() || null,
        price: parseFloat(tr.querySelector(".cs-price").value) || 0,
      })).filter(r => r.site_id || r.map_location || r.price);
      try { const saved = isEdit ? await API.put("/contracts/" + c.id, d) : await API.post("/contracts", d);
        if (handledOffline(saved)) return;
        closeModal(); navigate("contracts"); } catch (err) { alert(err.message); }
    });
  });
}

// ====================================================================
// Marketing targets — what an engineer brings in, and what it adds to their pay
// ====================================================================
// An engineer who brings a customer in earns a share of that contract for as
// long as it runs, paid as an uplift on their salary. Suspend the contract or
// end it and the uplift goes with it. Nothing on this screen is stored as an
// earned amount: every figure is worked out from the contracts credited to the
// person and the state those contracts are in right now, so the "back to the
// original salary" rule needs nobody to remember to apply it.
//
// The month at the top is the TARGET period — what they were asked to bring in
// and what they actually signed in it. The commission and salary figures beside
// it are today's standing position, not that month's, because that is what the
// person is actually being paid.
let _mktPeriod = "";                       // "" = this month, per the server

function thisMonth() { return ymd(new Date()).slice(0, 7); }

function mktProgressBar(pct, on) {
  const w = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return `<span class="mkt-bar" title="${esc(String(Math.round(pct || 0)) + "%")}">
    <i class="${on ? "mkt-on" : (w >= 60 ? "mkt-near" : "mkt-off")}" style="width:${w}%"></i></span>`;
}

async function viewMarketing(v, arg) {
  // An engineer holds targets.view for their OWN number only, so the list
  // screen would be a one-row table about themselves — they get their file.
  const period = (arg && arg.period) || _mktPeriod || "";
  const d = await API.get("/marketing/targets" + (period ? "?period=" + encodeURIComponent(period) : ""));
  _mktPeriod = d.period;
  if (d.self_only) { await viewMarketingPerson(v, { id: API.user.id, period: d.period }); return; }
  const T = d.totals;
  const kpi = (val, label, sub) => `<div class="stat-card"><div class="sc-value">${val}</div>
    <div class="sc-label">${esc(label)}</div>${sub ? `<div class="sc-trend">${esc(sub)}</div>` : ""}</div>`;
  const row = (r) => `<tr data-person="${r.user_id}">
    <td><b>${esc(r.name || "—")}</b><div class="muted small">${esc(t("role_" + r.role))}</div></td>
    <td>${r.active_contracts}${r.lapsed_contracts
      ? ` <span class="muted small">(${r.lapsed_contracts} ${esc(t("mkt_stopped_lc"))})</span>` : ""}</td>
    <td>${money(r.active_value)}</td>
    <td><b>${money(r.commission)}</b></td>
    <td>${r.base_salary == null ? "—" : money(r.base_salary)}</td>
    <td>${r.effective_salary == null ? "—" : `${money(r.effective_salary)}${
      r.uplift_pct ? ` <span class="mkt-up">+${r.uplift_pct}%</span>` : ""}`}</td>
    <td>${r.target_amount ? money(r.target_amount) : `<span class="muted">${esc(t("mkt_no_target"))}</span>`}</td>
    <td>${r.target_amount ? `${mktProgressBar(r.progress, r.on_target)}
      <span class="muted small">${money(r.won_value)} · ${Math.round(r.progress || 0)}%</span>`
      : `<span class="muted small">${money(r.won_value)}</span>`}</td>
    ${d.can_edit ? `<td><button class="link-btn sm mkt-set" data-id="${r.user_id}"
      data-name="${esc(r.name || "")}">${esc(t("mkt_set_target"))}</button></td>` : ""}</tr>`;

  v.innerHTML = `<div class="page-head"><h2>${t("nav_marketing")}</h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="month" id="mkt-period" class="toolbar-select" value="${esc(d.period)}">
        <span class="mkt-rate">${esc(t("mkt_rate"))}: <b>${d.rate}%</b></span>
      </div></div>
    <p class="muted small">${t("mkt_hint")}</p>
    <div class="cockpit-kpis">
      ${kpi(money(T.commission), t("mkt_commission_total"), t("mkt_per_month"))}
      ${kpi(String(T.active_contracts), t("mkt_live_contracts"), money(T.active_value) + " " + t("mkt_per_month"))}
      ${kpi(money(T.won_value), t("mkt_brought_this_month"), T.target_amount ? t("mkt_of_target").replace("{v}", money(T.target_amount)) : "")}
      ${kpi(`${T.on_target}/${T.people}`, t("mkt_on_target"), "")}
      ${kpi(money(T.lapsed_commission), t("mkt_lapsed_commission"), t("mkt_lapsed_hint_short"))}
    </div>
    <div class="panel"><table class="table"><thead><tr>
      <th>${t("engineer")}</th><th>${t("mkt_live_contracts")}</th><th>${t("mkt_value_month")}</th>
      <th>${t("mkt_commission")}</th><th>${t("mkt_base_salary")}</th><th>${t("mkt_effective")}</th>
      <th>${t("mkt_target")}</th><th>${t("mkt_progress")}</th>${d.can_edit ? "<th></th>" : ""}
    </tr></thead><tbody>${d.rows.map(row).join("") ||
      `<tr><td colspan="9" class="muted">${t("mkt_no_people")}</td></tr>`}</tbody></table></div>
    ${d.can_edit ? mktUnattributed(d.unattributed || []) : ""}
    <p class="muted small">${t("mkt_not_payroll")}</p>`;

  $("mkt-period").addEventListener("change", (e) => {
    _mktPeriod = e.target.value || thisMonth();
    navigate("marketing", { period: _mktPeriod });
  });
  v.querySelectorAll("[data-person]").forEach(tr => tr.addEventListener("click", (e) => {
    if (e.target.closest(".mkt-set")) return;
    navigate("marketing-person", { id: tr.dataset.person, period: d.period });
  }));
  v.querySelectorAll(".mkt-set").forEach(b => b.addEventListener("click", () =>
    targetForm({ user_id: b.dataset.id, name: b.dataset.name, period: d.period })));
  v.querySelectorAll(".mkt-credit").forEach(b => b.addEventListener("click", () =>
    creditDialog(Number(b.dataset.id), b.dataset.client)));
}

// Work nobody has been credited with. Left alone it is a decision the office
// never made — and a person who is not being paid for what they brought in.
function mktUnattributed(list) {
  if (!list.length) return "";
  return `<div class="panel"><div class="section-title"><h3>${t("mkt_unattributed")}</h3></div>
    <p class="muted small">${t("mkt_unattributed_hint")}</p>
    <table class="table"><thead><tr><th>${t("client")}</th><th>${t("start_date")}</th>
      <th>${t("mkt_value_month")}</th><th></th></tr></thead><tbody>
    ${list.map(c => `<tr><td>${esc(localized(c, "client"))}</td><td>${fmtDate(c.start_date)}</td>
      <td>${money(c.value_month)}</td>
      <td><button class="link-btn sm mkt-credit" data-id="${c.id}"
        data-client="${esc(localized(c, "client"))}">${esc(t("mkt_credit_to"))}</button></td></tr>`).join("")}
    </tbody></table></div>`;
}

// One person's file: every contract they are credited with, what each pays
// them now, and what the stopped ones would still be paying.
async function viewMarketingPerson(v, arg) {
  const id = arg && arg.id;
  const period = (arg && arg.period) || _mktPeriod || "";
  const d = await API.get(`/marketing/person/${id}` + (period ? "?period=" + encodeURIComponent(period) : ""));
  const p = d.person;
  const kpi = (val, label, sub) => `<div class="stat-card"><div class="sc-value">${val}</div>
    <div class="sc-label">${esc(label)}</div>${sub ? `<div class="sc-trend">${esc(sub)}</div>` : ""}</div>`;
  const ctRow = (c) => `<tr class="${c.commission ? "" : "mkt-dead"}">
    <td>${esc(localized(c, "client"))}</td>
    <td><span class="badge b-${c.status === "active" ? "active" : (c.status === "paused" ? "paused" : "ended")}">${esc(t("ct_" + c.status))}</span></td>
    <td>${esc(t("freq_" + c.frequency))}</td>
    <td>${money(c.price)}</td>
    <td>${money(c.value_month)}</td>
    <td>${c.rate}%</td>
    <td>${c.commission ? `<b>${money(c.commission)}</b>`
      : `<span class="muted">${money(0)}</span> <span class="muted small">(${esc(t("mkt_would_pay"))} ${money(c.commission_if_active)})</span>`}</td>
    <td>${fmtDate(c.start_date)}${c.end_date ? ` → ${fmtDate(c.end_date)}` : ""}</td></tr>`;

  v.innerHTML = `<div class="page-head"><h2>${esc(p.name || "")}</h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="month" id="mktp-period" class="toolbar-select" value="${esc(d.period)}">
        ${d.can_edit ? `<button class="btn sm" id="mktp-target">${esc(t("mkt_set_target"))}</button>` : ""}
      </div></div>
    <p class="muted small">${t("mkt_person_hint")}</p>
    <div class="cockpit-kpis">
      ${kpi(p.base_salary == null ? "—" : money(p.base_salary), t("mkt_base_salary"), t("mkt_per_month"))}
      ${kpi(money(p.commission), t("mkt_commission"), t("mkt_from_n_contracts").replace("{n}", p.active_contracts))}
      ${kpi(p.effective_salary == null ? "—" : money(p.effective_salary), t("mkt_effective"),
            p.uplift_pct ? "+" + p.uplift_pct + "%" : "")}
      ${kpi(p.target_amount ? money(p.target_amount) : "—", t("mkt_target"),
            p.target_amount ? Math.round(p.progress || 0) + "%" : t("mkt_no_target"))}
    </div>
    ${p.target_amount ? `<div class="panel mkt-target-panel">
      <div class="mkt-target-head"><strong>${esc(t("mkt_progress"))}</strong>
        <span class="muted small">${money(p.won_value)} / ${money(p.target_amount)} ·
          ${p.won_contracts}${p.target_contracts ? "/" + p.target_contracts : ""} ${esc(t("mkt_contracts_lc"))}</span></div>
      ${mktProgressBar(p.progress, p.on_target)}
      ${p.target_note ? `<p class="muted small">${esc(p.target_note)}</p>` : ""}</div>` : ""}
    ${p.lapsed_contracts ? `<div class="panel warn-line">${t("mkt_lapsed_line")
      .replace("{n}", p.lapsed_contracts).replace("{v}", money(p.lapsed_commission))}</div>` : ""}
    <div class="panel"><div class="section-title"><h3>${t("mkt_contracts_credited")}</h3></div>
      <table class="table"><thead><tr>
        <th>${t("client")}</th><th>${t("status")}</th><th>${t("frequency")}</th>
        <th>${t("mkt_cycle_price")}</th><th>${t("mkt_value_month")}</th><th>${t("mkt_rate")}</th>
        <th>${t("mkt_commission")}</th><th>${t("mkt_running")}</th>
      </tr></thead><tbody>${d.contracts.map(ctRow).join("") ||
        `<tr><td colspan="8" class="muted">${t("mkt_no_contracts")}</td></tr>`}</tbody></table></div>
    ${d.targets.length ? `<div class="panel"><div class="section-title"><h3>${t("mkt_target_history")}</h3></div>
      <table class="table"><thead><tr><th>${t("mkt_month")}</th><th>${t("mkt_target")}</th>
        <th>${t("mkt_target_contracts")}</th><th>${t("notes")}</th>${d.can_edit ? "<th></th>" : ""}</tr></thead>
      <tbody>${d.targets.map(x => `<tr><td>${esc(x.period)}</td><td>${money(x.target_amount)}</td>
        <td>${x.target_contracts || "—"}</td><td>${esc(x.note || "")}</td>
        ${d.can_edit ? `<td><button class="link-btn danger sm mkt-del" data-id="${x.id}">${esc(t("delete"))}</button></td>` : ""}</tr>`).join("")}
      </tbody></table></div>` : ""}
    <p class="muted small">${t("mkt_not_payroll")}</p>`;

  $("mktp-period").addEventListener("change", (e) =>
    navigate("marketing-person", { id, period: e.target.value || thisMonth() }));
  if ($("mktp-target")) $("mktp-target").addEventListener("click", () =>
    targetForm({ user_id: id, name: p.name, period: d.period, amount: p.target_amount,
                 count: p.target_contracts, note: p.target_note }));
  v.querySelectorAll(".mkt-del").forEach(b => b.addEventListener("click", async () => {
    if (!confirm(t("confirm_delete"))) return;
    try { await API.del("/marketing/targets/" + b.dataset.id); toast(t("deleted")); reNavigate(); }
    catch (err) { alert(err.message); }
  }));
}

// What one person is asked to bring in for one month. Sending it twice edits
// the same row, so a target is corrected rather than duplicated.
function targetForm(o) {
  openModal(t("mkt_set_target"), `<form id="tgf"><div class="form-grid">
    <div class="field full"><label>${esc(t("engineer"))}</label>
      <input type="text" value="${esc(o.name || "")}" disabled></div>
    ${field(t("mkt_month"), "period", { type: "month", value: o.period || thisMonth(), attrs: "required" })}
    ${field(t("mkt_target_amount"), "target_amount",
            { type: "number", value: o.amount || "", attrs: 'step="0.01" min="0"' })}
    ${field(t("mkt_target_contracts"), "target_contracts",
            { type: "number", value: o.count || "", attrs: 'step="1" min="0"' })}
    ${field(t("notes"), "note", { value: o.note || "", textarea: true, cls: "full" })}
    <div class="field full muted small">${t("mkt_target_hint")}</div>
    </div><div class="form-actions">
      <button type="button" class="btn secondary" id="tgf-x">${t("cancel")}</button>
      <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("tgf-x").addEventListener("click", closeModal);
    root.querySelector("#tgf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const b = formData(root);
      b.user_id = o.user_id;
      try {
        const saved = await API.post("/marketing/targets", b);
        if (handledOffline(saved)) return;
        closeModal(); toast(t("saved")); reNavigate();
      } catch (err) { alert(err.message); }
    });
  });
}

// Credit a contract to whoever brought it in, from the marketing page — no
// need to open (and risk changing) the contract itself.
function creditDialog(contractId, clientName) {
  const opts = [{ v: "", l: t("mkt_nobody") }].concat(
    (cache.agents || []).map(a => ({ v: a.id, l: a.full_name })));
  openModal(t("mkt_credit_to"), `<form id="crf"><div class="form-grid">
    <div class="field full"><label>${esc(t("client"))}</label>
      <input type="text" value="${esc(clientName || "")}" disabled></div>
    ${field(t("mkt_brought_by"), "user_id", { options: opts, cls: "full" })}
    ${field(t("mkt_rate_override"), "commission_rate",
            { type: "number", attrs: 'step="0.1" min="0" max="100"' })}
    <div class="field full muted small">${t("mkt_rate_override_hint")}</div>
    </div><div class="form-actions">
      <button type="button" class="btn secondary" id="crf-x">${t("cancel")}</button>
      <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("crf-x").addEventListener("click", closeModal);
    root.querySelector("#crf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const b = formData(root);
      b.contract_id = contractId;
      try {
        const saved = await API.post("/marketing/attribute", b);
        if (handledOffline(saved)) return;
        closeModal(); toast(t("saved")); reNavigate();
      } catch (err) { alert(err.message); }
    });
  });
}

// ====================================================================
// Analytics
// ====================================================================
function bar(label, value, max, color) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return `<div class="bar-row"><div class="bar-label">${esc(label)}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color || "var(--green)"}"></div></div>
    <div class="bar-val">${typeof value === "number" && value % 1 ? money(value) : value}</div></div>`;
}
// Date-range presets for the company analytics page. Returns {from,to} ISO.
function anRange(preset) {
  const today = new Date();
  const iso = ymd;                 // local calendar date — see ymd()
  const to = iso(today);
  const back = (fn) => { const d = new Date(today); fn(d); return iso(d); };
  if (preset === "month") return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to };
  if (preset === "quarter") return { from: back(d => d.setMonth(d.getMonth() - 3)), to };
  if (preset === "all") return { from: "2000-01-01", to };
  return { from: back(d => d.setFullYear(d.getFullYear() - 1)), to };   // "year" (default)
}
let _anPreset = "year";
let _anClient = "";
let _anSite = "";

async function viewAnalytics(v) {
  const presets = [["month", t("range_month")], ["quarter", t("range_quarter")],
    ["year", t("range_year")], ["all", t("range_all")]];
  const clientOpts = [{ v: "", l: t("all_clients") }].concat(
    (cache.clients || []).map(c => ({ v: c.id, l: clientLabel(c) })));
  v.innerHTML = `<div class="page-head"><h2>${t("analytics_title")}</h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="an-client" class="toolbar-select">${clientOpts.map(o =>
          `<option value="${esc(o.v)}"${String(o.v) === String(_anClient) ? " selected" : ""}>${esc(o.l)}</option>`).join("")}</select>
        <select id="an-site" class="toolbar-select"><option value="">${t("all_locations")}</option></select>
        <select id="an-range" class="toolbar-select">${presets.map(([k, l]) =>
          `<option value="${k}"${k === _anPreset ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <button class="btn sm secondary" id="an-csv">⬇️ ${t("export_csv")}</button>
        <button class="btn sm" id="an-pdf">🖨️ ${t("export_pdf")}</button></div></div>
    <div id="an-body">${t("loading")}</div>`;
  const syncSite = () => { $("an-site").disabled = !_anClient; };
  const render = async () => {
    const { from, to } = anRange(_anPreset);
    let url = `/analytics?from=${from}&to=${to}`;
    if (_anClient) url += `&client_id=${_anClient}`;
    if (_anSite) url += `&site_id=${encodeURIComponent(_anSite)}`;
    const [a, crew, cts] = await Promise.all([
      API.get(url),
      // The scorecard is built on what each engineer COSTS, so it travels with
      // the rest of the money. Not asking for it beats a 403 the page swallows.
      can("invoices.view")
        ? API.get(`/engineers/scorecard?from=${from}&to=${to}`).catch(() => ({ engineers: [] }))
        : Promise.resolve({ engineers: [] }),
      can("invoices.view")
        ? API.get(`/cost-to-serve?from=${from}&to=${to}`).catch(() => null)
        : Promise.resolve(null)]);
    a.crew = crew;
    a.cost_to_serve = cts;
    const parts = analyticsParts(a);
    $("an-body").innerHTML = parts.html;
    $("an-body").querySelectorAll("[data-nav]").forEach(el =>
      el.addEventListener("click", () => navigate(el.dataset.nav)));
    $("an-body").querySelectorAll("[data-visit]").forEach(tr =>
      tr.addEventListener("click", () => navigate("visit", { id: tr.dataset.visit })));
    $("an-pdf").onclick = () => analyticsReportDoc(t("analytics_title"),
      `${fmtDate(a.range.from)} → ${fmtDate(a.range.to)}`, parts.html);
    $("an-csv").onclick = () => exportAnalyticsCsv(a);
  };
  // preload sites for a remembered client selection
  if (_anClient) await loadSiteOptions(_anClient, $("an-site"), _anSite, t("all_locations"));
  syncSite();
  $("an-client").addEventListener("change", async (e) => {
    _anClient = e.target.value; _anSite = "";
    await loadSiteOptions(_anClient, $("an-site"), "", t("all_locations"));
    syncSite(); render();
  });
  $("an-site").addEventListener("change", (e) => { _anSite = e.target.value; render(); });
  $("an-range").addEventListener("change", (e) => { _anPreset = e.target.value; render(); });
  await render();
}

// Build all analytics panels from the payload. Returns { html }.
function analyticsParts(a) {
  const T = a.totals, F = a.fleet || { kpi: {}, months: [], top_clients: [], replaced: {} };
  const empty = `<div class="empty">${t("none")}</div>`;
  const card = (val, label, icon, cls, nav) =>
    `<div class="stat-card ${cls}"${nav ? ` data-nav="${nav}" style="cursor:pointer"` : ""}><div class="sc-ic">${icon}</div><div><div class="v">${val}</div><div class="l">${esc(label)}</div></div></div>`;
  const barList = (rows, fn, nav) => rows.length
    ? `<div${nav ? ` data-nav="${nav}" style="cursor:pointer"` : ""}>${rows.map(fn).join("")}</div>` : empty;
  const maxAge = Math.max(1, ...a.ar_aging.map(x => x.due || 0));
  const maxAgent = Math.max(1, ...a.agents.map(x => x.total || 0));
  const agingLabels = { current: t("bucket_current"), "1-30": t("bucket_1_30"), "31-60": t("bucket_31_60"), "60+": t("bucket_60") };
  const labels = a.months.map(m => monthShort(m.m));
  // finance + operations cards
  const cards = `<div class="cards">
      ${card(money(T.revenue), t("total_revenue"), "💰", "c-green")}
      ${card(money(T.invoiced), t("total_invoiced"), "🧾", "c-blue")}
      ${card(T.collection_rate + "%", t("collection_rate"), "📥", T.collection_rate < 70 ? "warn" : "c-teal")}
      ${card(money(T.revenue_per_visit), t("revenue_per_visit"), "🧮", "c-purple")}
      ${card(`${T.visits_completed}/${T.visits_total}`, t("visits_completed"), "✅", "c-teal")}
      ${card(T.completion_rate + "%", t("completion_rate"), "🎯", T.completion_rate < 70 ? "warn" : "c-green")}
      ${card(T.sla_overdue, t("dash_sla_overdue"), "⏰", T.sla_overdue > 0 ? "danger" : "c-green", "schedule")}
      ${card(T.active_contracts, t("active_contracts"), "🔁", "c-blue")}</div>`;
  const revenue = a.months.some(m => m.total || m.paid)
    ? curveChart(labels, [
        { name: t("total_invoiced"), color: "#2563eb", values: a.months.map(m => m.total || 0) },
        { name: t("paid"), color: "#16a34a", values: a.months.map(m => m.paid || 0) }]) : empty;
  const aging = barList(a.ar_aging, x =>
    bar(agingLabels[x.bucket] || x.bucket, x.due || 0, maxAge, x.bucket === "60+" ? "var(--red)" : "var(--amber)"), "invoices");
  const agents = barList(a.agents, x =>
    bar(x.full_name + ` (${x.completed}/${x.total})`, x.total || 0, maxAgent), "agents");
  const chemItems = a.chemicals.map((x, i) => ({ label: localized(x, "name") + ` (${x.unit})`, value: Math.round((x.used || 0) * 10) / 10, color: PALETTE[i % PALETTE.length] }));
  const svcItems = a.services.map((x, i) => ({ label: localized(x, "name"), value: x.cnt, color: PALETTE[(i + 2) % PALETTE.length] }));
  // fleet & pest
  const K = F.kpi;
  const fleetCards = `<div class="cards">
      ${card(K.devices || 0, t("total_devices"), "📍", "c-blue")}
      ${card(K.coverage != null ? K.coverage + "%" : "—", t("coverage_month"), "✅", (K.coverage != null && K.coverage < 60) ? "warn" : "c-green", "devices")}
      ${card(K.needs_service || 0, t("mst_needs_service"), "🛠️", K.needs_service > 0 ? "warn" : "c-green", "devices")}
      ${card(K.activity || 0, t("activity_detections"), "🐭", K.activity > 0 ? "danger" : "c-green")}</div>`;
  const hasFly = F.months.some(m => m.fly != null), hasBait = F.months.some(m => m.bait_pct != null);
  const activityCurve = F.months.some(m => m.inspections || m.detections)
    ? curveChart(labels, [
        { name: t("inspections"), color: "#2563eb", values: F.months.map(m => m.inspections) },
        { name: t("detections"), color: "#dc2626", values: F.months.map(m => m.detections) }]) : empty;
  const pressure = (hasFly || hasBait) ? curveChart(labels, [
      ...(hasFly ? [{ name: t("avg_fly"), color: "#7c3aed", values: F.months.map(m => m.fly || 0) }] : []),
      ...(hasBait ? [{ name: t("bait_consumption"), color: "#d97706", values: F.months.map(m => m.bait_pct || 0) }] : [])]) : "";
  // service-coverage-over-time trend (% of fleet scanned each month)
  const coverageCurve = F.months.some(m => m.coverage) ? curveChart(labels, [
      { name: t("service_coverage"), color: "#16a34a", values: F.months.map(m => m.coverage || 0) }]) : "";
  // devices overdue for a scan (never / not in N days)
  const stale = F.stale || [];
  const staleTable = stale.length ? `<table><thead><tr><th>${t("code")}</th><th>${t("marker_type")}</th>
      <th>${t("client")}</th><th>${t("location_lbl")}</th><th>${t("last_scanned")}</th></tr></thead><tbody>${stale.map(x => `<tr>
      <td><strong>${esc(x.code)}</strong></td><td>${esc(t("dt_" + x.type))}</td>
      <td>${esc(localized(x, "client") || "—")}</td><td>${esc(x.loc || x.site_name || "—")}</td>
      <td>${x.last_seen ? fmtDate(x.last_seen) : `<span class="warn-line">${t("never_scanned")}</span>`}</td></tr>`).join("")}</tbody></table>` : "";
  const maxTop = Math.max(1, ...F.top_clients.map(x => x.detections || 0));
  const topClients = barList(F.top_clients, x => bar(localized(x, "name"), x.detections || 0, maxTop, "var(--red)"));
  const rep = F.replaced || {};
  const repItems = [["baits", "baits_count"], ["lamps", "lamps_used"], ["sheets", "light_sheets_used"],
    ["glue_boards", "glo_pieces"], ["traps", "an_traps_replaced"],
    ["transformers", "transformers_used"], ["stations", "an_stations_replaced"]]
    .filter(([k]) => (rep[k] || 0) > 0).map(([k, tk], i) => ({ label: t(tk), value: rep[k], color: PALETTE[i % PALETTE.length] }));
  // --- what the scans found, what was done, what was left for next time ----
  const faults = F.faults || [], pests = F.pests || [], byType = F.by_type || [];
  const acts = F.actions || { done: 0, deferred: 0 };
  const deferred = F.deferred_list || [];
  const maxFault = Math.max(1, ...faults.map(x => x.count));
  // Red is for the fault that dominates the range; the rest sit amber, so the
  // chart says which one to fix first instead of shouting about all of them.
  const faultBars = barList(faults, x =>
    bar(t("flt_" + x.key), x.count, maxFault, x.count === maxFault ? "var(--red)" : "var(--amber)"));
  // The catch, split the way the traps are: flying off the light traps,
  // crawling off the glue stations.
  const pestItems = (keys, i0) => pests.filter(p => keys.includes(p.key))
    .map((p, i) => ({ label: t("df_opt_" + p.key), value: p.count, color: PALETTE[(i + i0) % PALETTE.length] }));
  const flying = pestItems(LIGHT_TRAP_PESTS, 0), crawling = pestItems(GLUE_STATION_PESTS, 3);
  const typeTable = byType.length ? `<table><thead><tr><th>${t("marker_type")}</th>
      <th class="num">${t("devices_scanned")}</th><th class="num">${t("inspections")}</th>
      <th class="num">${t("detections")}</th><th class="num">${t("detection_rate")}</th></tr></thead>
      <tbody>${byType.map(x => `<tr><td>${esc(t("dt_" + x.type))}</td>
        <td class="num">${x.devices}</td><td class="num">${x.scans}</td>
        <td class="num">${x.detections}</td>
        <td class="num">${x.scans ? Math.round(x.detections * 100 / x.scans) + "%" : "—"}</td></tr>`).join("")}</tbody></table>` : empty;
  const deferTable = deferred.length ? `<table><thead><tr><th>${t("code")}</th>
      <th>${t("marker_type")}</th><th>${t("client")}</th><th>${t("an_outstanding_item")}</th>
      <th>${t("date")}</th></tr></thead><tbody>${deferred.map(x => `<tr>
      <td><strong>${esc(x.code)}</strong></td><td>${esc(t("dt_" + x.type))}</td>
      <td>${esc(localized(x, "name") || "—")}</td>
      <td>${esc(t("df_" + x.field))}: ${esc(t("df_opt_" + x.action))}</td>
      <td>${fmtDate(x.at)}</td></tr>`).join("")}</tbody></table>` : empty;
  // --- chemicals: how they were applied ------------------------------------
  const app = a.application || { methods: [], equipment: [] };
  const methodItems = (app.methods || []).map((x, i) =>
    ({ label: t("am_" + x.k), value: x.cnt, color: PALETTE[i % PALETTE.length] }));
  const equipItems = (app.equipment || []).map((x, i) =>
    ({ label: t("aq_" + x.k), value: x.cnt, color: PALETTE[(i + 4) % PALETTE.length] }));
  // --- the reports themselves ----------------------------------------------
  const R = a.reports || { severity: [], status: [], conditions: [], recommendations: [] };
  const sevColor = { low: "#16a34a", medium: "#d97706", high: "#e0541b", critical: "#dc2626" };
  const sevItems = (R.severity || []).map(x =>
    ({ label: t("sev_" + x.k), value: x.cnt, color: sevColor[x.k] || "#64748b" }));
  const repDone = (R.status || []).find(x => x.k === "complete");
  const repDraft = (R.status || []).find(x => x.k === "draft");
  const wording = (rows) => rows && rows.length
    ? `<div>${rows.map(x => bar(x.text, x.count, Math.max(1, ...rows.map(y => y.count)))).join("")}</div>` : empty;
  const reportCards = `<div class="cards">
      ${card(repDone ? repDone.cnt : 0, t("report_complete"), "✅", "c-green", "reports")}
      ${card(repDraft ? repDraft.cnt : 0, t("report_draft"), "📝", (repDraft && repDraft.cnt) ? "warn" : "c-blue", "reports")}
      ${card(R.signed || 0, t("customer_sig"), "✍️", "c-teal")}
      ${card(acts.deferred || 0, t("an_deferred"), "📌", acts.deferred ? "warn" : "c-green")}</div>`;
  // --- what the work cost: product, travel and cash out of a pocket --------
  const SP = a.spend || { clients: [], visits: [], months: [], pocket: { engineers: [], categories: [] } };
  const P = SP.pocket || { engineers: [], categories: [] };
  const maxCash = Math.max(1, ...P.engineers.map(x => x.spent || 0));
  const cashBars = barList(P.engineers, x => bar(
    `${x.agent_name} (${x.claims || 0})`, x.spent || 0, maxCash), "cash");
  const catItems = (P.categories || []).map((x, i) =>
    ({ label: t("cat_" + x.k), value: Math.round((x.amount || 0) * 100) / 100,
       color: PALETTE[i % PALETTE.length] }));
  const spendCurve = (SP.months || []).some(m => m.chemicals || m.transport || m.cash)
    ? curveChart(labels, [
        { name: t("chemical_usage"), color: "#2563eb", values: SP.months.map(m => m.chemicals) },
        { name: t("nav_transport"), color: "#d97706", values: SP.months.map(m => m.transport) },
        { name: t("nav_cash"), color: "#7c3aed", values: SP.months.map(m => m.cash) }]) : empty;
  const clientSpend = (SP.clients || []).length ? `<table><thead><tr><th>${t("client")}</th>
      <th class="num">${t("total_visits")}</th><th class="num">${t("chemical_usage")}</th>
      <th class="num">${t("nav_transport")}</th><th class="num">${t("nav_cash")}</th>
      <th class="num">${t("total")}</th><th class="num">${t("sp_per_visit")}</th></tr></thead>
      <tbody>${SP.clients.map(c => `<tr>
        <td>${esc(localized(c, "name"))}</td><td class="num">${c.visits}</td>
        <td class="num">${money(c.chemicals)}</td><td class="num">${money(c.transport)}</td>
        <td class="num">${money(c.cash)}</td><td class="num"><strong>${money(c.total)}</strong></td>
        <td class="num">${money(c.per_visit)}</td></tr>`).join("")}</tbody></table>` : empty;
  const visitSpend = (SP.visits || []).length ? `<table><thead><tr><th>${t("visit")}</th>
      <th>${t("date")}</th><th>${t("client")}</th><th>${t("agent")}</th>
      <th class="num">${t("chemical_usage")}</th><th class="num">${t("nav_transport")}</th>
      <th class="num">${t("nav_cash")}</th><th class="num">${t("total")}</th></tr></thead>
      <tbody>${SP.visits.map(x => `<tr class="clickable" data-visit="${x.id}">
        <td><strong>#${String(x.id).padStart(5, "0")}</strong></td>
        <td>${fmtDate(x.scheduled_start)}</td><td>${esc(localized(x, "name"))}</td>
        <td>${esc(x.agent_name || "—")}</td>
        <td class="num">${money(x.chemicals)}</td><td class="num">${money(x.transport)}</td>
        <td class="num">${money(x.cash)}</td>
        <td class="num"><strong>${money(x.total)}</strong></td></tr>`).join("")}</tbody></table>` : empty;
  const showFleet = (K.devices || 0) > 0;
  // The money half of this page belongs to whoever holds the ledger. A team
  // supervisor gets the same screen with the revenue and debtor panels left out —
  // the server sends them empty, and an empty chart is not an answer.
  const showMoney = can("invoices.view");
  const html = `${cards}
    <div class="grid-2">
      ${showMoney ? `<div class="panel"><h3>📈 ${t("monthly_revenue")}</h3>${revenue}</div>
      <div class="panel"><h3>${t("ar_aging")}</h3>${aging}</div>` : ""}
      <div class="panel"><h3>${t("agent_productivity")}</h3>${agents}</div>
      <div class="panel"><h3>${t("service_mix")}</h3>${svcItems.length ? cols3d(svcItems) : empty}</div>
      <div class="panel"><h3>${t("chemical_usage")}</h3>${chemItems.length ? cols3d(chemItems) : empty}</div>
    </div>
    <div class="section-title" style="margin-top:8px"><h2>📝 ${t("nav_reports")}</h2></div>
    ${reportCards}
    <div class="grid-2">
      <div class="panel"><h3>🚦 ${t("severity")}</h3>${sevItems.length ? cols3d(sevItems) : empty}</div>
      <div class="panel"><h3>🧪 ${t("application_method")}</h3>${methodItems.length ? cols3d(methodItems) : empty}</div>
      <div class="panel"><h3>🛠️ ${t("application_equipment")}</h3>${equipItems.length ? cols3d(equipItems) : empty}</div>
      <div class="panel"><h3>📋 ${t("conditions")}</h3>${wording(R.conditions)}</div>
      <div class="panel"><h3>✅ ${t("recommendations")}</h3>${wording(R.recommendations)}</div>
    </div>
    ${showMoney ? `<div class="section-title" style="margin-top:8px"><h2>💸 ${t("sp_title")}</h2></div>
    <p class="muted small" style="margin:-6px 0 10px">${t("sp_hint")}</p>
    <div class="grid-2">
      <div class="panel"><h3>📈 ${t("sp_monthly")}</h3>${spendCurve}</div>
      <div class="panel"><h3>👛 ${t("sp_by_engineer")}</h3>${cashBars}</div>
      <div class="panel"><h3>🧾 ${t("sp_cash_categories")}</h3>${catItems.length ? cols3d(catItems) : empty}</div>
    </div>
    <div class="panel"><h3>🏢 ${t("sp_by_client")}</h3>${clientSpend}</div>
    ${crewTable(a.crew)}
    ${costToServeTable(a.cost_to_serve)}
    <div class="panel"><h3>🧮 ${t("sp_by_visit")}</h3>
      <div class="muted small" style="margin:-4px 0 8px">${t("sp_by_visit_hint")}</div>
      ${visitSpend}</div>` : ""}
    ${showFleet ? `<div class="section-title" style="margin-top:8px"><h2>🏷️ ${t("nav_devices")} — ${t("pest_trends")}</h2></div>
      ${fleetCards}
      <div class="grid-2">
        <div class="panel"><h3>📈 ${t("pest_trends")}</h3>${activityCurve}</div>
        <div class="panel"><h3>✅ ${t("service_coverage")}</h3>${coverageCurve || empty}</div>
      </div>
      ${pressure ? `<div class="panel"><h3>🪰 ${t("pest_pressure")}</h3>${pressure}</div>` : ""}
      <div class="grid-2">
        <div class="panel"><h3>🔥 ${t("top_clients_activity")}</h3>${topClients}</div>
        ${repItems.length ? `<div class="panel"><h3>🔧 ${t("consumables_replaced")}</h3>${cols3d(repItems)}</div>` : ""}
      </div>
      <div class="grid-2">
        <div class="panel"><h3>🪳 ${t("an_pests_flying")}</h3>${flying.length ? cols3d(flying) : empty}</div>
        <div class="panel"><h3>🐀 ${t("an_pests_crawling")}</h3>${crawling.length ? cols3d(crawling) : empty}</div>
        <div class="panel"><h3>⚠️ ${t("an_faults")}</h3>${faultBars}</div>
        <div class="panel"><h3>🏷️ ${t("an_by_type")}</h3>${typeTable}</div>
      </div>
      <div class="panel"><div class="section-title">
          <h3>📌 ${t("an_outstanding")}</h3>
          <span class="badge b-${acts.deferred ? "draft" : "completed"}">${acts.done}/${acts.done + acts.deferred}</span></div>
        <div class="muted small" style="margin:-4px 0 8px">${t("an_outstanding_hint")}</div>
        ${deferTable}</div>
      ${F.stale_count ? `<div class="panel" data-nav="devices" style="cursor:pointer">
        <h3 style="display:flex;justify-content:space-between;align-items:center">
          <span>⏰ ${t("overdue_devices")}</span><span class="badge b-draft">${F.stale_count}</span></h3>
        <div class="muted small" style="margin:-4px 0 8px">${t("overdue_devices_hint").replace("{n}", F.stale_days)}</div>
        ${staleTable}</div>` : ""}` : ""}`;
  return { html };
}

// What each customer costs to service, against what they pay. Every figure was
// already being collected — hours from check-in stamps, materials at their real
// unit cost, transport and pocket money from the field — and none of it had ever
// been put beside the invoice. Overheads are deliberately NOT allocated: this
// answers "who takes more to serve than they pay", not "what is our profit".
function costToServeTable(d) {
  if (!d || !(d.rows || []).length) return "";
  const rows = d.rows.slice(0, 25);
  const money0 = (n) => money(n);
  return `<div class="panel"><div class="section-title"><h3>${t("cost_to_serve")}</h3>
      <span class="muted small">${d.totals.rate_set
        ? t("cts_rate").replace("{r}", money(d.hourly_rate))
        : `⚠️ ${t("cts_no_rate")}`}</span></div>
    ${d.totals.losing ? `<div class="warn-line">⚠️ ${
      t("cts_losing").replace("{n}", d.totals.losing)}</div>` : ""}
    <table><thead><tr><th>${t("client")}</th><th>${t("site_name")}</th>
      <th class="num">${t("visits_lc")}</th><th class="num">${t("hours")}</th>
      <th class="num">${t("cts_cost")}</th><th class="num">${t("cts_revenue")}</th>
      <th class="num">${t("cts_margin")}</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${esc(localized(r, "client"))}</td>
      <td>${esc(r.site_name || "—")}</td>
      <td class="num">${r.visits}</td><td class="num">${r.hours.toFixed(1)}</td>
      <td class="num">${money0(r.cost)}</td><td class="num">${money0(r.revenue)}</td>
      <td class="num ${r.margin < 0 ? "neg" : ""}">${money0(r.margin)}</td></tr>`).join("")}
    </tbody></table>
    <p class="muted small">${t("cts_hint")}</p></div>`;
}

// One row per engineer, answering the question a manager actually asks. Every
// figure here lives somewhere else in the CRM already; the value is having them
// on one line, where "more visits" and "more deferred work" can be seen to be
// the same engineer.
function crewTable(crew) {
  const rows = (crew && crew.engineers) || [];
  if (!rows.length) return "";
  const cell = (v, cls) => `<td class="num${cls ? " " + cls : ""}">${v}</td>`;
  return `<div class="panel"><div class="section-title"><h3>🧑‍🔧 ${t("crew_title")}</h3></div>
    <div class="muted small" style="margin:-4px 0 8px">${t("crew_hint")}</div>
    <div style="overflow-x:auto"><table><thead><tr>
      <th>${t("engineer")}</th><th class="num">${t("fin_visits_done")}</th>
      <th class="num">${t("completion_rate")}</th><th class="num">${t("fin_hours")}</th>
      <th class="num">${t("inspections")}</th><th class="num">${t("detections")}</th>
      <th class="num">${t("crew_fixed")}</th><th class="num">${t("an_deferred")}</th>
      <th class="num">${t("crew_fix_rate")}</th>
      <th class="num">${t("exp_cat_materials")}</th><th class="num">${t("nav_cash")}</th>
      <th class="num">${t("crew_cost_visit")}</th>
      <th class="num">${t("report_draft")}</th><th class="num">${t("visit_rating")}</th>
      </tr></thead><tbody>${rows.map(r => `<tr>
        <td><strong>${esc(r.agent_name)}</strong>${r.specialization
          ? `<div class="muted small">${esc(r.specialization)}</div>` : ""}</td>
        ${cell(`${r.completed}/${r.visits}`)}
        ${cell(r.completion_rate + "%", r.completion_rate < 70 ? "neg" : "")}
        ${cell(r.hours ? r.hours.toFixed(1) : "—")}
        ${cell(r.scans)}${cell(r.activity_found)}
        ${cell(r.fixed)}${cell(r.deferred, r.deferred ? "neg" : "")}
        ${cell(r.fixed_rate == null ? "—" : r.fixed_rate + "%", (r.fixed_rate != null && r.fixed_rate < 50) ? "neg" : "")}
        ${cell(money(r.materials))}${cell(money(r.pocket))}
        ${cell(money(r.cost_per_visit))}
        ${cell(r.drafts || "—", r.drafts ? "neg" : "")}
        ${cell(r.stars == null ? "—" : `${r.stars}★ (${r.ratings})`)}
      </tr>`).join("")}</tbody></table></div></div>`;
}

// Multi-section CSV of the analytics payload → downloaded file.
function exportAnalyticsCsv(a) {
  const T = a.totals, F = a.fleet || {};
  const esc = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
  const lines = [];
  const sec = (title, header, rows) => {
    lines.push(esc(title));
    if (header) lines.push(header.map(esc).join(","));
    rows.forEach(r => lines.push(r.map(esc).join(",")));
    lines.push("");
  };
  sec(t("analytics_title"), ["from", "to"], [[a.range.from, a.range.to]]);
  sec(t("summary"), ["metric", "value"], [
    [t("total_revenue"), T.revenue], [t("total_invoiced"), T.invoiced],
    [t("collection_rate"), T.collection_rate + "%"], [t("revenue_per_visit"), T.revenue_per_visit],
    [t("visits_completed"), `${T.visits_completed}/${T.visits_total}`],
    [t("completion_rate"), T.completion_rate + "%"], [t("dash_sla_overdue"), T.sla_overdue],
    [t("active_contracts"), T.active_contracts]]);
  sec(t("monthly_revenue"), ["month", "invoiced", "paid"], a.months.map(m => [m.m, m.total, m.paid]));
  sec(t("agent_productivity"), ["agent", "completed", "total"], a.agents.map(x => [x.full_name, x.completed, x.total]));
  sec(t("chemical_usage"), ["name", "unit", "used"], a.chemicals.map(x => [localized(x, "name"), x.unit, x.used]));
  sec(t("service_mix"), ["service", "visits"], a.services.map(x => [localized(x, "name"), x.cnt]));
  if (F.top_clients) sec(t("top_clients_activity"), ["client", "detections"], F.top_clients.map(x => [localized(x, "name"), x.detections]));
  if (F.by_type) sec(t("an_by_type"), ["type", "devices", "inspections", "detections"],
    F.by_type.map(x => [t("dt_" + x.type), x.devices, x.scans, x.detections]));
  if (F.faults) sec(t("an_faults"), ["fault", "count"], F.faults.map(x => [t("flt_" + x.key), x.count]));
  if (F.pests) sec(t("an_pests"), ["device", "pest", "caught"],
    F.pests.map(x => [t("dt_" + x.type), t("df_opt_" + x.key), x.count]));
  if (F.deferred_list) sec(t("an_outstanding"), ["code", "type", "client", "item", "action", "date"],
    F.deferred_list.map(x => [x.code, t("dt_" + x.type), localized(x, "name"),
      t("df_" + x.field), t("df_opt_" + x.action), x.at]));
  const A = a.application || {};
  if (A.methods) sec(t("application_method"), ["method", "times", "quantity"],
    A.methods.map(x => [t("am_" + x.k), x.cnt, x.qty]));
  if (A.equipment) sec(t("application_equipment"), ["equipment", "times", "quantity"],
    A.equipment.map(x => [t("aq_" + x.k), x.cnt, x.qty]));
  if (a.crew && a.crew.engineers) sec(t("crew_title"),
    ["engineer", "completed", "visits", "hours", "scans", "activity found", "fixed",
     "deferred", "materials", "pocket money", "cost per visit", "drafts"],
    a.crew.engineers.map(r => [r.agent_name, r.completed, r.visits, r.hours, r.scans,
      r.activity_found, r.fixed, r.deferred, r.materials, r.pocket, r.cost_per_visit,
      r.drafts]));
  const SP = a.spend || {};
  if (SP.clients) sec(t("sp_by_client"),
    ["client", "visits", "chemicals", "transport", "pocket money", "total", "per visit"],
    SP.clients.map(c => [localized(c, "name"), c.visits, c.chemicals, c.transport, c.cash,
      c.total, c.per_visit]));
  if (SP.visits) sec(t("sp_by_visit"),
    ["visit", "date", "client", "engineer", "chemicals", "transport", "pocket money", "total"],
    SP.visits.map(x => [x.id, x.scheduled_start, localized(x, "name"), x.agent_name || "",
      x.chemicals, x.transport, x.cash, x.total]));
  if (SP.months) sec(t("sp_monthly"), ["month", "chemicals", "transport", "pocket money"],
    SP.months.map(m => [m.m, m.chemicals, m.transport, m.cash]));
  if (SP.pocket && SP.pocket.engineers) sec(t("sp_by_engineer"),
    ["engineer", "claims", "spent", "advanced", "returned"],
    SP.pocket.engineers.map(x => [x.agent_name, x.claims, x.spent, x.advanced, x.returned]));
  const R = a.reports || {};
  if (R.severity) sec(t("severity"), ["severity", "reports"], R.severity.map(x => [t("sev_" + x.k), x.cnt]));
  if (R.conditions) sec(t("conditions"), ["condition", "reports"], R.conditions.map(x => [x.text, x.count]));
  if (R.recommendations) sec(t("recommendations"), ["recommendation", "reports"],
    R.recommendations.map(x => [x.text, x.count]));
  if (F.stale) sec(t("overdue_devices"), ["code", "type", "client", "location", "last_scanned"],
    F.stale.map(x => [x.code, t("dt_" + x.type), localized(x, "client"), x.loc || x.site_name || "", x.last_seen || t("never_scanned")]));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `analytics_${a.range.from}_${a.range.to}.csv`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ====================================================================
// Settings (company / branding)
// ====================================================================
// EVERYTHING, IN ONE FILE THE OFFICE KEEPS THEMSELVES.
// The server already backs itself up nightly and proves it weekly, but those
// copies live on the same machine as the thing they protect. This screen is
// about a file the owner takes AWAY — and can send back.
async function viewBackup(v) {
  let o;
  try { o = await API.get("/backup/options"); }
  catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const mb = (n) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`;
  const c = o.database.counts || {};
  const recordLine = [["clients", c.clients], ["sites", c.sites], ["visits", c.visits],
                      ["devices", c.devices], ["users", c.users]]
    .filter(([, n]) => n).map(([k, n]) => `${n} ${t("bk_" + k)}`).join(" · ");

  v.innerHTML = `<div class="page-head"><h2>${t("nav_backup")}</h2></div>
    <p class="muted">${t("bk_intro")}</p>

    <div class="panel bk-panel">
      <h3>${t("bk_take")}</h3>
      <label class="chk-item bk-opt"><input type="checkbox" id="bk-db" checked>
        <span><strong>${t("bk_records")}</strong> — ${mb(o.database.bytes)}
          <span class="muted small">${t("bk_tables").replace("{n}", o.database.tables)}${
            recordLine ? ` · ${esc(recordLine)}` : ""}</span></span></label>
      <label class="chk-item bk-opt"><input type="checkbox" id="bk-files" checked>
        <span><strong>${t("bk_files")}</strong>
          <span class="muted small">${t("bk_files_hint")}</span></span></label>
      <div class="bk-sub" id="bk-sub">
        <label class="chk-item"><input type="radio" name="bkfiles" value="linked" checked>
          <span>${t("bk_files_linked")} — ${o.linked_files.count} ${t("bk_filesword")}, ${
            mb(o.linked_files.bytes)}</span></label>
        <label class="chk-item"><input type="radio" name="bkfiles" value="all">
          <span>${t("bk_files_all")} — ${o.all_files.count} ${t("bk_filesword")}, ${
            mb(o.all_files.bytes)}</span></label>
      </div>
      <!-- PIECES OF THE BUSINESS ON THEIR OWN. Readable spreadsheets, one file
           per table, for keeping, reading or sending on. The database above is
           the part that can be RESTORED; these ride alongside it. -->
      <label class="chk-item bk-opt"><input type="checkbox" id="bk-parts-on">
        <span><strong>${t("bk_parts")}</strong>
          <span class="muted small">${t("bk_parts_hint")}</span></span></label>
      <div class="bk-parts" id="bk-parts">
        ${(o.parts || []).map(p => `<label class="chk-item">
          <input type="checkbox" class="bk-part" value="${esc(p.key)}">
          <span>${t("bkp_" + p.key)}
            <span class="muted small">${p.rows} ${t("bk_rowsword")}</span></span></label>`).join("")}
        <div class="bk-parts-all">
          <button type="button" class="link-btn sm" id="bk-parts-every">${t("bk_pick_all")}</button> ·
          <button type="button" class="link-btn sm" id="bk-parts-none">${t("bk_pick_none")}</button>
        </div>
      </div>
      <div class="form-actions bk-actions">
        <span class="muted small" id="bk-size"></span>
        <button class="btn" id="bk-go">⬇︎ ${t("bk_download")}</button>
      </div>
      <div id="bk-out"></div>
    </div>

    <div class="panel bk-panel">
      <h3>${t("bk_auto")}</h3>
      <p class="muted small">${t("bk_auto_hint")}</p>
      <div id="bk-auto"><div class="muted small">${t("loading")}</div></div>
    </div>

    <div class="panel bk-danger">
      <h3>⚠️ ${t("bk_restore")}</h3>
      <p>${t("bk_restore_warn")}</p>
      <div class="bk-restore">
        <input type="file" id="bk-file" accept=".gz,.tgz,application/gzip">
        <input type="text" id="bk-confirm" class="bk-confirm" autocomplete="off"
          placeholder="${esc(t("bk_type_restore"))}">
        <button class="btn danger" id="bk-restore-go" disabled>${t("bk_restore_do")}</button>
      </div>
      <div id="bk-progress"></div>
    </div>`;

  // ---- what the chosen boxes will cost ----
  const filesMode = () => (v.querySelector("[name=bkfiles]:checked") || {}).value || "linked";
  const chosenParts = () => !$("bk-parts-on").checked ? []
    : [...v.querySelectorAll(".bk-part:checked")].map(c => c.value);
  const sizeNow = () => {
    const db = $("bk-db").checked ? o.database.bytes : 0;
    const f = !$("bk-files").checked ? 0
      : filesMode() === "all" ? o.all_files.bytes : o.linked_files.bytes;
    // A spreadsheet row runs a couple of hundred bytes — near enough to warn a
    // phone before it downloads, and the exact size is shown when it is ready.
    const chosen = chosenParts();
    const rows = (o.parts || []).filter(p => chosen.includes(p.key))
      .reduce((n, p) => n + p.rows, 0);
    $("bk-size").textContent = t("bk_about").replace("{s}", mb(db + f + rows * 200));
    $("bk-sub").style.display = $("bk-files").checked ? "" : "none";
    $("bk-parts").style.display = $("bk-parts-on").checked ? "" : "none";
    $("bk-go").disabled = !db && !f && !chosen.length;
  };
  v.addEventListener("change", sizeNow);
  $("bk-parts-every").addEventListener("click", () => {
    v.querySelectorAll(".bk-part").forEach(c => { c.checked = true; });
    sizeNow();
  });
  $("bk-parts-none").addEventListener("click", () => {
    v.querySelectorAll(".bk-part").forEach(c => { c.checked = false; });
    sizeNow();
  });
  sizeNow();

  $("bk-go").addEventListener("click", async () => {
    const btn = $("bk-go");
    btn.disabled = true;
    $("bk-out").innerHTML = `<div class="muted small">${t("bk_building")}</div>`;
    try {
      const r = await API.post("/backup/prepare", {
        database: $("bk-db").checked,
        files: $("bk-files").checked ? filesMode() : "none",
        parts: chosenParts() });
      // Collected over a plain link so the browser streams it to disk instead
      // of holding the whole archive in memory.
      const a = document.createElement("a");
      a.href = `/api/backup/file/${r.token}`;
      a.download = r.filename;
      a.click();
      $("bk-out").innerHTML = `<div class="bk-ready">✅ ${
        t("bk_ready").replace("{f}", esc(r.filename)).replace("{s}", mb(r.bytes))}</div>`;
    } catch (e) { $("bk-out").innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; }
    btn.disabled = false;
  });

  // ---- the server's own nightly copies ----
  try {
    const list = await API.get("/backup/list");
    const rows = (list.backups || []).slice(0, 8);
    $("bk-auto").innerHTML = rows.length
      ? `<table><thead><tr><th>${t("date")}</th><th>${t("bk_kind")}</th><th>${t("file_size")}</th></tr></thead>
         <tbody>${rows.map(b => `<tr><td>${esc(b.at)}</td>
           <td>${b.kind === "uploads" ? t("bk_files") : t("bk_records")}</td>
           <td>${mb(b.bytes)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="muted small">${t("bk_auto_none")}</div>`;
  } catch (e) { $("bk-auto").innerHTML = ""; }

  // ---- restore ----
  const armed = () => {
    $("bk-restore-go").disabled = !($("bk-file").files || []).length
      || $("bk-confirm").value.trim().toUpperCase() !== "RESTORE";
  };
  $("bk-file").addEventListener("change", armed);
  $("bk-confirm").addEventListener("input", armed);
  $("bk-restore-go").addEventListener("click", () => {
    const file = ($("bk-file").files || [])[0];
    if (!file) return;
    if (!confirm(t("bk_restore_confirm").replace("{f}", file.name))) return;
    $("bk-restore-go").disabled = true;
    // XHR, not fetch: this is the one upload worth showing a progress bar for,
    // and fetch cannot report how far it has got.
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/backup/restore");
    xhr.setRequestHeader("Authorization", "Bearer " + API.token);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Confirm", "RESTORE");
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round(e.loaded / e.total * 100);
      $("bk-progress").innerHTML = `<div class="bk-bar"><span style="width:${pct}%"></span></div>
        <div class="muted small">${t("bk_uploading").replace("{p}", pct)}</div>`;
    };
    xhr.onload = () => {
      let res = {};
      try { res = JSON.parse(xhr.responseText || "{}"); } catch (e) { /* shown below */ }
      if (xhr.status === 200) {
        // Putting chosen parts back leaves the rest of the CRM alone and needs
        // no restart — so it must not throw everybody out of the app either.
        const partial = !!res.partial;
        $("bk-progress").innerHTML = `<div class="bk-ready">✅ ${
          partial
            ? t("bk_restored_parts").replace("{n}", (res.parts || []).length)
                .replace("{r}", res.rows || 0).replace("{d}", esc(res.from || ""))
            : t("bk_restored").replace("{d}", esc(res.from || ""))
                .replace("{f}", res.files || 0)}</div>
          <div class="muted small">${
            partial ? t("bk_restored_parts_note") : t("bk_restarting")}</div>`;
        // A whole-system restore re-execs the server, and every session token it
        // was holding went with the old database — so the office is sent back to
        // the sign-in screen rather than left on dead buttons.
        if (!partial) setTimeout(() => { API.clearAuth(); showLogin(); }, 6000);
        else { $("bk-restore-go").disabled = false; }
      } else {
        $("bk-progress").innerHTML = `<div class="empty">⚠️ ${
          esc(res.error || t("bk_restore_failed"))}</div>`;
        $("bk-restore-go").disabled = false;
      }
    };
    xhr.onerror = () => {
      $("bk-progress").innerHTML = `<div class="empty">⚠️ ${t("bk_restore_failed")}</div>`;
      $("bk-restore-go").disabled = false;
    };
    xhr.send(file);
  });
}

async function viewSettings(v) {
  const s = await API.get("/settings");
  v.innerHTML = `<div class="page-head"><h2>${t("settings_title")}</h2></div>
    <div class="panel"><h3>${t("company_info")}</h3>
      <form id="set-form"><div class="form-grid">
        ${field(t("company_name_en"), "company_name_en", { value: s.company_name_en })}
        ${field(t("company_name_ar"), "company_name_ar", { value: s.company_name_ar })}
        ${field(t("address_en"), "address_en", { value: s.address_en })}
        ${field(t("address_ar"), "address_ar", { value: s.address_ar })}
        ${field(t("phone"), "phone", { value: s.phone })}
        ${field(t("email"), "email", { value: s.email })}
        ${field(t("vat_no"), "vat_no", { value: s.vat_no })}
        ${field(t("currency_label"), "currency", { value: s.currency })}
        ${field(t("tax_rate"), "tax_rate", { type: "number", value: s.tax_rate })}
        ${can("finance.view") ? `<div class="field"><label>💧 ${esc(t("cash_on_hand"))}</label>
          <input type="number" step="0.01" name="cash_on_hand" value="${esc(s.cash_on_hand || "0")}" />
          <div class="muted small">${t("cash_on_hand_hint")}</div></div>
        <div class="field"><label>🏛️ ${esc(t("vat_filing"))}</label>
          <select name="vat_filing">
            ${["monthly", "quarterly", "none"].map(o => `<option value="${o}" ${(s.vat_filing || "monthly") === o ? "selected" : ""}>${esc(t("vat_filing_" + o))}</option>`).join("")}
          </select>
          <div class="muted small">${t("vat_filing_hint")}</div></div>
        ${field(t("vat_due_days"), "vat_due_days", { type: "number", value: s.vat_due_days || "30" })}` : ""}
        ${field(t("google_maps_api_key"), "google_maps_api_key", { value: s.google_maps_api_key, cls: "full" })}
        <div class="field full"><label>📍 ${esc(t("company_geo"))} <span class="muted small">(${esc(t("company_geo_hint"))})</span></label>
          <div style="display:flex;gap:6px">
            <input type="text" name="company_geo" value="${esc(s.company_geo || "")}" placeholder="lat,lng" style="flex:1" />
            <button type="button" class="btn secondary sm" id="set-geo">📍 ${esc(t("use_my_location"))}</button>
          </div></div>
        ${field(t("auto_slot_minutes"), "auto_slot_minutes",
                { type: "number", value: s.auto_slot_minutes || "60" })}
        ${field(t("auto_travel_max_minutes"), "auto_travel_max_minutes",
                { type: "number",
                  value: s.auto_travel_max_minutes ?? s.auto_travel_minutes ?? "45" })}
        ${field(t("auto_travel_area_minutes"), "auto_travel_area_minutes",
                { type: "number", value: s.auto_travel_area_minutes ?? "20" })}
        ${field(t("auto_travel_kmh"), "auto_travel_kmh",
                { type: "number", value: s.auto_travel_kmh ?? "25" })}
        ${field(t("auto_spill_km"), "auto_spill_km",
                { type: "number", value: s.auto_spill_km ?? "25" })}
        ${field(t("auto_areas_per_day"), "auto_areas_per_day",
                { type: "number", value: s.auto_areas_per_day ?? "2" })}
        ${field(t("auto_zones_per_day"), "auto_zones_per_day",
                { type: "number", value: s.auto_zones_per_day ?? "2" })}
        ${field(t("labour_hourly_cost"), "labour_hourly_cost",
                { type: "number", value: s.labour_hourly_cost ?? "0" })}
        ${can("targets.view") ? `<div class="field"><label>${esc(t("commission_rate"))}</label>
          <input type="number" step="0.1" min="0" max="100" name="commission_rate"
                 value="${esc(s.commission_rate ?? "25")}" />
          <div class="muted small">${t("commission_rate_hint")}</div></div>` : ""}
        <div class="field full muted small">${t("auto_timing_hint")}</div>
        <div class="field full"><label>🔒 ${esc(t("public_url"))}</label>
          <input type="text" name="public_url" value="${esc(s.public_url || "")}" placeholder="https://crm.example.com" />
          <div class="muted small">${t("public_url_hint")}</div></div>
      </div>
      <p class="muted small" style="margin:-4px 0 8px">${t("maps_key_hint")}</p>
      <div class="form-actions"><button class="btn" type="submit">${t("save_settings")}</button></div></form>
      <div class="section-title"><h3>${t("logo")}</h3></div>
      <div style="display:flex;align-items:center;gap:16px">
        ${s.logo ? `<img src="/uploads/${esc(s.logo)}" style="height:54px;border:1px solid var(--line);border-radius:8px;padding:4px">` : `<div class="logo" style="font-size:42px">🐜</div>`}
        <form id="logo-form"><input type="file" name="file" accept="image/*" required>
          <button class="btn secondary sm" type="submit">${t("upload_logo")}</button></form>
      </div>
    </div>
    <div class="panel"><h3>📄 ${t("cert_settings")}</h3>
      <p class="muted" style="margin:0 0 12px">${t("cert_settings_hint")}</p>
      <form id="cert-form">
        ${field(t("cert_license_no"), "cert_license_no", { value: s.cert_license_no })}
        ${field(t("cert_statement") + " (EN)", "cert_statement_en", { value: s.cert_statement_en, textarea: true })}
        ${field(t("cert_statement") + " (AR)", "cert_statement_ar", { value: s.cert_statement_ar, textarea: true })}
        ${field(t("cert_footer_label") + " (EN)", "cert_footer_en", { value: s.cert_footer_en, textarea: true })}
        ${field(t("cert_footer_label") + " (AR)", "cert_footer_ar", { value: s.cert_footer_ar, textarea: true })}
        <div class="form-actions"><button class="btn" type="submit">${t("save_settings")}</button></div></form></div>
    <div class="panel"><h3>${t("smtp_note")}</h3>
      <form id="smtp-form"><div class="form-grid">
        ${field(t("smtp_host"), "smtp_host", { value: s.smtp_host })}
        ${field(t("smtp_port"), "smtp_port", { value: s.smtp_port || "587" })}
        ${field(t("smtp_user"), "smtp_user", { value: s.smtp_user })}
        ${field(t("smtp_pass"), "smtp_pass", { type: "password", value: s.smtp_pass })}
        ${field(t("smtp_from"), "smtp_from", { value: s.smtp_from })}
      </div><div class="form-actions"><button class="btn" type="submit">${t("save_settings")}</button></div></form></div>`;
  $("set-form").addEventListener("submit", async (e) => {
    e.preventDefault(); SETTINGS = await API.put("/settings", formData($("set-form"))); toast(t("settings_saved"));
  });
  if ($("set-geo")) $("set-geo").addEventListener("click", () => {
    if (!navigator.geolocation) { alert(t("geo_unsupported")); return; }
    $("set-geo").textContent = "…";
    navigator.geolocation.getCurrentPosition(
      (p) => { $("set-form").querySelector("[name=company_geo]").value = p.coords.latitude.toFixed(6) + "," + p.coords.longitude.toFixed(6); $("set-geo").textContent = "📍 " + t("use_my_location"); },
      () => { alert(t("geo_failed")); $("set-geo").textContent = "📍 " + t("use_my_location"); });
  });
  $("cert-form").addEventListener("submit", async (e) => {
    e.preventDefault(); SETTINGS = await API.put("/settings", formData($("cert-form"))); toast(t("settings_saved"));
  });
  $("smtp-form").addEventListener("submit", async (e) => {
    e.preventDefault(); SETTINGS = await API.put("/settings", formData($("smtp-form"))); toast(t("settings_saved"));
  });
  $("logo-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("logo-form").querySelector("[name=file]").files[0];
    if (!file) return;
    const fd = new FormData(); fd.append("file", file);
    const res = await fetch("/api/settings/logo", { method: "POST", headers: { Authorization: "Bearer " + API.token }, body: fd });
    if (res.ok) { SETTINGS = await res.json(); toast(t("settings_saved")); navigate("settings"); }
    else alert("Upload failed");
  });
}

// ====================================================================
// Signature capture (photograph of the signed page)
// ====================================================================
// Signatures are collected on paper and photographed, not drawn on the phone:
// a finger-drawn scribble is not what the customer signs, and the paper copy is
// what an auditor asks for. The photo is stored in the same report column the
// canvas used to fill, so it prints as the signature image everywhere — never
// as an attachment link.
function sigBlock(which, visit, visitId, canEdit) {
  const rep = visit.report || {};
  const file = which === "customer" ? rep.customer_signature : rep.technician_signature;
  // The report carries one signature now, so the tab is simply "Signature".
  // The technician column is only ever shown for reports filed when there were
  // two, and it keeps its old name so nobody mistakes whose it was.
  const label = which === "customer" ? t("signature") : t("technician_signature");
  const name = which === "customer" && rep.customer_name ? `<div class="muted small">${esc(rep.customer_name)}</div>` : "";
  return `<div class="panel" style="margin:0">
    <div class="section-title" style="margin:0 0 8px"><h3 style="font-size:13px">${label}</h3>
      ${canEdit ? `<button class="link-btn sm" data-sign="${which}">${file ? t("edit") : t("capture_sig")}</button>` : ""}</div>
    ${file ? `<img src="/uploads/${esc(file)}" style="max-height:160px;max-width:100%;border:1px solid var(--line);border-radius:6px;background:#fff">${name}`
      : `<div class="muted small">${t("none")}</div>`}</div>`;
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("read"));
    fr.readAsDataURL(file);
  });
}

function signatureDialog(visitId, which) {
  const label = which === "customer" ? t("signature") : t("technician_signature");
  const canShoot = !cameraBlockedReason();
  let shot = null;                                  // the File we will upload
  openModal(label, `<div>
    ${which === "customer" ? field(t("customer_name"), "sig_name") : ""}
    <p class="muted small">${t("sig_photo_hint")}</p>
    <div id="sg-cam" class="qr-scan hidden">
      <div class="qr-view"><video id="sg-video" playsinline muted autoplay></video></div>
      <div class="muted small" id="sg-camhint">${t("sig_camera_hint")}</div>
      <div class="form-actions"><button type="button" class="btn secondary" id="sg-camx">${t("cancel")}</button>
        <button type="button" class="btn" id="sg-shot">📸 ${t("capture")}</button></div>
    </div>
    <div id="sg-main">
      ${canShoot ? `<button type="button" class="btn" id="sg-camopen">📷 ${t("sig_take_photo")}</button>` : ""}
      <div class="field" style="margin-top:10px"><label>${t("sig_from_gallery")}</label>
        <input type="file" id="sg-file" accept="image/*" capture="environment"></div>
      <div id="sg-preview"></div>
      <div class="form-actions"><button class="btn secondary" id="sg-x">${t("cancel")}</button>
        <button class="btn" id="sg-save" disabled>${t("save_signature")}</button></div>
    </div></div>`, (root) => {
    const main = root.querySelector("#sg-main");
    const panel = root.querySelector("#sg-cam");
    const preview = root.querySelector("#sg-preview");
    const saveBtn = root.querySelector("#sg-save");
    let previewUrl = null;
    const setShot = (file) => {
      if (!file) return;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      shot = file;
      previewUrl = URL.createObjectURL(file);
      preview.innerHTML = `<img src="${previewUrl}" alt="" style="max-width:100%;max-height:220px;
        margin-top:10px;border:1px solid var(--line);border-radius:8px;background:#fff">`;
      saveBtn.disabled = false;
    };
    onModalClose(() => { if (previewUrl) URL.revokeObjectURL(previewUrl); });
    root.querySelector("#sg-x").addEventListener("click", closeModal);
    root.querySelector("#sg-file").addEventListener("change", (e) => setShot(e.target.files[0]));

    if (canShoot) {
      let cam = null;
      const closeCam = () => {
        if (cam) { cam.stop(); cam = null; }
        panel.classList.add("hidden"); main.classList.remove("hidden");
      };
      root.querySelector("#sg-camopen").addEventListener("click", async () => {
        panel.classList.remove("hidden"); main.classList.add("hidden");
        cam = await startPhotoCamera(root.querySelector("#sg-video"), root.querySelector("#sg-camhint"));
      });
      root.querySelector("#sg-camx").addEventListener("click", closeCam);
      root.querySelector("#sg-shot").addEventListener("click", async () => {
        if (!cam) return;
        const file = await cam.shoot();
        if (!file) return;
        setShot(file);
        closeCam();
      });
    }

    saveBtn.addEventListener("click", async () => {
      if (!shot) return;
      saveBtn.disabled = true;
      try {
        const body = { which, data: await fileToDataUrl(shot) };
        const nameEl = root.querySelector("[name=sig_name]");
        if (nameEl) body.customer_name = nameEl.value;
        const saved = await API.post(`/visits/${visitId}/signature`, body);
        if (handledOffline(saved)) return;
        closeModal(); toast(t("saved")); navigate("visit", { id: visitId });
      } catch (err) { alert(err.message); saveBtn.disabled = false; }
    });
  });
}

// ====================================================================
// Chart helpers — dependency-free SVG curves + CSS-3D pie/columns
// ====================================================================
let _chartSeq = 0;
const PALETTE = ["#16a34a", "#2563eb", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#dc2626"];

function monthShort(m) {
  const d = new Date(m + "-01");
  return isNaN(d) ? m : d.toLocaleDateString(LANG === "ar" ? "ar" : "en", { month: "short" });
}

function _smoothPath(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0]},${p2[1]}`;
  }
  return d;
}

// labels: string[]; series: [{name,color,values:[]}]
function curveChart(labels, series, opts = {}) {
  const W = 640, H = 260, padL = 46, padR = 14, padT = 16, padB = 30;
  const n = labels.length;
  const max = Math.max(1, ...series.flatMap(s => s.values));
  const x = (i) => padL + (n <= 1 ? 0 : i * (W - padL - padR) / (n - 1));
  const y = (val) => H - padB - (val / max) * (H - padT - padB);
  const fmt = opts.money ? (v) => money(v) : (v) => Math.round(v);
  // gridlines + y labels
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const gy = padT + g * (H - padT - padB) / 4;
    const val = max * (1 - g / 4);
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#eef2f6" stroke-width="1"/>
      <text x="${padL - 8}" y="${gy + 4}" text-anchor="end" font-size="10" fill="#94a3b8">${opts.money ? Math.round(val) : Math.round(val)}</text>`;
  }
  // x labels
  let xlab = "";
  labels.forEach((l, i) => { if (i % 2 === 0 || i === n - 1) xlab += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#94a3b8">${esc(l)}</text>`; });
  // series paths
  let paths = "", dots = "", defs = "";
  series.forEach((s, si) => {
    const id = `grad${_chartSeq++}`;
    const pts = s.values.map((v, i) => [x(i), y(v)]);
    const line = _smoothPath(pts);
    const area = `${line} L${x(n - 1)},${H - padB} L${x(0)},${H - padB} Z`;
    defs += `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${s.color}" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
    paths += `<path d="${area}" fill="url(#${id})"/><path d="${line}" fill="none" stroke="${s.color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    pts.forEach(p => { dots += `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="#fff" stroke="${s.color}" stroke-width="2"/>`; });
  });
  const legend = series.map(s => `<span class="lg"><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("");
  return `<div class="chart-legend">${legend}</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">
    <defs>${defs}</defs>${grid}${paths}${dots}${xlab}</svg>`;
}

// segments: [{label,value,color}] -> tilted 3D pie + legend
function pie3d(segments, opts = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) return `<div class="empty">${t("none")}</div>`;
  let acc = 0; const parts = [];
  segments.forEach(s => {
    const a = (acc / total) * 360, b = ((acc + s.value) / total) * 360;
    parts.push(`${s.color} ${a.toFixed(2)}deg ${b.toFixed(2)}deg`); acc += s.value;
  });
  const legend = segments.map(s => `<div class="lg"><span class="sw" style="background:${s.color}"></span>${esc(s.label)} <strong>${s.value}</strong> <span class="muted">(${Math.round(s.value / total * 100)}%)</span></div>`).join("");
  return `<div class="pie3d-row">
    <div class="pie3d-stage"><div class="pie3d" style="background:conic-gradient(${parts.join(",")})"></div></div>
    <div class="pie-legend">${legend}</div></div>`;
}

// items: [{label,value,color}] -> 3D cylinder columns
function cols3d(items) {
  if (!items.length) return `<div class="empty">${t("none")}</div>`;
  const max = Math.max(1, ...items.map(i => i.value));
  const Hpx = 170;
  const cols = items.map((it, i) => {
    const h = Math.max(4, Math.round((it.value / max) * Hpx));
    const c = it.color || PALETTE[i % PALETTE.length];
    return `<div class="col3d-col">
      <div class="col3d-bars" style="height:${Hpx + 26}px">
        <div class="col3d-val">${it.value % 1 ? money(it.value) : it.value}</div>
        <div class="col3d" style="height:${h}px;--c:${c};--cl:${c}cc"><span class="col3d-cap" style="background:${c}"></span></div>
      </div>
      <div class="col3d-lbl">${esc(it.label)}</div></div>`;
  }).join("");
  return `<div class="cols3d">${cols}</div>`;
}

// Pest-activity trend section (device monitoring) — returns "" when the
// client has no devices, so it only appears where it's meaningful.
function pestTrendsBlock(tr) {
  if (!tr || !tr.totals || !tr.totals.devices) return "";
  const T = tr.totals;
  const K = tr.kpis || {};
  const labels = tr.months.map(m => monthShort(m.m));
  const statusColors = { ok: "#16a34a", needs_service: "#d97706", activity: "#dc2626", missing: "#64748b" };
  const sc = (val, label, icon, cls) => `<div class="stat-card ${cls}"><div class="sc-ic">${icon}</div><div><div class="v">${val}</div><div class="l">${label}</div></div></div>`;
  const typeItems = tr.by_type.map((r, i) => ({
    label: r.type ? t("dt_" + r.type) : t("none"), value: r.detections,
    color: PALETTE[(i + 1) % PALETTE.length] }));
  const trend = curveChart(labels, [
    { name: t("inspections"), color: "#2563eb", values: tr.months.map(m => m.inspections) },
    { name: t("detections"), color: "#dc2626", values: tr.months.map(m => m.detections) }]);
  // Pest-pressure curve (fly counts + bait consumption %) — only when we have data.
  const hasFly = tr.months.some(m => m.fly != null);
  const hasBait = tr.months.some(m => m.bait_pct != null);
  const pressure = (hasFly || hasBait) ? `<div class="panel"><h3>🪰 ${t("pest_pressure")}</h3>${curveChart(labels, [
    ...(hasFly ? [{ name: t("avg_fly"), color: "#7c3aed", values: tr.months.map(m => m.fly || 0) }] : []),
    ...(hasBait ? [{ name: t("bait_consumption"), color: "#d97706", values: tr.months.map(m => m.bait_pct || 0) }] : [])])}</div>` : "";
  const hotRows = (tr.hotspots || []).map(h => `<tr>
      <td><strong>${esc(h.label || "#" + h.id)}</strong></td>
      <td>${esc(h.type ? t("dt_" + h.type) : "—")}</td>
      <td>${esc(h.loc || "—")}</td>
      <td class="num"><strong>${h.detections}</strong></td>
      <td><span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${statusColors[h.status] || "#64748b"}">${esc(t("mst_" + h.status))}</span></td>
    </tr>`).join("") || `<tr><td colspan="5" class="empty">${t("no_trend_data")}</td></tr>`;
  // Consumables replaced (from scan follow-up) — restocking / billing signal.
  const rep = K.replaced || {};
  const repItems = [["baits", "baits_count"], ["lamps", "lamps_used"], ["sheets", "light_sheets_used"], ["glue_boards", "glo_pieces"]]
    .filter(([k]) => (rep[k] || 0) > 0)
    .map(([k, tk], i) => ({ label: t(tk), value: rep[k], color: PALETTE[i % PALETTE.length] }));
  return `
    <div class="cards">
      ${sc(T.devices, t("total_devices"), "📍", "c-blue")}
      ${sc(T.inspections, t("monitoring_events"), "🔎", "c-teal")}
      ${sc(T.detections, t("activity_detections"), "🐭", "danger")}
      ${sc(T.needs_service || 0, t("mst_needs_service"), "🛠️", "c-amber")}
      ${K.fly_avg != null ? sc(K.fly_avg, t("avg_fly"), "🪰", "c-purple") : ""}
      ${K.catch_rate != null ? sc(K.catch_rate + "%", t("catch_rate"), "🎯", "c-teal") : ""}</div>
    <div class="panel"><h3>📈 ${t("pest_trends")}</h3>${trend}</div>
    ${pressure}
    <div class="grid-2">
      <div class="panel"><h3>🐛 ${t("by_device_type")}</h3>${cols3d(typeItems)}</div>
      <div class="panel"><h3>🔥 ${t("device_hotspots")}</h3>
        <table><thead><tr><th>${t("code")}</th><th>${t("marker_type")}</th><th>${t("location_lbl")}</th>
        <th class="num">${t("detections")}</th><th>${t("marker_status")}</th></tr></thead>
        <tbody>${hotRows}</tbody></table></div>
    </div>
    ${repItems.length ? `<div class="panel"><h3>🔧 ${t("consumables_replaced")}</h3>${cols3d(repItems)}</div>` : ""}`;
}

// Materials-consumed rollup: total parts/chemicals used across all the
// client's visits (from the engineer service log). Returns "" when none.
function materialsBlock(materials) {
  if (!materials || !materials.length) return "";
  const cards = materials.map((m, i) =>
    `<div class="stat-card ${["c-blue", "c-green", "c-teal", "c-amber", "c-purple"][i % 5]}">
      <div class="sc-ic">📦</div><div><div class="v">${m.total}</div><div class="l">${esc(t(m.key))}</div></div></div>`).join("");
  return `<div class="cards">${cards}</div>`;
}

// ====================================================================
// Client statement of account (printable ledger)
// ====================================================================
function statementDialog(c) {
  const today = ymd(new Date());
  const yearAgo = ymd(new Date(Date.now() - 365 * 86400000));
  openModal(t("statement"), `<form id="stf">
    ${field(t("from_date"), "from", { type: "date", value: yearAgo })}
    ${field(t("to_date"), "to", { type: "date", value: today })}
    <div class="form-actions"><button type="button" class="btn secondary" id="stf-x">${t("cancel")}</button>
    <button class="btn" type="submit">🖨️ ${t("print")}</button></div></form>`, (root) => {
    $("stf-x").addEventListener("click", closeModal);
    root.querySelector("#stf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      try {
        const st = await API.get(`/clients/${c.id}/statement?from=${d.from || ""}&to=${d.to || ""}`);
        closeModal(); printStatement(st);
      } catch (err) { alert(err.message); }
    });
  });
}

function printStatement(st) {
  const name = localized(st.client, "name");
  const line = (e) => `<tr><td>${fmtDate(e.date)}</td>
    <td>${e.kind === "invoice" ? t("invoice_word") : t("payment_word")} ${esc(e.ref)}${e.method ? ` <span class="muted">(${esc(e.method)})</span>` : ""}</td>
    <td class="num">${e.debit ? money(e.debit) : ""}</td>
    <td class="num">${e.credit ? money(e.credit) : ""}</td>
    <td class="num"><strong>${money(e.balance)}</strong></td></tr>`;
  const body = `
    <div class="panel"><h3>${esc(name)} — ${fmtDate(st.from)} → ${fmtDate(st.to)}</h3>
    <table><thead><tr><th>${t("date")}</th><th>${t("description")}</th>
      <th class="num">${t("debit")}</th><th class="num">${t("credit")}</th><th class="num">${t("balance")}</th></tr></thead>
    <tbody>
      <tr><td>${fmtDate(st.from)}</td><td><em>${t("opening_balance")}</em></td><td></td><td></td>
        <td class="num"><strong>${money(st.opening)}</strong></td></tr>
      ${st.entries.map(line).join("")}
      <tr><td></td><td><strong>${t("closing_balance")}</strong></td>
        <td class="num"><strong>${money(st.total_debit)}</strong></td>
        <td class="num"><strong>${money(st.total_credit)}</strong></td>
        <td class="num"><strong>${money(st.closing)}</strong></td></tr>
    </tbody></table></div>`;
  analyticsReportDoc(t("statement_of_account"), name, body);
}

// ====================================================================
// Per-company analytics
// ====================================================================
async function viewClientAnalytics(v, arg) {
  const id = (arg && arg.id) || (role() === "client" ? API.user.client_id : null);
  if (!id) { v.innerHTML = `<div class="empty">${t("none")}</div>`; return; }
  const c = await API.get("/clients/" + id);
  const sites = c.sites || [];
  // Location filter: total + each location (+ unassigned bucket when sites exist).
  const locOpts = [`<option value="">${esc(t("all_locations"))}</option>`]
    .concat(sites.map(s => `<option value="${s.id}">${esc(siteLabel(s))}</option>`));
  if (sites.length) locOpts.push(`<option value="none">${esc(t("unassigned"))}</option>`);
  const locName = (sid) => !sid ? t("all_locations")
    : sid === "none" ? t("unassigned")
    : (sites.find(s => String(s.id) === String(sid)) || {}).name || "";

  v.innerHTML = `
    <div class="breadcrumb" id="bc">← 📁 ${esc(localized(c, "name"))}</div>
    <div class="page-head"><h2>${t("company_analytics")} — ${esc(localized(c, "name"))}</h2>
      <div style="display:flex;gap:8px;align-items:center">
        ${sites.length ? `<label class="muted small">📍 ${t("location_lbl")}:</label>
          <select id="loc-filter">${locOpts.join("")}</select>` : ""}
        ${can("analytics.view") || role() === "client" ? `<button class="btn sm" id="audit-pack">📦 ${t("audit_pack")}</button>` : ""}
        <button class="btn sm" id="export-analytics">🖨️ ${t("export_pdf")}</button></div></div>
    <div id="analytics-body"><div class="empty">${t("loading")}</div></div>`;
  $("bc").addEventListener("click", () => navigate(role() === "client" ? "folder" : "client", { id }));

  let currentParts = null, currentSite = "";
  async function render(siteId) {
    currentSite = siteId || "";
    const body = $("analytics-body");
    body.innerHTML = `<div class="empty">${t("loading")}</div>`;
    const q = siteId ? `?site_id=${encodeURIComponent(siteId)}` : "";
    const [a, tr] = await Promise.all([
      API.get(`/clients/${id}/analytics${q}`),
      API.get(`/clients/${id}/pest-trends${q}`).catch(() => null)]);
    const T = a.totals;
    const labels = a.months.map(m => monthShort(m.m));
    const statusColors = { scheduled: "#2563eb", in_progress: "#d97706", completed: "#16a34a", cancelled: "#dc2626" };
    const sevColors = { low: "#16a34a", medium: "#d97706", high: "#ef4444", critical: "#b91c1c" };
    const statusSeg = a.status.map(s => ({ label: t(statusKey(s.status)), value: s.cnt, color: statusColors[s.status] || "#64748b" }));
    const sevSeg = a.severity.map(s => ({ label: t("sev_" + s.severity), value: s.cnt, color: sevColors[s.severity] || "#64748b" }));
    const svcItems = a.services.map((s, i) => ({ label: localized(s, "name"), value: s.cnt, color: PALETTE[i % PALETTE.length] }));
    const chemItems = a.chemicals.map((ch, i) => ({ label: localized(ch, "name"), value: Math.round((ch.used || 0) * 100) / 100, color: PALETTE[(i + 3) % PALETTE.length] }));
    const sc = (val, label, icon, cls) => `<div class="stat-card ${cls}"><div class="sc-ic">${icon}</div><div><div class="v">${val}</div><div class="l">${label}</div></div></div>`;
    // Build chart markup once so the screen and the PDF export are identical.
    const parts = {
      cards: `<div class="cards">
        ${sc(T.visits, t("total_visits"), "🗓️", "c-blue")}
        ${sc(T.completed, t("visits_completed"), "✅", "c-green")}
        ${sc(money(T.invoiced), t("total_invoiced"), "🧾", "c-purple")}
        ${sc(money(T.paid), t("total_paid"), "💰", "c-teal")}
        ${sc(money(T.outstanding), t("outstanding"), "⚠️", "danger")}
        ${sc(T.contracts, t("active_contracts"), "🔁", "c-amber")}</div>`,
      revenue: curveChart(labels, [
        { name: t("invoiced"), color: "#16a34a", values: a.months.map(m => m.invoiced) },
        { name: t("paid"), color: "#2563eb", values: a.months.map(m => m.paid) }], { money: true }),
      visits: curveChart(labels, [{ name: t("nav_visits"), color: "#7c3aed", values: a.months.map(m => m.visits) }]),
      status: pie3d(statusSeg), severity: pie3d(sevSeg),
      services: cols3d(svcItems), chemicals: cols3d(chemItems),
      materials: materialsBlock(a.materials),
      pestTrends: pestTrendsBlock(tr),
    };
    currentParts = parts;
    body.innerHTML = `
      ${parts.cards}
      <div class="panel"><h3>📈 ${t("revenue_trend")}</h3>${parts.revenue}</div>
      <div class="grid-2">
        <div class="panel"><h3>📉 ${t("visits_trend")}</h3>${parts.visits}</div>
        <div class="panel"><h3>🟢 ${t("status_distribution")}</h3>${parts.status}</div>
        <div class="panel"><h3>🧭 ${t("severity_distribution")}</h3>${parts.severity}</div>
        <div class="panel"><h3>🧰 ${t("service_mix")}</h3>${parts.services}</div>
      </div>
      <div class="panel"><h3>🧪 ${t("chemical_usage")}</h3>${parts.chemicals}</div>
      ${parts.materials ? `<div class="panel"><h3>📦 ${t("materials_consumed")}</h3>${parts.materials}</div>` : ""}
      ${parts.pestTrends ? `<div class="section-title" style="margin-top:8px"><h2>🐭 ${t("pest_trends")}</h2></div>${parts.pestTrends}` : ""}`;
  }

  if ($("loc-filter")) $("loc-filter").addEventListener("change", (e) => render(e.target.value));
  $("export-analytics").addEventListener("click", () => {
    if (!currentParts) return;
    const sub = localized(c, "name") + " — " + locName(currentSite);
    printAnalytics(c, currentParts, sub);
  });
  if ($("audit-pack")) $("audit-pack").addEventListener("click", () => auditPackDialog(c, currentSite, locName));
  await render("");
}

// ---- shared printable / PDF analytics report shell ----
// titleText = report title; subtitle = client name or scope; bodyHtml = panels.
function analyticsReportDoc(titleText, subtitle, bodyHtml) {
  const ar = LANG === "ar";
  const dir = ar ? "rtl" : "ltr";
  const S = SETTINGS || {};
  const compName = (ar ? S.company_name_ar : S.company_name_en) || S.company_name_en || "Company";
  const compAddr = (ar ? S.address_ar : S.address_en) || S.address_en || "";
  const logoHtml = S.logo ? `<img src="/uploads/${esc(S.logo)}" style="height:46px">` : `<div class="logo" style="width:46px;height:46px;font-size:24px;border-radius:12px">🐜</div>`;
  const today = new Date().toLocaleDateString(ar ? "ar" : "en-GB", { dateStyle: "medium" });
  const doc = `<!DOCTYPE html><html lang="${LANG}" dir="${dir}"><head><meta charset="utf-8">
    <title>${esc(titleText)}${subtitle ? " — " + esc(subtitle) : ""}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/css/styles.css">
    <style>
      html,body{background:#fff}
      body{padding:28px;font-family:${ar ? "'Cairo'" : "'Inter'"},system-ui,sans-serif}
      /* force chart colors/gradients to print */
      *{ -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
      .rpt-top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #16a34a;padding-bottom:16px;margin-bottom:18px}
      .rpt-top .co h1{margin:0;font-size:18px;color:#15803d}
      .rpt-top .co .muted{color:#64748b;font-size:12px;line-height:1.6}
      .rpt-title{text-align:${ar ? "left" : "right"}}
      .rpt-title h2{margin:0;font-size:22px;color:#16a34a}
      .rpt-title .sub{font-size:13px;font-weight:600;margin-top:4px}
      .rpt-title .date{font-size:11px;color:#64748b;margin-top:2px}
      .panel{break-inside:avoid;page-break-inside:avoid;box-shadow:none;border:1px solid #e6ecf2}
      .grid-2{grid-template-columns:1fr 1fr}
      .noprint{text-align:center;margin-bottom:16px}
      .pbtn{background:#16a34a;color:#fff;border:none;padding:10px 22px;border-radius:9px;font-size:14px;cursor:pointer}
      @media print{.noprint{display:none}body{padding:0}}
    </style></head><body>
    <div class="noprint"><button class="pbtn" onclick="window.print()">🖨️ ${esc(t("export_pdf"))}</button></div>
    <div class="rpt-top">
      <div style="display:flex;gap:12px;align-items:center">${logoHtml}
        <div class="co"><h1>${esc(compName)}</h1>
          <div class="muted">${esc(compAddr)}<br>${esc(S.phone || "")} · ${esc(S.email || "")}</div></div></div>
      <div class="rpt-title"><h2>${esc(titleText)}</h2>
        ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ""}
        <div class="date">${esc(t("generated_on"))} ${today}</div></div>
    </div>
    ${bodyHtml}
    <script>window.onload=function(){setTimeout(function(){window.print()},600)}<\/script>
    </body></html>`;
  printHtmlDoc(doc);
}

function printAnalytics(c, parts, subtitle) {
  const body = `${parts.cards}
    <div class="panel"><h3>📈 ${esc(t("revenue_trend"))}</h3>${parts.revenue}</div>
    <div class="grid-2">
      <div class="panel"><h3>📉 ${esc(t("visits_trend"))}</h3>${parts.visits}</div>
      <div class="panel"><h3>🟢 ${esc(t("status_distribution"))}</h3>${parts.status}</div>
      <div class="panel"><h3>🧭 ${esc(t("severity_distribution"))}</h3>${parts.severity}</div>
      <div class="panel"><h3>🧰 ${esc(t("service_mix"))}</h3>${parts.services}</div>
    </div>
    <div class="panel"><h3>🧪 ${esc(t("chemical_usage"))}</h3>${parts.chemicals}</div>
    ${parts.materials ? `<div class="panel"><h3>📦 ${esc(t("materials_consumed"))}</h3>${parts.materials}</div>` : ""}
    ${parts.pestTrends ? `<h2 style="margin:18px 0 6px">🐭 ${esc(t("pest_trends"))}</h2>${parts.pestTrends}` : ""}`;
  analyticsReportDoc(t("analytics_report"), subtitle || localized(c, "name"), body);
}

// ====================================================================
// One-click Audit Pack — the binder an auditor asks for, as one branded PDF.
// (Per-site service history, device trends, chemical usage log + SDS/labels,
//  technician licences, and corrective actions.)
// ====================================================================
function auditPackDialog(c, siteId, locName) {
  const iso = ymd;                 // local calendar date — see ymd()
  const today = new Date();
  const from = new Date(today); from.setFullYear(from.getFullYear() - 1);
  openModal(`📦 ${t("audit_pack")}`, `<form id="apf">
    <p class="muted small" style="margin:0 0 12px">${esc(t("audit_pack_hint"))}</p>
    <div class="form-grid">
      ${field(t("from_date"), "from", { type: "date", value: iso(from) })}
      ${field(t("to_date"), "to", { type: "date", value: iso(today) })}
    </div>
    <p class="muted small">📍 ${esc(t("location_lbl"))}: <strong>${esc(locName(siteId))}</strong></p>
    <div class="form-actions"><button type="button" class="btn secondary" id="apf-x">${t("cancel")}</button>
    <button class="btn" type="submit">📦 ${t("audit_generate")}</button></div></form>`, (root) => {
    $("apf-x").addEventListener("click", closeModal);
    root.querySelector("#apf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      closeModal();
      await generateAuditPack(c, siteId, locName(siteId), d.from, d.to);
    });
  });
}

async function generateAuditPack(c, siteId, siteName, from, to) {
  let data;
  try {
    const q = new URLSearchParams();
    if (siteId) q.set("site_id", siteId);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    data = await API.get(`/clients/${c.id}/audit-pack?${q.toString()}`);
  } catch (err) { alert(err.message); return; }
  const sub = localized(c, "name") + (siteName ? " — " + siteName : "");
  analyticsReportDoc(`📦 ${t("audit_pack")}`, sub, renderAuditPack(data));
}

function renderAuditPack(d) {
  const sevColors = { low: "#16a34a", medium: "#d97706", high: "#ef4444", critical: "#b91c1c" };
  const sevBadge = (s) => s ? `<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${sevColors[s] || "#64748b"}">${esc(t("sev_" + s))}</span>` : "—";
  const S = d.summary;
  const sc = (val, label, icon, cls) => `<div class="stat-card ${cls}"><div class="sc-ic">${icon}</div><div><div class="v">${val}</div><div class="l">${esc(label)}</div></div></div>`;
  const rangeTxt = `${fmtDate(d.range.from)} → ${fmtDate(d.range.to)}`;

  // 1. cover / summary
  const cover = `<div class="panel" style="border-left:4px solid #16a34a">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div><strong>${esc(localized(d.client, "name"))}</strong>
          ${d.site ? ` · ${esc(d.site.name)}` : ` · ${esc(t("all_locations"))}`}</div>
        <div class="muted">${esc(t("audit_period"))}: <strong>${esc(rangeTxt)}</strong></div></div></div>
    <div class="cards">
      ${sc(S.visits, t("total_visits"), "🗓️", "c-blue")}
      ${sc(S.completed, t("visits_completed"), "✅", "c-green")}
      ${sc(S.signed, t("signed_reports"), "✍️", "c-teal")}
      ${sc(S.products, t("products_used"), "🧪", "c-purple")}
      ${sc(S.detections, t("activity_detections"), "🐭", "danger")}
      ${sc(S.corrective, t("corrective_actions"), "🛠️", "c-amber")}</div>`;

  // 2. device / pest-activity trend
  let trends = "";
  if (S.detections || (d.trend.months || []).some(m => m.inspections)) {
    const labels = d.trend.months.map(m => monthShort(m.m));
    const curve = curveChart(labels, [
      { name: t("inspections"), color: "#2563eb", values: d.trend.months.map(m => m.inspections) },
      { name: t("detections"), color: "#dc2626", values: d.trend.months.map(m => m.detections) }]);
    const typeItems = d.trend.by_type.map((r, i) => ({
      label: r.type ? t("type_" + r.type) : t("none"), value: r.detections, color: PALETTE[(i + 1) % PALETTE.length] }));
    trends = `<h2 style="margin:18px 0 6px">🐭 ${esc(t("pest_trends"))}</h2>
      <div class="panel"><h3>📈 ${esc(t("pest_trends"))}</h3>${curve}</div>
      ${typeItems.length ? `<div class="panel"><h3>🐛 ${esc(t("by_device_type"))}</h3>${cols3d(typeItems)}</div>` : ""}`;
  }

  // 3. service history
  const histRows = d.history.map(h => `<tr>
      <td>${fmtDate(h.scheduled_start)}</td>
      <td>${esc(h.site_name || "—")}</td>
      <td>${esc(localized({ name_en: h.svc_en, name_ar: h.svc_ar }, "name") || "—")}</td>
      <td>${esc(h.agent || "—")}</td>
      <td>${sevBadge(h.severity)}</td>
      <td>${esc(h.summary || h.findings || "—")}</td>
      <td style="text-align:center">${h.customer_signature || h.technician_signature ? "✅" : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="7" class="empty">${t("none")}</td></tr>`;
  const history = `<h2 style="margin:18px 0 6px">📋 ${esc(t("service_history"))}</h2>
    <div class="panel"><table><thead><tr>
      <th>${t("date")}</th><th>${t("location_lbl")}</th><th>${t("service")}</th><th>${t("agent")}</th>
      <th>${t("severity")}</th><th>${t("summary")}</th><th>${t("customer_sig")}</th></tr></thead>
      <tbody>${histRows}</tbody></table></div>`;

  // 4. chemical usage log + product / SDS list
  const rate = (r) => {
    const a = parseFloat(r.area_treated);
    return (!isNaN(a) && a > 0) ? `${Math.round((r.quantity / a) * 1000) / 1000} ${esc(r.unit || "")}/${esc(t("unit_area"))}` : "—";
  };
  const chemRows = d.chem_log.map(r => `<tr>
      <td>${fmtDate(r.scheduled_start)}</td>
      <td>${esc(localized(r, "name"))}</td>
      <td>${esc(r.active_ingredient || "—")}</td>
      <td>${esc(r.reg_no || "—")}</td>
      <td class="num">${r.quantity} ${esc(r.unit || "")}</td>
      <td>${esc(usageMethod(r))}</td>
      <td>${esc(usageEquip(r))}</td>
      <td>${esc(r.area_treated || "—")}</td>
      <td>${rate(r)}</td>
      <td>${esc(r.agent || "—")}</td></tr>`).join("") || `<tr><td colspan="10" class="empty">${t("none")}</td></tr>`;
  const prodRows = d.products.map(p => {
    const docs = (p.attachments || []).length
      ? p.attachments.map(a => `<a href="/uploads/${esc(a.filename)}" target="_blank">${esc(a.original_name || t("sds_label"))}</a>`).join(", ")
      : `<span class="muted">${t("no_sds")}</span>`;
    return `<tr><td>${esc(localized(p, "name"))}</td><td>${esc(p.active_ingredient || "—")}</td>
      <td>${esc(p.reg_no || "—")}</td><td>${esc(p.hazard_class || "—")}</td><td>${docs}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">${t("none")}</td></tr>`;
  const chemicals = `<h2 style="margin:18px 0 6px">🧪 ${esc(t("chemical_usage_log"))}</h2>
    <div class="panel"><table><thead><tr>
      <th>${t("date")}</th><th>${t("product")}</th><th>${t("active_ingredient")}</th><th>${t("reg_no")}</th>
      <th class="num">${t("quantity")}</th><th>${t("application_method")}</th>
      <th>${t("application_equipment")}</th><th>${t("area_treated")}</th>
      <th>${t("application_rate")}</th><th>${t("agent")}</th>
      </tr></thead><tbody>${chemRows}</tbody></table></div>
    <div class="panel"><h3>📄 ${esc(t("products_sds"))}</h3><table><thead><tr>
      <th>${t("product")}</th><th>${t("active_ingredient")}</th><th>${t("reg_no")}</th>
      <th>${t("hazard_class")}</th><th>${t("sds_label")}</th></tr></thead>
      <tbody>${prodRows}</tbody></table></div>`;

  // 5. technician credentials
  const techRows = d.technicians.map(u => `<tr>
      <td>${esc(u.full_name)}</td>
      <td>${esc(u.specialization || "—")}</td>
      <td>${esc(u.license_no || "—")}</td>
      <td>${u.license_expiry ? fmtDate(u.license_expiry) : "—"}</td>
      <td class="num">${u.visits}</td>
      <td>${fmtDate(u.last_visit)}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">${t("none")}</td></tr>`;
  const techs = `<h2 style="margin:18px 0 6px">👷 ${esc(t("technician_credentials"))}</h2>
    <div class="panel"><table><thead><tr>
      <th>${t("technician")}</th><th>${t("specialization")}</th><th>${t("license_no")}</th>
      <th>${t("license_expiry")}</th><th class="num">${t("nav_visits")}</th><th>${t("last_visit")}</th>
      </tr></thead><tbody>${techRows}</tbody></table></div>`;

  // 6. corrective actions (+ open device alerts)
  const corrRows = d.corrective.map(r => `<tr>
      <td>${fmtDate(r.scheduled_start)}</td><td>${esc(r.site_name || "—")}</td>
      <td>${sevBadge(r.severity)}</td>
      <td>${esc(r.findings || r.pests_found || r.branch_issue || "—")}</td>
      <td>${esc(r.recommendations || "—")}</td>
      <td>${esc(r.agent || "—")}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">${t("no_corrective")}</td></tr>`;
  const alertRows = (d.device_alerts || []).map(a => `<tr>
      <td>${esc(a.label || "—")}</td><td>${esc(a.type ? t("dt_" + a.type) : "—")}</td>
      <td>${esc(a.loc || "—")}</td>
      <td><span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${a.status === "activity" ? "#dc2626" : "#d97706"}">${esc(t("mst_" + a.status))}</span></td>
      <td>${a.last_seen ? fmtDate(a.last_seen) : "—"}</td></tr>`).join("");
  const corrective = `<h2 style="margin:18px 0 6px">🛠️ ${esc(t("corrective_actions"))}</h2>
    <div class="panel"><table><thead><tr>
      <th>${t("date")}</th><th>${t("location_lbl")}</th><th>${t("severity")}</th>
      <th>${t("finding")}</th><th>${t("action_taken")}</th><th>${t("agent")}</th>
      </tr></thead><tbody>${corrRows}</tbody></table></div>
    ${alertRows ? `<div class="panel"><h3>⚠️ ${esc(t("open_device_alerts"))}</h3><table><thead><tr>
      <th>${t("code")}</th><th>${t("marker_type")}</th><th>${t("location_lbl")}</th>
      <th>${t("marker_status")}</th><th>${t("last_seen")}</th></tr></thead>
      <tbody>${alertRows}</tbody></table></div>` : ""}`;

  return cover + trends + history + chemicals + techs + corrective;
}

// ====================================================================
// Site maps + device markers (traps, bait stations, monitors …)
// ====================================================================
const MARKER_TYPES = [
  { k: "bait_station", icon: "📦" }, { k: "rodent_trap", icon: "🪤" },
  { k: "insect_light", icon: "💡" }, { k: "monitor", icon: "🔎" },
  { k: "treatment", icon: "🧪" }, { k: "other", icon: "📍" },
];
const MARKER_STATUS = { ok: "#16a34a", needs_service: "#d97706", activity: "#dc2626", missing: "#64748b" };
function markerIcon(type) { const m = MARKER_TYPES.find(x => x.k === type); return m ? m.icon : "📍"; }

async function loadClientMaps(c) {
  const box = $("maps-box");
  if (!box) return;
  const maps = await API.get(`/clients/${c.id}/maps`);
  if (!maps.length) { box.innerHTML = `<div class="empty">${t("no_maps")}</div>`; return; }
  box.innerHTML = `<div class="map-thumbs">${maps.map(m => `
    <div class="map-thumb" data-map="${m.id}">
      <img src="/uploads/${esc(m.filename)}">
      <div class="mt-meta"><strong>${esc(m.name)}</strong>
        <span class="muted small">${m.site_name ? esc(m.site_name) + " · " : ""}${m.marker_count} ${t("devices")}</span></div>
      ${can("maps.delete") ? `<button class="rm" data-rmmap="${m.id}">✕</button>` : ""}
    </div>`).join("")}</div>`;
  box.querySelectorAll("[data-map]").forEach(el => el.addEventListener("click", (e) => {
    if (e.target.dataset.rmmap !== undefined) return;
    navigate("map", { id: el.dataset.map });
  }));
  box.querySelectorAll("[data-rmmap]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (confirm(t("confirm_delete"))) { const r = await API.del("/maps/" + b.dataset.rmmap); if (handledOffline(r, b.closest(".map-thumb"))) return; loadClientMaps(c); }
  }));
}

function uploadMapDialog(c) {
  const siteOpts = [{ v: "", l: t("none") }].concat((c.sites || []).map(s => ({ v: s.id, l: siteLabel(s) })));
  openModal(t("upload_map"), `<form id="mapf">
    ${field(t("map_name"), "name", { value: "Site map" })}
    ${field(t("map_for_site"), "site_id", { options: siteOpts })}
    <div class="field"><label>${t("maps")}</label>
      <input type="file" name="file" accept="image/*,application/pdf,.pdf" required>
      <div class="muted small">${t("map_file_hint")}</div></div>
    <div class="form-actions"><button type="button" class="btn secondary" id="mapf-x">${t("cancel")}</button>
    <button class="btn" type="submit">${t("upload_map")}</button></div></form>`, (root) => {
    $("mapf-x").addEventListener("click", closeModal);
    root.querySelector("#mapf").addEventListener("submit", async (e) => {
      e.preventDefault();
      let file = root.querySelector("[name=file]").files[0];
      if (!file) return;
      // Devices are pinned to x/y on the picture, so a PDF plan becomes one.
      if (attachKind(file.name) === "pdf") {
        toast(t("map_pdf_converting"));
        try { file = await pdfFirstPageToPng(file); }
        catch (err) { alert(t("map_pdf_failed")); return; }
      }
      const fd = new FormData();
      fd.append("client_id", c.id);
      fd.append("name", root.querySelector("[name=name]").value || "Site map");
      if (root.querySelector("[name=site_id]").value) fd.append("site_id", root.querySelector("[name=site_id]").value);
      fd.append("file", file);
      const res = await fetch("/api/maps", { method: "POST", headers: { Authorization: "Bearer " + API.token }, body: fd });
      if (res.ok) { closeModal(); toast(t("saved")); loadClientMaps(c); }
      else { const d = await res.json().catch(() => null); alert((d && d.error) || "Upload failed"); }
    });
  });
}

function markerPin(mk) {
  return `<button class="map-pin" style="left:${mk.x}%;top:${mk.y}%;--mc:${MARKER_STATUS[mk.status] || "#64748b"}"
    data-marker="${mk.id}" title="${esc(mk.label || "")}">
    <span class="pin-ic">${markerIcon(mk.type)}</span>${mk.label ? `<span class="pin-lbl">${esc(mk.label)}</span>` : ""}</button>`;
}
function mapLegend() {
  const types = MARKER_TYPES.map(x => `<span class="lg">${x.icon} ${t("type_" + x.k)}</span>`).join("");
  const stat = Object.entries(MARKER_STATUS).map(([k, col]) => `<span class="lg"><span class="dot" style="background:${col}"></span>${t("mst_" + k)}</span>`).join("");
  return types + ` &nbsp;|&nbsp; ` + stat;
}

async function viewMap(v, arg) {
  const map = await API.get("/maps/" + arg.id);
  const canEdit = role() !== "client";
  const typeOpts = MARKER_TYPES.map(x => `<option value="${x.k}">${x.icon} ${t("type_" + x.k)}</option>`).join("");
  v.innerHTML = `
    <div class="breadcrumb" id="bc">← 📁 ${esc(localized(map, "client"))}</div>
    <div class="page-head"><h2>${esc(map.name)}${map.site_name ? ` — ${esc(map.site_name)}` : ""}
      <span class="muted small">(${map.markers.length} ${t("total_devices")})</span></h2>
      ${canEdit ? `<div style="display:flex;gap:8px;align-items:center">
        <select id="mk-type" class="toolbar-select">${typeOpts}</select>
        <button class="btn sm" id="place-btn">➕ ${t("add_device")}</button>
        ${map.markers.length ? `<button class="btn sm secondary" id="qr-sheet">🏷️ ${t("print_qr_labels")}</button>` : ""}</div>` : ""}</div>
    <div class="map-legend-bar">${mapLegend()}</div>
    <div class="map-stage" id="stage">
      <img id="map-img" src="/uploads/${esc(map.filename)}">
      ${map.markers.map(markerPin).join("")}
    </div>`;
  $("bc").addEventListener("click", () => navigate("client", { id: map.client_id }));
  const stage = $("stage");
  let placing = false;
  const setPlacing = (p) => {
    placing = p; stage.classList.toggle("placing", p);
    if ($("place-btn")) $("place-btn").textContent = p ? `✋ ${t("done_placing")}` : `➕ ${t("add_device")}`;
    if (p) toast(t("click_to_place"));
  };
  if ($("place-btn")) $("place-btn").addEventListener("click", () => setPlacing(!placing));
  if ($("qr-sheet")) $("qr-sheet").addEventListener("click", () => printQrSheet(map));
  stage.addEventListener("click", (e) => {
    if (!placing) return;
    const img = $("map-img"), r = img.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
    const y = Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100));
    setPlacing(false);
    markerForm(map, { x: +x.toFixed(2), y: +y.toFixed(2), type: $("mk-type").value, status: "ok" }, false);
  });
  v.querySelectorAll(".map-pin").forEach(p => p.addEventListener("click", (e) => {
    e.stopPropagation();
    const mk = map.markers.find(x => x.id == p.dataset.marker);
    if (canEdit) markerForm(map, mk, true); else showMarkerInfo(mk);
  }));
}

function markerForm(map, mk, isEdit) {
  const mapId = map.id;
  const typeOpts = MARKER_TYPES.map(x => ({ v: x.k, l: x.icon + " " + t("type_" + x.k) }));
  const statusOpts = ["ok", "needs_service", "activity", "missing"].map(s => ({ v: s, l: t("mst_" + s) }));
  openModal(isEdit ? t("edit") : t("add_device"), `<form id="mkf">
    ${field(t("marker_type"), "type", { options: typeOpts, value: mk.type })}
    ${field(t("marker_label"), "label", { value: mk.label })}
    ${field(t("marker_status"), "status", { options: statusOpts, value: mk.status })}
    ${field(t("marker_notes"), "notes", { textarea: true, value: mk.notes })}
    ${isEdit && mk.qr_token ? `<div class="qr-mini"><div class="qr-mini-img">${qrSvg(deviceScanUrl(mk), 3)}</div>
      <button type="button" class="btn sm secondary" id="mk-qr">🏷️ ${t("print_qr")}</button></div>` : ""}
    <div class="form-actions">${isEdit ? `<button type="button" class="btn danger" id="mk-del" style="margin-inline-end:auto">${t("delete")}</button>` : ""}
      <button type="button" class="btn secondary" id="mk-x">${t("cancel")}</button>
      <button class="btn" type="submit">${t("save_device")}</button></div></form>`, (root) => {
    $("mk-x").addEventListener("click", closeModal);
    if ($("mk-qr")) $("mk-qr").addEventListener("click", () => printQrSheet(map, mk));
    if ($("mk-del")) $("mk-del").addEventListener("click", async () => {
      const r = await API.del("/markers/" + mk.id); if (handledOffline(r)) return; closeModal(); navigate("map", { id: mapId });
    });
    root.querySelector("#mkf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(root);
      try {
        const saved = isEdit ? await API.put("/markers/" + mk.id, d)
          : await API.post(`/maps/${mapId}/markers`, { ...d, x: mk.x, y: mk.y });
        if (handledOffline(saved)) return;
        closeModal(); navigate("map", { id: mapId });
      } catch (err) { alert(err.message); }
    });
  });
}
function showMarkerInfo(mk) {
  openModal(markerIcon(mk.type) + " " + t("type_" + mk.type), `<div class="kv">
    <div>${t("marker_label")}</div><div>${esc(mk.label || "—")}</div>
    <div>${t("marker_status")}</div><div style="color:${MARKER_STATUS[mk.status]}">${t("mst_" + mk.status)}</div>
    <div>${t("marker_notes")}</div><div>${esc(mk.notes || "—")}</div></div>
    <div class="form-actions"><button class="btn" id="mi-x">${t("close")}</button></div>`, () => {
    $("mi-x").addEventListener("click", closeModal);
  });
}

// ====================================================================
// QR-CODED DEVICES — printable labels + scan-to-inspect (the audit moat)
// ====================================================================
// QR-coded devices: code generation, scan-to-report, printable labels.
// The four field-device types and their printed code prefixes.
const DEVICE_TYPES = [
  { k: "light_trap",   pre: "LIT" },
  { k: "glue_station", pre: "GLU" },
  { k: "bait_station", pre: "BAI" },
  { k: "fly_trap",     pre: "FLY" },
];
// The device type is written out in words everywhere — on screen and on the
// printed label — so it reads the same in both places and survives printing.
function devCode3(code) { return String(code || "").slice(0, 3).toUpperCase(); }

// Per-type follow-up fields captured on a scan (the simplified key fields from
// the printed follow-up form). Drives both the scan form and the printout.
// kind: "select" (opts = option keys, labelled via t("df_opt_"+key)),
//       "num" (min/max range), "bool" (yes/no). Labels via t("df_"+key).
// showIf: {key, vals} marks a follow-up ACTION field — one that only makes
// sense once its parent field reports a fault (a damaged trap, a cut cable).
// It stays hidden (and unfiled) until the parent says so, and in the printed
// tables it rides along in the parent's own cell as "Damaged → Replaced"
// instead of claiming a column of its own.
// What a light trap catches, as a fixed tick-list (labels via t("df_opt_"+key)).
const LIGHT_TRAP_PESTS = ["house_flies", "fruit_flies", "drain_flies", "flesh_flies",
  "blow_flies", "moths", "gnats", "weevils", "beetles", "wasps", "mosquitoes", "other_flying"];
// What a glue station catches — crawlers, so a list of its own.
const GLUE_STATION_PESTS = ["norway_rat", "roof_rat", "house_mouse", "gecko", "snake",
  "lizard", "german_cockroach", "american_cockroach", "ants"];
const DEVICE_FIELDS = {
  bait_station: [
    { key: "station_condition", kind: "select", opts: ["good", "damaged", "missing"] },
    { key: "station_action", kind: "select", opts: ["replaced", "next_visit_replaced"],
      showIf: { key: "station_condition", vals: ["damaged", "missing"] } },
    // A station left uncleaned is the fault; the action says whether it was
    // then dealt with. "changed" moved off the bait status onto its action —
    // the status says what the bait is, the action what the engineer did.
    { key: "cleaned", kind: "bool" },
    { key: "cleaned_action", kind: "select", opts: ["done", "not_done"],
      showIf: { key: "cleaned", vals: ["no"] } },
    { key: "bait_status", kind: "select", opts: ["good", "damaged", "missing", "activity_eating"] },
    { key: "bait_action", kind: "select", opts: ["changed", "not_changed"],
      showIf: { key: "bait_status", vals: ["damaged", "missing", "activity_eating"] } },
    { key: "consumption_pct", kind: "num", min: 0, max: 100 },
  ],
  fly_trap: [
    // Same fault-then-action pair as the light trap; the rest of the fly trap
    // (washing, water, density) is unchanged.
    { key: "trap_condition", kind: "select", opts: ["good", "damaged", "missing"] },
    { key: "trap_action", kind: "select", opts: ["replaced", "next_visit_replaced"],
      showIf: { key: "trap_condition", vals: ["damaged", "missing"] } },
    { key: "washed", kind: "bool" },
    { key: "water_refilled", kind: "bool" },
    { key: "fly_density", kind: "num", min: 0, max: 1000 },
  ],
  glue_station: [
    { key: "station_condition", kind: "select", opts: ["good", "damaged", "missing"] },
    { key: "station_action", kind: "select", opts: ["replaced", "next_visit_replaced"],
      showIf: { key: "station_condition", vals: ["damaged", "missing"] } },
    { key: "cleaned", kind: "bool" },
    { key: "glue_status", kind: "select", opts: ["good", "damaged", "missing", "caught"] },
    { key: "glue_action", kind: "select", opts: ["changed", "next_visit_change"],
      showIf: { key: "glue_status", vals: ["damaged", "missing", "caught"] } },
    // (a separate "catch present" yes/no used to sit here — the glue status
    // says "caught" and the count says how many, so it asked nothing new)
    { key: "insect_count", kind: "num", min: 0, max: 1000 },
    // A glue station catches what walks, not what flies — its own tick-list.
    { key: "pests_found", kind: "multi", wide: true, opts: GLUE_STATION_PESTS },
  ],
  light_trap: [
    { key: "trap_condition", kind: "select", opts: ["good", "damaged", "missing"] },
    { key: "trap_action", kind: "select", opts: ["replaced", "next_visit_replaced"],
      showIf: { key: "trap_condition", vals: ["damaged", "missing"] } },
    { key: "electricity", kind: "select", opts: ["connected", "disconnected", "cable_missing"] },
    { key: "electricity_action", kind: "select", opts: ["reconnected", "next_visit_reconnect"],
      showIf: { key: "electricity", vals: ["disconnected", "cable_missing"] } },
    { key: "lamp_status", kind: "select", opts: ["good", "damaged", "missing"] },
    { key: "lamp_action", kind: "select", opts: ["replaced", "next_visit_replaced"],
      showIf: { key: "lamp_status", vals: ["damaged", "missing"] } },
    { key: "trans_light_status", kind: "select", opts: ["good", "damaged", "missing"] },
    { key: "trans_light_action", kind: "select", opts: ["replaced", "next_visit_replaced"],
      showIf: { key: "trans_light_status", vals: ["damaged", "missing"] } },
    { key: "sheet_status", kind: "select", opts: ["good", "expired", "missing", "full"] },
    { key: "sheet_action", kind: "select", opts: ["changed", "next_visit_change"],
      showIf: { key: "sheet_status", vals: ["expired", "missing", "full"] } },
    { key: "fly_count", kind: "num", min: 0, max: 1000 },
    // What was caught, ticked off a fixed list instead of typed — it stands in
    // for the free-text findings box on a light trap, so the catch is data the
    // reports can print in either language rather than one engineer's wording.
    { key: "pests_found", kind: "multi", wide: true, opts: LIGHT_TRAP_PESTS },
  ],
};
// Build the follow-up field inputs for a device type. `pf` is an optional
// prefill object (the details from this visit's last inspection of the device).
function scanFieldsHtml(type, pf) {
  pf = pf || {};
  const inp = (f) => {
    const cur = pf[f.key];
    if (f.kind === "num")
      return `<input type="number" name="${f.key}" inputmode="numeric"${f.min != null ? ` min="${f.min}"` : ""}${f.max != null ? ` max="${f.max}"` : ""} value="${cur != null ? esc(String(cur)) : ""}">`;
    // A tick-list: the boxes are the UI, the hidden input is what gets filed,
    // so the submit path keeps collecting one value per [name] as before.
    if (f.kind === "multi") {
      const on = splitMulti(cur);
      return `<div class="opt-picks scan-multi" data-multi="${f.key}">${f.opts.map(o =>
        `<label class="opt-pick"><input type="checkbox" value="${o}"${on.includes(o) ? " checked" : ""}>
          <span>${t("df_opt_" + o)}</span></label>`).join("")}</div>
        <input type="hidden" name="${f.key}" value="${esc(on.join(","))}">`;
    }
    const opts = f.kind === "bool" ? ["yes", "no"] : f.opts;
    const optHtml = opts.map(o => `<option value="${o}"${String(cur) === o ? " selected" : ""}>${f.kind === "bool" ? t(o) : t("df_opt_" + o)}</option>`).join("");
    return `<select name="${f.key}"><option value="">—</option>${optHtml}</select>`;
  };
  // A tick-list holds labels of its own, and a label inside a label is invalid
  // HTML the browser reflows — so those fields are a plain div instead.
  return `<div class="scan-fields">${(DEVICE_FIELDS[type] || []).map(f => {
    const tag = f.kind === "multi" ? "div" : "label";
    return `<${tag} class="scan-f${f.showIf ? " scan-f-cond" : ""}${f.wide ? " scan-f-wide" : ""}"${
      f.showIf ? ` data-when="${f.showIf.key}" data-vals="${f.showIf.vals.join(",")}"` : ""}>` +
      `<span>${t("df_" + f.key)}</span>${inp(f)}</${tag}>`;
  }).join("")}</div>`;
}
// A multi-value answer travels as a comma-joined list of option keys.
const splitMulti = (v) => String(v == null ? "" : v).split(",").map(s => s.trim()).filter(Boolean);

// Types whose catch is ticked off a list take no free-text findings box — the
// list IS the finding, and typed wording would only compete with it.
const hasCatchList = (type) => (DEVICE_FIELDS[type] || []).some(f => f.kind === "multi");

// Ticking a box in a scan tick-list rewrites the hidden input that is actually
// filed, in the order the list is printed (not the order they were ticked).
function wireScanMulti(root) {
  (root || document).querySelectorAll(".scan-multi").forEach(box => {
    const hidden = box.parentNode.querySelector(`[name="${box.dataset.multi}"]`);
    box.querySelectorAll("input[type=checkbox]").forEach(cb => cb.addEventListener("change", () => {
      hidden.value = [...box.querySelectorAll("input[type=checkbox]")]
        .filter(x => x.checked).map(x => x.value).join(",");
    }));
  });
}

// Show/hide the conditional action fields to match what their parent field
// currently says, and blank any that just went away so a stale answer can't be
// filed behind a hidden input. Called once on render (the prefill may already
// carry a fault) and again whenever a parent select changes.
function applyScanConditionals(root) {
  (root || document).querySelectorAll(".scan-f-cond").forEach(lab => {
    const parent = (root || document).querySelector(`.scan-fields [name="${lab.dataset.when}"]`);
    const on = !!parent && lab.dataset.vals.split(",").includes(parent.value);
    lab.style.display = on ? "" : "none";
    if (!on) lab.querySelectorAll("[name]").forEach(el => { el.value = ""; });
  });
}

// What a client can see of their own traps. The office has had this all along;
// for the customer it is the plainest evidence that the money buys something —
// where the traps are, when each was last checked, and whether anything has
// been turning up in them. Read-only by construction: a client has no
// maps.edit, so the scan screen they reach from here cannot file anything.
async function viewMyDevices(v) {
  const cid = API.user && API.user.client_id;
  const [devices, trends] = await Promise.all([
    API.get("/devices").catch(() => []),
    cid ? API.get(`/clients/${cid}/pest-trends`).catch(() => null) : Promise.resolve(null)]);
  if (!devices.length) {
    v.innerHTML = `<div class="page-head"><h2>${t("nav_my_devices")}</h2></div>
      <div class="empty">${t("my_devices_none")}</div>`;
    return;
  }
  const byType = {};
  devices.forEach(d => { byType[d.type] = (byType[d.type] || 0) + 1; });
  const cards = `<div class="cards">
    ${Object.keys(byType).map(ty => `<div class="stat-card c-blue"><div class="sc-ic">${markerIcon(ty)}</div>
      <div><div class="v">${byType[ty]}</div><div class="l">${esc(t("dt_" + ty))}</div></div></div>`).join("")}
    </div>`;
  const labels = (trends && trends.months || []).map(m => monthShort(m.m));
  const curve = (trends && (trends.months || []).some(m => m.inspections || m.detections))
    ? curveChart(labels, [
        { name: t("inspections"), color: "#2563eb", values: trends.months.map(m => m.inspections) },
        { name: t("detections"), color: "#dc2626", values: trends.months.map(m => m.detections) }])
    : `<div class="empty">${t("none")}</div>`;
  const rows = devices.map(d => `<tr class="clickable" data-dev="${d.id}">
      <td><strong>${esc(d.code)}</strong></td>
      <td>${esc(t("dt_" + d.type))}</td>
      <td>${esc(d.label || d.placement || "—")}</td>
      <td>${esc(d.site_name || "—")}</td>
      <td><span class="badge" style="background:${MARKER_STATUS[d.status] || "#64748b"};color:#fff">${t("mst_" + d.status)}</span></td>
      <td>${d.last_seen ? fmtDate(d.last_seen) : `<span class="muted">${t("never_scanned")}</span>`}</td>
    </tr>`).join("");
  v.innerHTML = `<div class="page-head"><h2>🏷️ ${t("nav_my_devices")}</h2></div>
    <p class="muted small" style="margin:-6px 0 10px">${t("my_devices_hint")}</p>
    ${cards}
    <div class="panel"><h3>📈 ${t("pest_trends")}</h3>${curve}</div>
    <div class="panel"><table><thead><tr><th>${t("code")}</th><th>${t("marker_type")}</th>
      <th>${t("marker_label")}</th><th>${t("location_lbl")}</th><th>${t("status")}</th>
      <th>${t("last_scanned")}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  v.querySelectorAll("[data-dev]").forEach(tr => tr.addEventListener("click",
    () => navigate("device-history", { id: tr.dataset.dev })));
}

// One trap's whole file: every scan ever filed against it, newest first, with
// what was found and what was done. Nothing here can be edited — an inspection
// is written once and kept — so it reads as the record it is, and prints as one
// when someone asks what has been happening at that corner all year.
async function viewDeviceHistory(v, arg) {
  const id = arg && arg.id;
  let d;
  try { d = await API.get(`/devices/${id}/history`); }
  catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const cols = deviceColumns(d.type);
  const parse = (h) => { try { return h.details ? JSON.parse(h.details) : {}; } catch (e) { return {}; } };
  const rows = (d.history || []).map(h => {
    const det = parse(h);
    return `<tr>
      <td>${fmtDateTime(h.recorded_at)}</td>
      <td><span class="badge" style="background:${MARKER_STATUS[h.status] || "#64748b"};color:#fff">${t("mst_" + h.status)}</span></td>
      ${cols.map(f => `<td>${detailCellHtml(d.type, f, det)}</td>`).join("")}
      <td>${esc(h.findings || h.note || "—")}</td>
      <td>${esc(h.recorded_by_name || "—")}</td>
      <td>${h.visit_id ? "#" + String(h.visit_id).padStart(5, "0") : "—"}</td>
      <td>${(h.lat != null && h.lng != null)
        ? `<a href="https://www.google.com/maps/search/?api=1&query=${h.lat},${h.lng}" target="_blank" rel="noopener">📍</a>` : "—"}</td>
    </tr>`;
  }).join("");
  v.innerHTML = `<div class="page-head">
      <h2>${markerIcon(d.type)} ${esc(d.code)} — ${t("full_history")}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn secondary sm" id="dh-csv">⬇️ ${t("export_csv")}</button>
        <button class="btn secondary sm" id="dh-print">🖨️ ${t("print")}</button>
        <button class="btn secondary sm" id="dh-back">← ${t("back")}</button></div></div>
    <div class="panel"><div class="kv">
      <div>${t("marker_type")}</div><div>${esc(t("dt_" + d.type))}</div>
      <div>${t("client")}</div><div>${esc(localized(d, "client") || "—")}</div>
      <div>${t("location_lbl")}</div><div>${esc(d.site_name || "—")}${d.placement ? " · " + esc(d.placement) : ""}</div>
      <div>${t("scan_history")}</div><div>${d.scans} ${t("items_n")}</div>
      <div>${t("first_seen")}</div><div>${d.history.length ? fmtDate(d.history[d.history.length - 1].recorded_at) : "—"}</div>
    </div></div>
    <p class="muted small">${t("history_immutable_hint")}</p>
    <div class="panel" id="dh-table" style="overflow-x:auto"><table><thead><tr>
      <th>${t("date")}</th><th>${t("status")}</th>
      ${cols.map(f => `<th>${esc(t("df_" + f.key))}</th>`).join("")}
      <th>${t("findings")}</th><th>${t("engineer")}</th><th>${t("visit")}</th><th>📍</th>
      </tr></thead><tbody>${rows
        || `<tr><td colspan="${cols.length + 6}" class="empty">${t("none")}</td></tr>`}</tbody>
      </table></div>`;
  $("dh-back").addEventListener("click", () => navigate("scan", { token: d.code }));
  $("dh-print").addEventListener("click", () => analyticsReportDoc(
    `${d.code} — ${t("full_history")}`,
    [localized(d, "client"), d.site_name, d.placement].filter(Boolean).join(" · "),
    $("dh-table").innerHTML));
  $("dh-csv").addEventListener("click", () => {
    const q = (x) => `"${String(x == null ? "" : x).replace(/"/g, '""')}"`;
    const lines = [[t("date"), t("status")].concat(cols.map(f => t("df_" + f.key)))
      .concat([t("findings"), t("engineer"), t("visit")]).map(q).join(",")];
    (d.history || []).forEach(h => {
      const det = parse(h);
      lines.push([h.recorded_at, t("mst_" + h.status)]
        .concat(cols.map(f => (det[f.key] != null && det[f.key] !== "") ? fmtDetailVal(f, det[f.key]) : ""))
        .concat([h.findings || h.note || "", h.recorded_by_name || "", h.visit_id || ""])
        .map(q).join(","));
    });
    const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `${d.code}_history.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

// Human-readable one-line summary of a stored details object, for history rows
// and the coverage table. `det` is the parsed object; `type` its device type.
function deviceDetailsSummary(type, det) {
  if (!det || typeof det !== "object") return "";
  // Action fields fold into the field they answer: "Trap condition: Damaged → Replaced".
  return deviceColumns(type).filter(f => det[f.key] !== undefined && det[f.key] !== "")
    .map(f => {
      const act = (DEVICE_FIELDS[type] || []).find(a =>
        a.showIf && a.showIf.key === f.key && det[a.key]);
      return `${t("df_" + f.key)}: ${fmtDetailVal(f, det[f.key])}`
        + (act ? ` → ${fmtDetailVal(act, det[act.key])}` : "");
    }).join(" · ");
}
// Absolute URL a printed device code resolves to (the SPA scan view).
// A label outlives the browser tab it was printed from, so it must carry the
// canonical https address — printing while on http://<ip>:8000 would otherwise
// stamp that IP onto the trap, and a phone opening it lands on an insecure
// origin with no camera and no geolocation. (The server also 301s the old
// labels, so both halves cover each other.)
function scanBase() {
  const pub = (SETTINGS && SETTINGS.public_url || "").trim().replace(/\/+$/, "");
  return pub || location.origin;
}
function codeScanUrl(code) { return scanBase() + "/scan/" + code; }
// (kept for the legacy floor-plan map markers)
function deviceScanUrl(mk) { return scanBase() + "/scan/" + mk.qr_token; }

// Render `text` as an inline QR SVG string (crisp at any print size). Returns
// "" if the QR library failed to load (degrade, never throw).
function qrSvg(text, cell) {
  try {
    if (typeof qrcode !== "function") return "";
    const qr = qrcode(0, "M");           // 0 = auto version, M = ~15% recovery
    qr.addData(text); qr.make();
    return qr.createSvgTag({ cellSize: cell || 4, margin: 2 });
  } catch (e) { return ""; }
}

// THE WAY OUT OF A SCANNED CODE IS THE PAGE YOU CAME FROM.
// It used to be a "Dashboard" button, which is the one place an engineer
// standing at a trap has not just come from: they reach a device from the
// branch, from a visit, or from the previous trap in the run, and being thrown
// to the dashboard means finding their way back in every time. So it walks the
// same trail the topbar's ← walks. A code opened cold from the camera has no
// trail behind it — navGoBack falls back to the dashboard for exactly that, so
// there is still always a way out.
function scanGoBack() {
  if (!navGoBack()) navigate(NAV_HOME);
}

// Scan landing: fetch by token/code, then render the device or (legacy) marker UI.
async function viewScan(v, arg) {
  const token = arg.token;
  let d;
  try { d = await API.get("/scan/" + token); }
  catch (e) {
    v.innerHTML = `<div class="scan-wrap"><div class="scan-card">
      <div class="empty">⚠️ ${esc(e.message || t("device_unknown"))}</div>
      <div class="form-actions">${can("maps.view") ? `<button class="btn" id="sc-again">📷 ${t("scan_qr")}</button>` : ""}
        <button class="btn secondary" id="sc-back">← ${t("back")}</button></div>
    </div></div>`;
    if ($("sc-again")) $("sc-again").addEventListener("click", () => openQrScanner());
    if ($("sc-back")) $("sc-back").addEventListener("click", scanGoBack);
    return;
  }
  if (d.code) return renderDeviceScan(v, token, d);
  return renderMarkerScan(v, token, d);
}

// What the last visit left for this one. The office could already see the
// backlog in Analytics; the engineer standing at the trap could not, which is
// the only place it can actually be paid off.
function promisedHtml(list) {
  if (!list || !list.length) return "";
  return `<div class="scan-promised">
    <div class="sp-head">📌 ${t("promised_last_visit")}</div>
    ${list.map(p => `<div class="sp-item">${esc(t("df_" + p.field))}: <strong>${
      esc(t("df_opt_" + p.action))}</strong>${p.fault
        ? ` <span class="muted">(${esc(t("df_opt_" + p.fault))})</span>` : ""}</div>`).join("")}
    <div class="muted small">${fmtDate(list[0].at)}</div></div>`;
}

// Device scan: the agent's two-second report for one trap during a visit.
function renderDeviceScan(v, code, d) {
  const unassigned = !d.client_id;
  const canInspect = can("maps.edit") && !unassigned;
  const stBtns = ["ok", "activity", "needs_service", "missing"].map(s =>
    `<button class="scan-st" data-st="${s}" style="--c:${MARKER_STATUS[s]}">${t("mst_" + s)}</button>`).join("");
  const visitLine = d.active_visit_id
    ? `<div class="scan-now ok-line">✓ ${t("filing_on_visit")} #${d.active_visit_id}</div>`
    : `<div class="scan-now warn-line">⚠ ${t("no_active_visit")}</div>`;
  v.innerHTML = `<div class="scan-wrap"><div class="scan-card">
    <div class="scan-head">
      <div class="scan-ic" style="background:${MARKER_STATUS[d.status] || "#64748b"}">${esc(devCode3(d.code))}</div>
      <div><div class="scan-title">${esc(d.code)}</div>
        <div class="muted small">${esc(t("dt_" + d.type))}${d.label ? " · " + esc(d.label) : ""}</div>
        ${d.placement ? `<div class="muted small">\u{1F4CD} ${esc(d.placement)}</div>` : ""}
        <div class="muted small">${unassigned ? `<span class="warn-line">${t("unassigned")}</span>`
          : esc(localized(d, "client")) + (d.site_name ? " · " + esc(d.site_name) : "")}</div></div>
      <div class="scan-qr"><div class="scan-qr-img">${qrSvg(codeScanUrl(d.code), 3) || "🏷️"}</div>
        <button type="button" class="btn sm secondary" id="sc-print">🏷️ ${t("print_qr")}</button></div>
    </div>
    ${unassigned ? `<div class="scan-now warn-line">${t("device_unassigned_hint")}</div>` : (canInspect ? visitLine : "")}
    ${promisedHtml(d.promised)}
    ${canInspect ? `
      <div class="scan-q">${t("scan_prompt")}</div>
      <div class="scan-sts">${stBtns}</div>
      <div class="scan-q">${t("followup_details")}</div>
      ${scanFieldsHtml(d.type, scanPrefill(d))}
      ${hasCatchList(d.type) ? ""
        : `<textarea id="sc-find" class="scan-note" rows="2" placeholder="${t("findings")}"></textarea>`}
      <label class="scan-geo"><input type="checkbox" id="sc-geo" checked> ${t("scan_geostamp")}</label>
      <div class="form-actions" style="margin-top:12px"><button class="btn" id="sc-save">✔ ${t("save_inspection")}</button></div>`
      : (unassigned ? "" : `<div class="muted" style="margin:12px 0">${t("scan_readonly")}</div>`)}
    <div class="scan-hist"><div class="section-title"><h3>${t("scan_history")}</h3>
      <button class="link-btn sm" id="sc-all">${t("full_history")}</button></div>
      ${(d.history || []).length ? d.history.map(h => {
        let det = {}; try { det = h.details ? JSON.parse(h.details) : {}; } catch (e) { det = {}; }
        const ds = deviceDetailsSummary(d.type, det);
        return `
        <div class="scan-ev"><span class="dot" style="background:${MARKER_STATUS[h.status] || "#64748b"}"></span>
          <div class="se-main"><strong>${t("mst_" + h.status)}</strong>${h.findings ? " — " + esc(h.findings) : (h.note ? " — " + esc(h.note) : "")}
            ${ds ? `<div class="muted small">${esc(ds)}</div>` : ""}
            <div class="muted small">${fmtDateTime(h.recorded_at)}${h.recorded_by_name ? " · " + esc(h.recorded_by_name) : ""}${h.visit_id ? " · " + t("visit") + " #" + h.visit_id : ""}${(h.lat != null && h.lng != null) ? ` · <a href="https://www.google.com/maps/search/?api=1&query=${h.lat},${h.lng}" target="_blank" rel="noopener">📍</a>` : ""}</div>
          </div></div>`; }).join("") : `<div class="empty">${t("none")}</div>`}
    </div>
    <div class="form-actions">${can("maps.view") ? `<button class="btn" id="sc-next">📷 ${t("scan_next")}</button>` : ""}
      <button class="btn secondary" id="sc-back">← ${t("back")}</button></div>
  </div></div>`;
  // "Scan next" stays on the same device type — an engineer works one run of
  // traps at a time, and that's the section the inspection files under.
  if ($("sc-next")) $("sc-next").addEventListener("click", () => openQrScanner(null, { type: d.type }));
  if ($("sc-back")) $("sc-back").addEventListener("click", scanGoBack);
  if ($("sc-print")) $("sc-print").addEventListener("click", () => printDeviceCodes([d]));
  if ($("sc-all")) $("sc-all").addEventListener("click", () => navigate("device-history", { id: d.id }));
  // Follow-up actions (replace the trap, reconnect the power) only appear once
  // the field above them reports the fault they answer.
  applyScanConditionals(v);
  v.querySelectorAll(".scan-fields select").forEach(sel =>
    sel.addEventListener("change", () => applyScanConditionals(v)));
  wireScanMulti(v);
  // Status buttons toggle a single selection (default: last-known device status).
  let selSt = d.status && _DEV_STATUSES.includes(d.status) ? d.status : "ok";
  const paint = () => v.querySelectorAll(".scan-st").forEach(b =>
    b.classList.toggle("sel", b.dataset.st === selSt));
  if (canInspect) {
    paint();
    v.querySelectorAll(".scan-st").forEach(b =>
      b.addEventListener("click", () => { selSt = b.dataset.st; paint(); }));
    if ($("sc-save")) $("sc-save").addEventListener("click", () =>
      submitDeviceScan(code, selSt, d.active_visit_id, d.type, v));
  }
}
const _DEV_STATUSES = ["ok", "activity", "needs_service", "missing"];

// Latest inspection this device got on the current active visit — used to
// prefill the fields so re-scanning a device shows what was already entered.
function scanPrefill(d) {
  const h = (d.history || []).find(x => x.visit_id && x.visit_id === d.active_visit_id);
  if (!h || !h.details) return {};
  try { return JSON.parse(h.details); } catch (e) { return {}; }
}

// File one device's inspection. Geo-stamp is best-effort, never blocks the log.
async function submitDeviceScan(code, status, visitId, type, root) {
  const findings = $("sc-find") ? $("sc-find").value.trim() : "";
  const wantGeo = $("sc-geo") && $("sc-geo").checked;
  const details = {};
  (root || document).querySelectorAll(".scan-fields [name]").forEach(el => {
    if (el.value !== "") details[el.name] = el.value;
  });
  const send = async (lat, lng) => {
    try {
      const r = await API.post("/scan/" + code, { status, findings, details, visit_id: visitId || null, lat, lng });
      if (r && r.__queued) { toast(t("saved_offline")); return; }
      toast(t("scan_logged"));
      navigate("scan", { token: code });
    } catch (e) { alert(e.message); }
  };
  if (wantGeo && navigator.geolocation) {
    toast(t("scan_locating"));
    navigator.geolocation.getCurrentPosition(
      p => send(p.coords.latitude, p.coords.longitude),
      () => send(null, null),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 });
  } else { send(null, null); }
}

// One follow-up field's value, as text (no cell padding, no dash for empty).
function fmtDetailVal(f, val) {
  if (f.kind === "num") return String(val);
  if (f.kind === "bool") return t(String(val) === "yes" || val === true ? "yes" : "no");
  if (f.kind === "multi") return splitMulti(val).map(k => t("df_opt_" + k)).join(", ");
  return t("df_opt_" + val);
}

// One follow-up field's value as a printable cell.
function fmtDetailCell(f, val) {
  if (val === undefined || val === "" || val === null) return "—";
  return esc(fmtDetailVal(f, val));
}

// The columns a device type's follow-up table gets: every field except the
// conditional action ones, which ride along inside their parent's cell.
function deviceColumns(type) {
  return (DEVICE_FIELDS[type] || []).filter(f => !f.showIf);
}

// A column's cell for one scanned device, with any action taken appended —
// "Damaged → Replaced". `det` is the parsed details object.
function detailCellHtml(type, f, det) {
  const cell = fmtDetailCell(f, (det || {})[f.key]);
  const act = (DEVICE_FIELDS[type] || []).find(a =>
    a.showIf && a.showIf.key === f.key && (det || {})[a.key]);
  return act ? `${cell} → ${esc(fmtDetailVal(act, det[act.key]))}` : cell;
}

// Printable per-visit follow-up report, laid out like Follow up.pdf: company
// header + one section per device type scanned on the visit, each a table whose
// columns are that type's follow-up fields.
async function printFollowupReport(visitId) {
  let data;
  try { data = await API.get(`/visits/${visitId}/followup`); }
  catch (e) { alert(e.message); return; }
  const groups = data.groups || {};
  if (!Object.keys(groups).length) { toast(t("followup_nothing")); return; }
  const ar = LANG === "ar", dir = ar ? "rtl" : "ltr";
  const S = SETTINGS || {};
  const v = data.visit || {};
  const compName = (ar ? S.company_name_ar : S.company_name_en) || S.company_name_en || "Company";
  const compAddr = (ar ? S.address_ar : S.address_en) || S.address_en || "";
  const logoHtml = S.logo ? `<img src="/uploads/${esc(S.logo)}" style="height:46px">` : `<div style="font-size:32px">🐜</div>`;
  const clientName = ar ? (v.client_ar || v.client_en) : (v.client_en || v.client_ar);
  // Sections in the same order as the printed form.
  const order = DEVICE_SECTION_ORDER;
  const sections = order.filter(ty => (groups[ty] || []).length).map(ty => {
    const fields = deviceColumns(ty);
    const head = `<th>${t("code")}</th><th>${t("label")}</th><th>${t("status")}</th>`
      + fields.map(f => `<th>${esc(t("df_" + f.key))}</th>`).join("");
    const rows = groups[ty].map(r => `<tr>
      <td class="c">${esc(r.code)}</td><td>${esc(r.label || "—")}</td>
      <td>${t("mst_" + r.status)}</td>
      ${fields.map(f => `<td class="c">${detailCellHtml(ty, f, r.details)}</td>`).join("")}
    </tr>`).join("");
    return `<div class="sec"><h3>${esc(t("sec_" + ty))}</h3>
      <table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join("");
  const meta = [
    [t("client"), clientName],
    [t("site_name"), v.site_name],
    [t("agent"), v.agent_name],
    [t("visit"), "#" + String(v.id).padStart(5, "0")],
    [t("date"), fmtDate(v.scheduled_start)],
    [t("visit_number"), v.visit_number],
  ].filter(([, val]) => val != null && String(val).trim() !== "")
    .map(([l, val]) => `<span><b>${esc(l)}:</b> ${esc(String(val))}</span>`).join("");
  const doc = `<!DOCTYPE html><html lang="${LANG}" dir="${dir}"><head><meta charset="utf-8">
    <title>${esc(t("followup_report"))} #${String(v.id).padStart(5, "0")}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
    <style>
      *{box-sizing:border-box}
      body{font-family:${ar ? "'Cairo'" : "'Inter'"},system-ui,sans-serif;color:#1c2733;margin:0;padding:36px;font-size:12px}
      .sheet{max-width:900px;margin:auto}
      .top{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #0f172a;padding-bottom:12px;margin-bottom:8px}
      .co h1{margin:0;font-size:16px}.co .m{color:#64748b;font-size:10px;line-height:1.6}
      .rt{text-align:${ar ? "left" : "right"}}.rt h2{margin:0;font-size:18px}
      .meta{display:flex;flex-wrap:wrap;gap:6px 18px;margin:10px 0 6px;color:#334155}
      .sec{margin-top:16px;break-inside:avoid}.sec h3{margin:0 0 6px;font-size:14px;color:#0f766e}
      table{width:100%;border-collapse:collapse;font-size:11px}
      th,td{border:1px solid #cbd5e1;padding:5px 7px;text-align:${ar ? "right" : "left"};vertical-align:top}
      th{background:#f1f5f9;font-weight:700}.c{text-align:center}
      .noprint{margin-bottom:12px}.pbtn{background:#0f766e;color:#fff;border:none;padding:9px 20px;border-radius:8px;font-size:14px;cursor:pointer}
      @media print{.noprint{display:none}body{padding:0}}
    </style></head><body>
    <div class="sheet">
      <div class="noprint"><button class="pbtn" onclick="window.print()">🖨️ ${esc(t("print"))}</button></div>
      <div class="top">
        <div class="co">${logoHtml}<h1>${esc(compName)}</h1>${compAddr ? `<div class="m">${esc(compAddr)}</div>` : ""}</div>
        <div class="rt"><h2>${esc(t("followup_report"))}</h2></div>
      </div>
      <div class="meta">${meta}</div>
      ${sections}
    </div>
    <script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>
    </body></html>`;
  printHtmlDoc(doc);
}

// Printable label sheet for a set of device codes (big code text + scannable QR).
function printDeviceCodes(devices) {
  const list = (devices || []).filter(d => d.code);
  if (!list.length) { toast(t("no_devices")); return; }
  const S = SETTINGS || {};
  const comp = (LANG === "ar" ? S.company_name_ar : S.company_name_en) || S.company_name_en || "PestCare";
  // The label's own name is the headline — that is what someone standing in
  // front of the trap reads. The code is reference data for the office, so it
  // runs up the side of the label in the same quiet type as the device kind.
  const cells = list.map(d => `
    <div class="label"><div class="side">${esc(d.code)}</div>
      <div class="meta">
        <div class="hl">${esc(d.label || t("dt_" + d.type))}</div>
        ${d.label ? `<div class="dt">${esc(t("dt_" + d.type))}</div>` : ""}
        ${d.placement ? `<div class="pl">${esc(d.placement)}</div>` : ""}
        <div class="dc">${d.client_id ? esc(localized(d, "client")) : ""}</div>
        <div class="cmp">${esc(comp)}</div></div>
      <div class="qr">${qrSvg(codeScanUrl(d.code), 4)}</div></div>`).join("");
  const doc = `<!DOCTYPE html><html lang="${LANG}" dir="${LANG === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8">
    <title>${esc(t("device_codes"))}</title><style>
      *{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;padding:12px}
      .sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
      /* row-reverse in RTL so the physical order stays side / meta / QR — the
         QR always sits on the right edge of the label, in either language. */
      .label{border:1px dashed #94a3b8;border-radius:8px;padding:10px;display:flex;
             flex-direction:${LANG === "ar" ? "row-reverse" : "row"};
             gap:10px;align-items:center;break-inside:avoid}
      /* Code up the side of the label, reading bottom-to-top, in the same
         colour and type as the device kind. */
      .side{writing-mode:vertical-rl;transform:rotate(180deg);align-self:stretch;
            color:#475569;font-size:12px;letter-spacing:.08em;flex:none;
            display:flex;align-items:center;justify-content:center}
      .qr{width:104px;height:104px;flex:none}.qr svg{width:100%;height:100%}
      .meta{font-size:12px;line-height:1.35;overflow:hidden;flex:1;min-width:0}
      .hl{font-weight:800;font-size:17px;letter-spacing:.01em}
      .dt{color:#475569;font-size:12px}.dc{color:#64748b;font-size:11px}
      .pl{color:#475569;font-size:11px}
      .cmp{color:#0f766e;font-weight:600;margin-top:2px;font-size:11px}
      .noprint{margin-bottom:10px}.pbtn{background:#0f766e;color:#fff;border:none;padding:9px 20px;border-radius:8px;font-size:14px;cursor:pointer}
      @media print{.noprint{display:none}body{padding:0}}
    </style></head><body>
    <div class="noprint"><button class="pbtn" onclick="window.print()">🖨️ ${esc(t("print"))}</button></div>
    <div class="sheet">${cells}</div>
    <script>window.onload=function(){setTimeout(function(){window.print()},500)}<\/script>
    </body></html>`;
  printHtmlDoc(doc);
}

// ---- Sidebar: Device QR Codes registry (generate / assign / print / scan) ----
let _devCurrent = [];
let _devFilter = { client_id: "", type: "", site_id: "", unassigned: "" };
// Every branch this user may see, held while the page is open so the branch
// filter can be re-drawn as the client filter changes without another round
// trip.
let _devSites = null;

async function loadDevSites() {
  // Re-read on every visit to the page so a branch added since stays findable;
  // a user who may not list branches simply gets no branch filter.
  try { _devSites = await API.get("/sites"); } catch (e) { _devSites = _devSites || []; }
  return _devSites;
}

async function viewDevices(v) {
  const canManage = can("devices.create");
  const clientOpts = [{ v: "", l: t("all_clients") }].concat(cache.clients.map(c => ({ v: c.id, l: clientLabel(c) })));
  const typeOpts = [{ v: "", l: t("all") }].concat(DEVICE_TYPES.map(x => ({ v: x.k, l: t("dt_" + x.k) })));
  const sel = (id, opts) => `<select id="${id}" class="toolbar-select">${opts.map(o =>
    `<option value="${esc(o.v)}">${esc(o.l)}</option>`).join("")}</select>`;
  v.innerHTML = `
    <div class="page-head"><h2>${t("nav_devices")}</h2>
      ${canManage ? `<button class="btn" id="gen-codes">＋ ${t("generate_codes")}</button>` : ""}</div>
    <div class="muted small" style="margin-bottom:10px">${t("devices_hint")}</div>
    <div class="dev-toolbar">
      ${sel("df-client", clientOpts)} ${sel("df-type", typeOpts)} ${sel("df-site", [])}
      <label class="scan-geo"><input type="checkbox" id="df-unassigned"> ${t("unassigned_only")}</label>
      <span class="spacer"></span>
      ${canManage ? `<button class="btn sm secondary" id="dev-assign" disabled>${t("assign_to_client")}</button>` : ""}
      <button class="btn sm" id="dev-print" disabled>🏷️ ${t("print_selected")}</button>
    </div>
    <div class="panel" id="dev-list">${t("loading")}</div>`;
  $("df-client").value = _devFilter.client_id; $("df-type").value = _devFilter.type;
  $("df-unassigned").checked = !!_devFilter.unassigned;
  // The branch list follows the client filter: pick a client and you only see
  // their branches; pick none and each branch is named with its client.
  const paintSites = (keep) => {
    const box = $("df-site");
    if (!box) return;
    const cid = $("df-client").value;
    const mine = (_devSites || []).filter(s => !cid || String(s.client_id) === String(cid));
    box.classList.toggle("hidden", !mine.length);
    const opts = [{ v: "", l: t("all_branches") }]
      .concat(mine.map(s => ({ v: s.id, l: cid ? s.name : localized(s, "client") + " — " + s.name })))
      .concat([{ v: "none", l: t("no_branch_set") }]);
    box.innerHTML = opts.map(o => `<option value="${esc(o.v)}">${esc(o.l)}</option>`).join("");
    box.value = opts.some(o => String(o.v) === String(keep || "")) ? (keep || "") : "";
  };
  await loadDevSites();
  paintSites(_devFilter.site_id);
  const selectedIds = () => Array.from(document.querySelectorAll(".dev-cb:checked")).map(cb => +cb.dataset.id);
  const updateBulk = () => {
    const n = selectedIds().length;
    if ($("dev-print")) $("dev-print").disabled = !n;
    if ($("dev-assign")) $("dev-assign").disabled = !n;
  };
  const render = (devs) => {
    _devCurrent = devs;
    const box = $("dev-list");
    if (!devs.length) { box.innerHTML = `<div class="empty">${t("devices_none")}</div>`; updateBulk(); return; }
    box.innerHTML = `<table><thead><tr>
      <th class="cb-col"><input type="checkbox" id="dev-all"><span class="pc-only">${t("select_all")}</span></th>
      <th>${t("qr_code")}</th><th>${t("code")}</th><th>${t("marker_type")}</th><th>${t("client")}</th>
      <th>${t("location_lbl")}</th><th>${t("label")}</th><th>${t("status")}</th><th>${t("last_seen")}</th><th></th>
    </tr></thead><tbody>
      ${devs.map(d => `<tr>
        <td><input type="checkbox" class="dev-cb" data-id="${d.id}"></td>
        <td class="qr-td"><button type="button" class="qr-cell" data-qr="${esc(d.code)}" title="${t("print_qr")}">${qrSvg(codeScanUrl(d.code), 2) || "🏷️"}</button></td>
        <td><strong>${esc(d.code)}</strong></td>
        <td>${esc(t("dt_" + d.type))}</td>
        <td>${d.client_id ? esc(localized(d, "client")) : `<span class="muted">${t("unassigned")}</span>`}</td>
        <td>${esc(d.site_name || "—")}</td>
        <td>${esc(d.label || "—")}${d.placement ? `<div class="muted small">${esc(d.placement)}</div>` : ""}</td>
        <td><span style="color:${MARKER_STATUS[d.status] || "#64748b"}">${t("mst_" + d.status)}</span></td>
        <td class="muted small">${d.last_seen ? fmtDateTime(d.last_seen) : "—"}</td>
        <td><div style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn sm secondary" data-open="${esc(d.code)}">${t("open")}</button>
          ${canManage ? `<button class="btn sm secondary" data-edit="${d.id}">✏️</button>` : ""}
        </div></td></tr>`).join("")}
    </tbody></table>`;
    box.querySelectorAll(".dev-cb").forEach(cb => cb.addEventListener("change", updateBulk));
    if ($("dev-all")) $("dev-all").addEventListener("change", e => {
      box.querySelectorAll(".dev-cb").forEach(cb => cb.checked = e.target.checked); updateBulk();
    });
    box.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click",
      () => navigate("scan", { token: b.dataset.open })));
    box.querySelectorAll("[data-qr]").forEach(b => b.addEventListener("click",
      () => printDeviceCodes(_devCurrent.filter(x => x.code === b.dataset.qr))));
    box.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click",
      () => deviceEditDialog(_devCurrent.find(x => x.id == b.dataset.edit), load)));
    updateBulk();
  };
  const load = async () => {
    const qp = [];
    if ($("df-client").value) qp.push("client_id=" + $("df-client").value);
    if ($("df-type").value) qp.push("type=" + $("df-type").value);
    if ($("df-site").value) qp.push("site_id=" + $("df-site").value);
    if ($("df-unassigned").checked) qp.push("unassigned=1");
    _devFilter = { client_id: $("df-client").value, type: $("df-type").value,
                   site_id: $("df-site").value, unassigned: $("df-unassigned").checked ? "1" : "" };
    render(await API.get("/devices" + (qp.length ? "?" + qp.join("&") : "")));
  };
  ["df-client", "df-type", "df-site", "df-unassigned"].forEach(id =>
    $(id).addEventListener("change", () => {
      if (id === "df-client") paintSites("");   // a branch of the old client means nothing now
      load();
    }));
  if ($("gen-codes")) $("gen-codes").addEventListener("click", () => generateCodesDialog(load));
  if ($("dev-print")) $("dev-print").addEventListener("click", () =>
    printDeviceCodes(_devCurrent.filter(d => selectedIds().includes(d.id))));
  if ($("dev-assign")) $("dev-assign").addEventListener("click", () => assignDevicesDialog(selectedIds(), load));
  await load();
}

function generateCodesDialog(onDone) {
  const typeOpts = DEVICE_TYPES.map(x => ({ v: x.k, l: t("dt_" + x.k) }));
  const clientOpts = [{ v: "", l: t("assign_later") }].concat(cache.clients.map(c => ({ v: c.id, l: clientLabel(c) })));
  openModal(t("generate_codes"), `<form id="genf">
    ${field(t("marker_type"), "type", { options: typeOpts })}
    ${field(t("quantity"), "count", { type: "number", value: "50" })}
    ${field(t("assign_to_client"), "client_id", { options: clientOpts })}
    <div class="field"><label>${t("for_site_optional")}</label><select name="site_id"><option value="">${t("none")}</option></select></div>
    ${field(t("placement"), "placement", { value: "", attrs: `placeholder="${esc(t("placement_ph"))}"` })}
    <div class="muted small">${t("placement_hint")}</div>
    <div class="muted small">${t("generate_hint")}</div>
    <div class="form-actions"><button type="button" class="btn secondary" id="gen-x">${t("cancel")}</button>
      <button class="btn" type="submit">${t("generate")}</button></div></form>`, (root) => {
    $("gen-x").addEventListener("click", closeModal);
    const cs = root.querySelector("[name=client_id]"), ss = root.querySelector("[name=site_id]");
    cs.addEventListener("change", () => loadSiteOptions(cs.value, ss, "", t("none")));
    root.querySelector("#genf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formData(root);
      const cnt = parseInt(f.count, 10);
      if (!(cnt >= 1 && cnt <= 500)) { alert(t("count_range")); return; }
      try {
        const r = await API.post("/devices/generate",
          { type: f.type, count: cnt, client_id: f.client_id || null, site_id: f.site_id || null,
            placement: f.placement || null });
        closeModal(); toast(t("codes_generated").replace("{n}", r.codes.length));
        if (onDone) await onDone();
        // Build printable label objects from the returned codes (+ client name).
        const cl = f.client_id ? cache.clients.find(c => String(c.id) === String(f.client_id)) : null;
        const objs = r.codes.map(code => ({ code, type: r.type, client_id: f.client_id || null,
          client_en: cl && cl.name_en, client_ar: cl && cl.name_ar }));
        if (confirm(t("print_now_q"))) printDeviceCodes(objs);
      } catch (err) { alert(err.message); }
    });
  });
}

function assignDevicesDialog(ids, onDone) {
  if (!ids.length) return;
  const clientOpts = [{ v: "", l: t("select") }].concat(cache.clients.map(c => ({ v: c.id, l: clientLabel(c) })));
  openModal(t("assign_to_client"), `<form id="asf">
    <div class="muted small" style="margin-bottom:8px">${t("assign_count").replace("{n}", ids.length)}</div>
    ${field(t("client"), "client_id", { options: clientOpts })}
    <div class="field"><label>${t("for_site_optional")}</label><select name="site_id"><option value="">${t("none")}</option></select></div>
    <div class="form-actions"><button type="button" class="btn secondary" id="as-x">${t("cancel")}</button>
      <button class="btn" type="submit">${t("assign")}</button></div></form>`, (root) => {
    $("as-x").addEventListener("click", closeModal);
    const cs = root.querySelector("[name=client_id]"), ss = root.querySelector("[name=site_id]");
    cs.addEventListener("change", () => loadSiteOptions(cs.value, ss, "", t("none")));
    root.querySelector("#asf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formData(root);
      if (!f.client_id) { alert(t("select_client")); return; }
      try {
        await API.post("/devices/assign", { ids, client_id: +f.client_id, site_id: f.site_id || null });
        closeModal(); toast(t("saved")); if (onDone) await onDone();
      } catch (err) { alert(err.message); }
    });
  });
}

function deviceEditDialog(d, onDone) {
  if (!d) return;
  const statusOpts = ["ok", "activity", "needs_service", "missing"].map(s => ({ v: s, l: t("mst_" + s) }));
  const clientOpts = [{ v: "", l: t("unassigned") }].concat(cache.clients.map(c => ({ v: c.id, l: clientLabel(c) })));
  openModal(d.code, `<form id="edf">
    ${field(t("label"), "label", { value: d.label })}
    ${field(t("placement"), "placement", { value: d.placement, attrs: `placeholder="${esc(t("placement_ph"))}"` })}
    ${field(t("client"), "client_id", { options: clientOpts, value: d.client_id || "" })}
    <div class="field"><label>${t("location_lbl")}</label><select name="site_id"><option value="">${t("none")}</option></select></div>
    ${field(t("status"), "status", { options: statusOpts, value: d.status })}
    <div class="form-actions"><button type="button" class="btn danger" id="ed-del" style="margin-inline-end:auto">${t("delete")}</button>
      <button type="button" class="btn secondary" id="ed-x">${t("cancel")}</button>
      <button class="btn" type="submit">${t("save")}</button></div></form>`, (root) => {
    $("ed-x").addEventListener("click", closeModal);
    const cs = root.querySelector("[name=client_id]"), ss = root.querySelector("[name=site_id]");
    loadSiteOptions(d.client_id, ss, d.site_id, t("none"));
    cs.addEventListener("change", () => loadSiteOptions(cs.value, ss, "", t("none")));
    $("ed-del").addEventListener("click", async () => {
      if (!confirm(t("confirm_delete"))) return;
      await API.del("/devices/" + d.id); closeModal(); toast(t("saved")); if (onDone) await onDone();
    });
    root.querySelector("#edf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formData(root);
      try {
        await API.put("/devices/" + d.id,
          { label: f.label, placement: f.placement, client_id: f.client_id || null,
            site_id: f.site_id || null, status: f.status });
        closeModal(); toast(t("saved")); if (onDone) await onDone();
      } catch (err) { alert(err.message); }
    });
  });
}

// Legacy floor-plan marker scan (kept for users still placing pins on map images).
function renderMarkerScan(v, token, d) {
  const canInspect = can("maps.edit");
  const stBtns = ["ok", "activity", "needs_service", "missing"].map(s =>
    `<button class="scan-st" data-st="${s}" style="--c:${MARKER_STATUS[s]}">${t("mst_" + s)}</button>`).join("");
  v.innerHTML = `<div class="scan-wrap"><div class="scan-card">
    <div class="scan-head">
      <div class="scan-ic" style="background:${MARKER_STATUS[d.status] || "#64748b"}">${markerIcon(d.type)}</div>
      <div><div class="scan-title">${esc(d.label || t("type_" + d.type))}</div>
        <div class="muted small">${esc(t("type_" + d.type))} · ${esc(localized(d, "client"))}${d.site_name ? " · " + esc(d.site_name) : ""}</div></div>
    </div>
    ${canInspect ? `<div class="scan-q">${t("scan_prompt")}</div>
      <div class="scan-sts">${stBtns}</div>
      <textarea id="sc-note" class="scan-note" rows="2" placeholder="${t("marker_notes")}"></textarea>
      <label class="scan-geo"><input type="checkbox" id="sc-geo" checked> ${t("scan_geostamp")}</label>`
      : `<div class="muted" style="margin:12px 0">${t("scan_readonly")}</div>`}
    <div class="scan-hist"><h3>${t("scan_history")}</h3>
      ${(d.history || []).length ? d.history.map(h => `
        <div class="scan-ev"><span class="dot" style="background:${MARKER_STATUS[h.status] || "#64748b"}"></span>
          <div class="se-main"><strong>${t("mst_" + h.status)}</strong>${h.note ? " — " + esc(h.note) : ""}
            <div class="muted small">${fmtDateTime(h.recorded_at)}${h.recorded_by_name ? " · " + esc(h.recorded_by_name) : ""}</div>
          </div></div>`).join("") : `<div class="empty">${t("none")}</div>`}
    </div>
    <div class="form-actions"><button class="btn secondary" id="sc-back">← ${t("back")}</button></div>
  </div></div>`;
  if ($("sc-back")) $("sc-back").addEventListener("click", scanGoBack);
  if (canInspect) v.querySelectorAll(".scan-st").forEach(b =>
    b.addEventListener("click", () => submitScan(token, b.dataset.st)));
}
async function submitScan(token, status) {
  const note = $("sc-note") ? $("sc-note").value.trim() : "";
  const wantGeo = $("sc-geo") && $("sc-geo").checked;
  const send = async (lat, lng) => {
    try {
      const r = await API.post("/scan/" + token, { status, note, lat, lng });
      if (r && r.__queued) { toast(t("saved_offline")); return; }
      toast(t("scan_logged")); navigate("scan", { token });
    } catch (e) { alert(e.message); }
  };
  if (wantGeo && navigator.geolocation) {
    toast(t("scan_locating"));
    navigator.geolocation.getCurrentPosition(
      p => send(p.coords.latitude, p.coords.longitude),
      () => send(null, null), { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 });
  } else { send(null, null); }
}
// Printable QR sheet for a floor-plan map's markers (legacy).
function printQrSheet(map, only) {
  const markers = (only ? [only] : map.markers).filter(m => m.qr_token);
  if (!markers.length) { toast(t("no_devices")); return; }
  printDeviceCodes(markers.map(m => ({ code: m.qr_token, type: m.type, label: m.label,
    client_id: map.client_id, client_en: map.client_en, client_ar: map.client_ar })));
}


// Per-visit device coverage panel: how many traps the agent scanned this visit.
async function loadVisitCoverage(visitId) {
  const box = $("dev-coverage");
  if (!box) return;
  let cov;
  try { cov = await API.get(`/visits/${visitId}/devices`); }
  catch (e) { box.remove(); return; }
  if (!cov.total) {
    box.innerHTML = `<div class="section-title"><h3>🏷️ ${t("device_coverage")}</h3></div>
      <div class="empty">${t("no_devices_for_client")}</div>`;
    return;
  }
  const pct = Math.round((cov.scanned / cov.total) * 100);
  const done = cov.scanned === cov.total;
  const canScan = can("maps.edit");

  // One block per device type, each with its own scan button, so the engineer
  // working the light traps scans from the light-trap section — and a code from
  // another type scanned there is turned away instead of quietly filing the
  // inspection under the wrong heading.
  const groups = DEVICE_TYPES
    .map(dt => ({ key: dt.k, name: t("sec_" + dt.k),
                  rows: cov.devices.filter(d => d.type === dt.k) }))
    .filter(g => g.rows.length);
  const rest = cov.devices.filter(d => !DEVICE_TYPES.some(x => x.k === d.type));
  if (rest.length) groups.push({ key: "", name: t("other_devices"), rows: rest });

  box.innerHTML = `<div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
      <h3>🏷️ ${t("device_coverage")} <span class="badge b-${done ? "completed" : "draft"}">${cov.scanned}/${cov.total} ${t("scanned")}</span></h3>
      ${cov.scanned ? `<button class="btn sm secondary" id="cov-followup">🖨️ ${t("followup_report")}</button>` : ""}</div>
    <div class="cov-bar"><span style="width:${pct}%"></span></div>
    ${groups.map(g => {
      const got = g.rows.filter(d => d.scanned_at).length;
      return `<div class="cov-group">
        <div class="cov-head">
          <h4>${esc(g.name)}
            <span class="badge b-${got === g.rows.length ? "completed" : "draft"}">${got}/${g.rows.length}</span></h4>
          ${canScan && g.key ? `<button class="btn sm" data-scantype="${g.key}">📷 ${t("scan_qr")}</button>` : ""}
        </div>
        <table><thead><tr><th>${t("code")}</th><th>${t("label")}</th>
          <th>${t("status")}</th><th>${t("scanned")}</th></tr></thead>
          <tbody>${g.rows.map(d => `<tr class="${d.scanned_at ? "" : "cov-pending"}">
            <td><a href="#" data-open="${esc(d.code)}"><strong>${esc(d.code)}</strong></a></td>
            <td>${esc(d.label || "—")}${d.placement ? `<div class="muted small">${esc(d.placement)}</div>` : ""}</td>
            <td><span style="color:${MARKER_STATUS[d.status] || "#64748b"}">${t("mst_" + d.status)}</span></td>
            <td>${d.scanned_at ? "✓ " + fmtDateTime(d.scanned_at) : `<span class="muted">${t("pending")}</span>`}</td>
          </tr>`).join("")}</tbody></table></div>`;
    }).join("")}`;

  box.querySelectorAll("[data-open]").forEach(a => a.addEventListener("click", (e) => {
    e.preventDefault(); navigate("scan", { token: a.dataset.open });
  }));
  box.querySelectorAll("[data-scantype]").forEach(b => b.addEventListener("click", () =>
    openQrScanner(null, { type: b.dataset.scantype })));
  if ($("cov-followup")) $("cov-followup").addEventListener("click", () => printFollowupReport(visitId));
}

// ====================================================================
// In-app QR scanner (camera)
// --------------------------------------------------------------------
// The camera needs a SECURE ORIGIN — https:// or localhost. Over plain http
// (e.g. the old http://<ip>:8000 address, or the Android app pointed at it)
// navigator.mediaDevices is simply absent, so we say so instead of failing
// mutely, and the typed-code box below the viewfinder always works.
// Decoding: BarcodeDetector where the browser has it (Chrome/Android), else
// the vendored jsQR (iOS Safari), loaded on demand.
// ====================================================================
let jsqrLoad = null;
function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsqrLoad) {
    jsqrLoad = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/js/jsqr.js";
      s.onload = () => resolve(window.jsQR);
      s.onerror = () => { jsqrLoad = null; reject(new Error("jsqr")); };
      document.head.appendChild(s);
    });
  }
  return jsqrLoad;
}

// A label may encode a full URL (https://host/scan/LIT0001 — possibly from the
// old http://<ip>:8000 print run) or the bare code. Take the code either way.
function codeFromScan(text) {
  const s = (text || "").trim();
  const m = s.match(/\/scan\/([A-Za-z0-9]+)/)
    || s.match(/^([A-Za-z]{3}\d{4,})$/)
    || s.match(/^([0-9a-fA-F]{24,})$/);      // legacy floor-plan marker token
  return m ? m[1] : "";
}

// Device codes carry their type in the prefix (LIT0001 -> light_trap), which is
// what lets a section's scan button reject a code that belongs elsewhere
// without a round trip. "" for a legacy floor-plan marker token.
function typeFromCode(code) {
  const m = DEVICE_TYPES.find(x => x.pre === (code || "").slice(0, 3).toUpperCase());
  return m ? m.k : "";
}

function cameraBlockedReason() {
  if (!window.isSecureContext) return t("camera_needs_https");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return t("camera_unavailable");
  return "";
}

// Open the viewfinder. `onCode` defaults to jumping to that device's scan page.
// `opts.type` pins the scanner to one device type: the dialog says which type
// it is filing, and a code from another type is refused at the viewfinder with
// an explanation instead of opening the wrong section's form.
function openQrScanner(onCode, opts) {
  const handle = onCode || ((code) => navigate("scan", { token: code }));
  const want = (opts && opts.type) || "";
  const wantDt = DEVICE_TYPES.find(x => x.k === want);
  const blocked = cameraBlockedReason();
  // A scan is a scan, for everybody. The device trail is only proof someone
  // stood in front of the trap if the code came off the label through the
  // camera — typing it is something that can be done from the van — so there
  // is no box to type it into, and a blocked camera is not a way round it.
  const title = wantDt ? `${wantDt.icon} ${t("sec_" + want)} — ${t("scan_qr")}` : `📷 ${t("scan_qr")}`;
  openModal(title, `<div class="qr-scan">
    ${blocked ? `<div class="scan-now warn-line">${esc(blocked)}</div>`
      : `<div class="qr-view"><video id="qr-video" playsinline muted autoplay></video><div class="qr-frame"></div></div>
         <div class="muted small" id="qr-hint">${wantDt
             ? esc(t("scan_type_hint").replace("{type}", t("sec_" + want)).replace("{pre}", wantDt.pre))
             : t("scan_camera_hint")}</div>`}
    <div class="muted small" style="margin-top:12px">${t("scan_only_hint")}</div>
    <div class="form-actions"><button class="btn secondary" id="qr-cancel">${t("cancel")}</button></div>
  </div>`, (root) => {
    // Returns false when the code belongs to another section, which keeps the
    // camera running so the engineer can just aim at the right label.
    const finish = (code) => {
      const got = typeFromCode(code);
      if (want && got && got !== want) {
        const hint = root.querySelector("#qr-hint");
        const msg = t("scan_wrong_type").replace("{got}", t("sec_" + got)).replace("{want}", t("sec_" + want));
        if (hint) hint.innerHTML = `<span class="warn-line">${esc(msg)}</span>`;
        else alert(msg);
        return false;
      }
      closeModal(); handle(code);
      return true;
    };
    root.querySelector("#qr-cancel").addEventListener("click", closeModal);
    if (blocked) return;
    startQrCamera(root.querySelector("#qr-video"), root.querySelector("#qr-hint"), finish);
  });
}

// Live camera capture for attachments. Another secure-origin feature, so it
// only ever appears when getUserMedia is actually there. Frames are grabbed off
// the video into a canvas and handed back as JPEG Files, which means a shot
// travels the same upload path — and the same offline queue — as a file picked
// from the gallery. Returns {shoot, stop}; `shoot` resolves to a File or null.
async function startPhotoCamera(video, hint) {
  let stream = null, stopped = false;
  const stop = () => {
    stopped = true;
    if (stream) stream.getTracks().forEach(tr => tr.stop());
    stream = null;
  };
  const dead = { shoot: () => Promise.resolve(null), stop };
  onModalClose(stop);   // closing the dialog releases the camera
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } }, audio: false });
  } catch (e) {
    if (hint) hint.innerHTML = `<span class="warn-line">${esc(
      e && e.name === "NotAllowedError" ? t("camera_denied") : t("camera_unavailable"))}</span>`;
    return dead;
  }
  if (stopped) { stream.getTracks().forEach(tr => tr.stop()); return dead; }  // closed while asking
  video.srcObject = stream;
  try { await video.play(); } catch (e) { /* autoplay guard */ }
  const shoot = () => new Promise((resolve) => {
    if (stopped || !video.videoWidth) return resolve(null);
    const cv = document.createElement("canvas");
    cv.width = video.videoWidth; cv.height = video.videoHeight;
    cv.getContext("2d").drawImage(video, 0, 0, cv.width, cv.height);
    cv.toBlob((b) => resolve(b ? new File([b], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }) : null),
              "image/jpeg", 0.86);
  });
  return { shoot, stop };
}

// Stream the back camera into `video` and poll it for a QR ~8x a second.
async function startQrCamera(video, hint, onCode) {
  let stream = null, stopped = false, timer = null;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    if (stream) stream.getTracks().forEach(tr => tr.stop());
    stream = null;
  };
  onModalClose(stop);   // closing the dialog releases the camera
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } }, audio: false });
  } catch (e) {
    if (hint) hint.innerHTML = `<span class="warn-line">${esc(
      e && e.name === "NotAllowedError" ? t("camera_denied") : t("camera_unavailable"))}</span>`;
    return;
  }
  if (stopped) { stream.getTracks().forEach(tr => tr.stop()); return; }   // closed while asking
  video.srcObject = stream;
  try { await video.play(); } catch (e) { /* autoplay guard; the poll still reads frames */ }

  let detector = null;
  try {
    if ("BarcodeDetector" in window) {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    }
  } catch (e) { detector = null; }
  let decode = null;
  if (!detector) {
    try { decode = await loadJsQr(); }
    catch (e) {
      if (hint) hint.innerHTML = `<span class="warn-line">${esc(t("camera_unavailable"))}</span>`;
      return;
    }
  }
  const cv = document.createElement("canvas");
  let busy = false;
  timer = setInterval(async () => {
    if (stopped || busy || !video.videoWidth) return;
    busy = true;
    try {
      let raw = "";
      if (detector) {
        const hits = await detector.detect(video);
        if (hits.length) raw = hits[0].rawValue;
      } else {
        cv.width = video.videoWidth; cv.height = video.videoHeight;
        const cx = cv.getContext("2d", { willReadFrequently: true });
        cx.drawImage(video, 0, 0, cv.width, cv.height);
        const img = cx.getImageData(0, 0, cv.width, cv.height);
        const hit = decode(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (hit) raw = hit.data;
      }
      const code = codeFromScan(raw);
      // onCode returning false = "not this one" (wrong device type); keep the
      // camera alive so the next label can be read without reopening.
      if (code) { if (onCode(code) !== false) stop(); }
      else if (raw && hint) hint.innerHTML = `<span class="warn-line">${esc(t("device_unknown"))}</span>`;
    } catch (e) { /* a bad frame is not an error */ }
    busy = false;
  }, 120);
}

// ====================================================================
// PWA: register the service worker for offline app-shell loading, AND notice
// when new web code has been deployed.
//
// The second half is not a nicety: changing the web app is meant to reach every
// installed APK with no rebuild, and that silently did not happen. The WebView
// restores its previous page when the app is resumed rather than navigating,
// pull-to-refresh is switched off (a stray swipe used to throw away a report),
// and ↻ re-fetches the screen's data without reloading the page — so a running
// install could serve last week's app.js indefinitely. Now a new service worker
// version is picked up and applied.
let swUpdatePending = false;
let swReloading = false;
let swUpdateAnnounced = false;

// A reload must never eat what someone is typing — that is exactly why
// pull-to-refresh was disabled. An open dialog or a focused field means "later";
// the update is applied on the next screen change instead (see navigate()).
function safeToReloadNow() {
  const overlay = $("modal-overlay");
  if (overlay && !overlay.classList.contains("hidden")) return false;
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
  return true;
}
function applyPendingUpdate() {
  if (!swUpdatePending || swReloading) return;
  if (!safeToReloadNow()) {
    if (!swUpdateAnnounced) { swUpdateAnnounced = true; toast(t("update_ready")); }
    return;
  }
  swReloading = true;
  location.reload();
}
function markSwUpdate() {
  if (swUpdatePending) return;
  swUpdatePending = true;
  const btn = $("nav-refresh");
  if (btn) { btn.classList.add("has-update"); btn.title = t("update_ready"); }
  applyPendingUpdate();
}

if ("serviceWorker" in navigator) {
  // A page with no controller is a first visit: the worker claiming it is not an
  // update, so don't reload for it.
  const hadController = !!navigator.serviceWorker.controller;
  let swReg = null;
  let lastUpdateCheck = 0;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      swReg = reg;
      if (reg.waiting && hadController) markSwUpdate();
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && hadController) markSwUpdate();
        });
      });
    }).catch((e) => console.warn("SW registration failed", e));
  });
  // The new worker announces itself here (it also force-navigates pages too old
  // to answer). Acking tells it this page will handle its own reload.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (!e.data || e.data.type !== "sw-updated") return;
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: "sw-update-ack" });
    }
    markSwUpdate();
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) markSwUpdate();
  });
  // LOOK FOR NEW CODE: on resume, on a timer, when the signal comes back, and
  // whenever ↻ is pressed. A page in the installed app can stay open for days —
  // the WebView restores it instead of navigating — so if nothing here asks,
  // nothing ever tells it that a fix has shipped. Resume alone was not enough:
  // an app left open in the foreground never fires visibilitychange at all.
  function checkForNewCode(force) {
    if (!swReg) return;
    if (!force && Date.now() - lastUpdateCheck < 120000) return;   // at most every 2 min
    lastUpdateCheck = Date.now();
    swReg.update().catch(() => { /* offline — try again next time */ });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkForNewCode(false);
  });
  window.addEventListener("online", () => checkForNewCode(true));
  setInterval(() => { if (!document.hidden) checkForNewCode(false); }, 15 * 60 * 1000);
  // ↻ already re-fetches the screen's data; it now also asks whether the app
  // itself has been updated, which makes it the one button that fixes "my phone
  // still has the old version".
  if ($("nav-refresh")) $("nav-refresh").addEventListener("click", () => checkForNewCode(true));
}

// Install to the home screen. Sits in the sidebar next to Logout, so every role
// sees it.
//
// `beforeinstallprompt` is the good path — Chrome hands over a real install
// dialog — but a button that only appears when it fires can never appear at all
// on a phone: Safari does not implement the event, Chrome withholds it until its
// own engagement heuristics are satisfied, and it never fires once the app is
// installed. That is why this was missing on mobile. So the button is offered on
// any phone browser, and falls back to telling the user where their browser
// keeps the option. index.html captures the event before app.js parses.
const isStandalone = () =>
  (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
  window.navigator.standalone === true;

const hideInstall = () => {
  window.__pcInstallEvt = null;
  if ($("install-btn")) $("install-btn").classList.add("hidden");
};
function showInstall() {
  const b = $("install-btn");
  if (!b || IS_APP || isStandalone()) return;   // already an app — nothing to install
  b.textContent = "📲 " + t("install_app");
  b.classList.remove("hidden");
}
window.addEventListener("pc-installable", showInstall);
window.addEventListener("appinstalled", hideInstall);
// Touch browsers get the button whether or not the native prompt ever arrives.
// Deliberately its own check rather than reusing the pc-narrow layout class:
// a tablet is wide enough to skip the layout fix but still wants installing.
const canInstallHere = !IS_APP && window.matchMedia &&
  window.matchMedia("(pointer: coarse)").matches;
if (canInstallHere || window.__pcInstallEvt) showInstall();

if ($("install-btn")) $("install-btn").addEventListener("click", async () => {
  const evt = window.__pcInstallEvt;
  if (evt) {
    hideInstall();             // a captured prompt can only be used once
    try { evt.prompt(); await evt.userChoice; } catch (e) { /* dismissed */ }
    return;
  }
  // No native prompt on this browser — point at the menu item instead.
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  openModal("📲 " + t("install_app"),
    `<p>${esc(t(ios ? "install_hint_ios" : "install_hint_android"))}</p>
     <div class="form-actions"><button class="btn" id="inst-ok">${t("done")}</button></div>`,
    (root) => root.querySelector("#inst-ok").addEventListener("click", closeModal));
});

boot();
