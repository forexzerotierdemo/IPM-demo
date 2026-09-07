// supabase/functions/api/index.ts — §9.2, the catch-all.
//
// The shim's routing table answers the plain CRUD and the cheap aggregates
// directly from PostgREST. Everything else lands here, so the 83 computed
// routes can be ported one at a time and the app keeps working throughout.
//
// The client below is built from the CALLER's JWT, never the service-role
// key: that keeps every RLS policy from §6 in force inside the function.
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

const rows = async (db: any, t: string, build?: (q: any) => any) => {
  let q = db.from(t).select("*");
  if (build) q = build(q);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
};

const today = () =>
  new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10); // Africa/Cairo
const monthKey = () => today().slice(0, 7);

// ---- the ported handlers ---------------------------------------------

// NOTE: /dispatch/grid, /cell, /sla and /move are NOT here. They are SQL
// functions (migrations/21_dispatch.sql) called straight from the shim's
// routing table, because every one of them is a counting or a scoping
// question and SECURITY INVOKER makes the caller's own policies do the
// scoping. Only /dispatch/optimize is below, because nearest-neighbour
// routing is the one part that genuinely needs a procedural language.

// ---- geo ---------------------------------------------------------------
// Great-circle distance in km between two [lat, lng] pairs.
function haversine(a: number[], b: number[]) {
  const R = 6371.0, rad = (x: number) => (x * Math.PI) / 180;
  const [lat1, lng1, lat2, lng2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const dlat = lat2 - lat1, dlng = lng2 - lng1;
  const h = Math.sin(dlat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Total path length (km) visiting `points` in order.
const routeKm = (pts: number[][]) =>
  pts.slice(1).reduce((sum, p, i) => sum + haversine(pts[i], p), 0);

// A visit's coordinates: its branch's lat/lng, else a "lat,lng" pair typed
// into the visit's free-text location. Returns null if it has neither.
function visitGeo(v: any): number[] | null {
  if (v.site_lat != null && v.site_lng != null) return [v.site_lat, v.site_lng];
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(v.location || ""));
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

const SLOT_MIN = 90;   // minutes between visits when applying an optimized route

// Order one engineer's day to minimise driving (nearest-neighbour on the
// branch coordinates). Preview by default; apply:true rewrites the day's
// scheduled times into the optimised sequence, first visit keeping the
// day's original first hour.
route("POST", /^\/dispatch\/optimize$/, async ({ db, body }) => {
  // dispatch_optimize requires BOTH dispatch.view and visits.edit, and
  // applying it rewrites a whole day's times — so it is gated here exactly
  // as require_perm() gates it in server.py. RLS alone would not do: the
  // caller can read their own visits, and reading is not permission to
  // rewrite the day.
  const { data: perms } = await db.rpc("my_permissions");
  if (!perms?.["dispatch.view"] || !perms?.["visits.edit"]) {
    throw new Error("Not permitted");
  }
  const agentId = Number(body?.agent_id);
  const date = String(body?.date || "");
  if (!agentId || !date) throw new Error("An engineer and a date are required");

  const { data: visits, error } = await db
    .from("v_visits")
    .select("id,scheduled_start,location,client_en,client_ar,site_name,site_lat,site_lng")
    .eq("agent_id", agentId)
    .gte("scheduled_start", date)
    .lte("scheduled_start", date + " 23:59:59")
    .in("status", ["scheduled", "in_progress"])
    .order("scheduled_start");
  if (error) throw new Error(error.message);

  const geo: any[] = [], ungeo: any[] = [];
  for (const v of visits ?? []) {
    const g = visitGeo(v);
    if (g) { v.lat = g[0]; v.lng = g[1]; geo.push(v); } else ungeo.push(v);
  }

  // Start point: the company's own coordinates if the office has set them,
  // else the first stop — in which case the first leg is free and the saving
  // is understated rather than invented. has_start tells the sheet which.
  const { data: geoSetting } = await db.from("settings")
    .select("value").eq("key", "company_geo").maybeSingle();
  const parsed = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/
    .exec(String(geoSetting?.value || ""));
  let start: number[] | null = parsed ? [parseFloat(parsed[1]), parseFloat(parsed[2])] : null;
  const hasStart = !!start;
  if (!start && geo.length) start = [geo[0].lat, geo[0].lng];
  const pre = start ? [start] : [];
  const length = (seq: any[]) => routeKm([...pre, ...seq.map(g => [g.lat, g.lng])]);

  const kmBefore = length(geo);

  const remaining = geo.slice(), optimized: any[] = [];
  let cur = start ?? (remaining.length ? [remaining[0].lat, remaining[0].lng] : null);
  while (remaining.length && cur) {
    let best = 0;
    for (let i = 1; i < remaining.length; i++) {
      if (haversine(cur, [remaining[i].lat, remaining[i].lng]) <
          haversine(cur, [remaining[best].lat, remaining[best].lng])) best = i;
    }
    const nxt = remaining.splice(best, 1)[0];
    optimized.push(nxt);
    cur = [nxt.lat, nxt.lng];
  }
  const kmAfter = length(optimized);

  // The ones with no coordinates keep their place at the end: they cannot be
  // routed, but they are still the engineer's work and must not vanish.
  const final = [...optimized, ...ungeo];
  let applied = false;

  if (body?.apply && final.length) {
    const starts = (visits ?? []).map((v: any) => v.scheduled_start).filter(Boolean).sort();
    const firstT = starts.length ? String(starts[0]).slice(11, 16) : "09:00";
    const base = new Date(`${date}T${/^\d{2}:\d{2}$/.test(firstT) ? firstT : "09:00"}:00Z`);
    for (let i = 0; i < final.length; i++) {
      const t = new Date(base.getTime() + i * SLOT_MIN * 60000);
      const stamp = t.toISOString().slice(0, 19).replace("T", " ");
      const { error: e2 } = await db.from("visits")
        .update({ scheduled_start: stamp }).eq("id", final[i].id);
      if (e2) throw new Error(e2.message);
    }
    applied = true;
  }

  return {
    agent_id: agentId, date, applied,
    km_before: Math.round(kmBefore * 100) / 100,
    km_after: Math.round(kmAfter * 100) / 100,
    km_saved: Math.round(Math.max(0, kmBefore - kmAfter) * 100) / 100,
    stops: geo.length, ungeocoded: ungeo.length,
    has_start: hasStart,
    order: final.map((v, i) => ({
      id: v.id, seq: i + 1, client_en: v.client_en, client_ar: v.client_ar,
      site_name: v.site_name, scheduled_start: v.scheduled_start,
      lat: v.lat ?? null, lng: v.lng ?? null,
    })),
  };
});

// A branch's own diary — the follow-up sheet reads it.
route("GET", /^\/visits\/(\d+)\/followup$/, async ({ db, m }) => {
  const visit = await rows(db, "v_visits", (s: any) => s.eq("id", m[1]));
  const v = (visit as any[])[0];
  if (!v) throw new Error("Visit not found");
  const history = await rows(db, "v_visits", (s: any) =>
    s.eq("site_id", v.site_id).eq("status", "completed")
     .order("scheduled_start", { ascending: false }).limit(6));
  return { visit: v, history };
});

// The engineer scorecard: completed work and paperwork owed, per engineer.
route("GET", /^\/engineers\/scorecard$/, async ({ db }) => {
  const agents = await rows(db, "v_users", (s: any) =>
    s.in("role", ["agent", "area_manager", "team_leader"]).eq("active", 1).order("full_name"));
  const visits = await rows(db, "v_visits", (s: any) =>
    s.gte("scheduled_start", monthKey() + "-01"));
  const by: Record<string, any> = {};
  for (const a of agents as any[]) {
    by[a.id] = { agent_id: a.id, agent_name: a.full_name, total: 0,
                 completed: 0, reports_done: 0, reports_due: 0 };
  }
  for (const v of visits as any[]) {
    const b = by[v.agent_id];
    if (!b) continue;
    b.total++;
    if (v.status === "completed") {
      b.completed++;
      if (v.has_report) b.reports_done++; else b.reports_due++;
    }
  }
  return Object.values(by);
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  // The edge runtime hands this function "/api/<rest>"; a direct call to the
  // gateway carries the full "/functions/v1/api/<rest>". Strip whichever
  // prefix is actually there, so both spellings route the same.
  const path = url.pathname
    .replace(/^\/functions\/v1\/api/, "")
    .replace(/^\/api/, "") || "/";

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
      return new Response(JSON.stringify({ error: String((e as Error).message || e) }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
  }

  // Not ported yet. Say so in the shape app.js already knows how to render,
  // so an unfinished screen reads as empty rather than as a crash.
  return new Response(
    JSON.stringify({ error: "Not available in this demo", __unported: path, items: [], total: 0 }),
    { status: 501, headers: { ...cors, "Content-Type": "application/json" } });
});
