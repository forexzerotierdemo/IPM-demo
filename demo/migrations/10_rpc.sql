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
