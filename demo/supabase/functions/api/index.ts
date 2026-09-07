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

// The month/week dispatch board: every visit in the window, grouped by day,
// which is all the grid draws. Scoped by RLS, so a supervisor's board is
// their patch's without a role branch here.
route("GET", /^\/dispatch\/grid$/, async ({ db, q }) => {
  const from = q.get("from") || monthKey() + "-01";
  const to = q.get("to") || monthKey() + "-31";
  const visits = await rows(db, "v_visits", (s: any) =>
    s.gte("scheduled_start", from).lte("scheduled_start", to + " 23:59:59")
     .order("scheduled_start"));
  const days: Record<string, unknown[]> = {};
  for (const v of visits as any[]) {
    const d = String(v.scheduled_start || "").slice(0, 10);
    if (!d) continue;
    (days[d] ||= []).push(v);
  }
  const agents = await rows(db, "v_users", (s: any) =>
    s.in("role", ["agent", "area_manager", "team_leader"]).eq("active", 1).order("full_name"));
  return { from, to, days, agents, total: (visits as any[]).length };
});

// One cell of that board: a day and an engineer.
route("GET", /^\/dispatch\/cell$/, async ({ db, q }) => {
  const date = q.get("date") || today();
  const agent = q.get("agent");
  const visits = await rows(db, "v_visits", (s: any) => {
    let x = s.gte("scheduled_start", date).lte("scheduled_start", date + " 23:59:59");
    if (agent) x = x.eq("agent_id", agent);
    return x.order("scheduled_start");
  });
  return { date, agent, visits };
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
