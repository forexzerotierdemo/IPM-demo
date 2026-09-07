-- list_visits() hands a client account `u.full_name agent_name` — the portal
-- is meant to show the customer which engineer is coming, which is half the
-- point of "every branch has an owner, the customer sees the same face".
-- §6.4's users policy grants a client nothing, so v_visits' join produced
-- NULL and the portal drew an em-dash in the Engineer column.
--
-- Scoped, not blanket: a portal login sees the name of an engineer who has
-- actually been sent to them, and no other staff row. The lookup is
-- SECURITY DEFINER so the policy on `users` does not re-enter `visits`.
CREATE OR REPLACE FUNCTION app_client_agent_ids() RETURNS SETOF bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$fn$ SELECT DISTINCT v.agent_id FROM visits v
      WHERE v.agent_id IS NOT NULL
        AND app_role() = 'client'
        AND v.client_id = app_client_id()
        AND (app_site_id() IS NULL OR v.site_id IS NULL OR v.site_id = app_site_id()) $fn$;

CREATE POLICY users_portal_sel ON users FOR SELECT TO authenticated
  USING (app_role() = 'client' AND id IN (SELECT app_client_agent_ids()));
