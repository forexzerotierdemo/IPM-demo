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
$$ SELECT area_id FROM area_manager_areas WHERE manager_id = app_uid() $$;

-- A team leader answers for PEOPLE: their own id plus everyone reporting to them.
CREATE OR REPLACE FUNCTION app_team_ids() RETURNS SETOF bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT app_uid()
   UNION
   SELECT id FROM users WHERE team_leader_id = app_uid() $$;
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
