-- list_devices() scopes an area manager to the traps standing in their patch:
-- the device's branch area, falling back to its client's, exactly as a visit's
-- area is derived. Unassigned stock belongs to the office, not to a patch.
CREATE OR REPLACE FUNCTION app_client_area_id(p_client_id bigint) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$fn$ SELECT area_id FROM clients WHERE id = p_client_id $fn$;

CREATE POLICY devices_area_scope ON devices AS RESTRICTIVE FOR ALL TO authenticated
  USING (app_role() <> 'area_manager'
         OR COALESCE(app_site_area_id(site_id), app_client_area_id(client_id))
              IN (SELECT app_area_ids()));
