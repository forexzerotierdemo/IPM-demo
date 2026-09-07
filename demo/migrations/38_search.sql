-- =====================================================================
-- GLOBAL SEARCH — the box in the header on every screen.
--
-- SECURITY INVOKER on purpose. The Python handler carefully re-applies
-- each role's scoping by hand, with the comment "search must not be the
-- back door around a role's scoping: a team leader finds their patch here
-- and nothing else, exactly as their lists show". Running as the caller
-- makes that true by construction — every SELECT below goes through the
-- same §6 policies the lists do, so search cannot widen what a role sees
-- even if someone forgets a clause.
--
-- The four permission checks are still explicit, because a role that may
-- not see invoices at all should get an absent section rather than an
-- empty one.
-- =====================================================================
CREATE OR REPLACE FUNCTION search(p_q text) RETURNS jsonb
  LANGUAGE plpgsql STABLE AS
$fn$
DECLARE like_q text;
BEGIN
  IF btrim(COALESCE(p_q, '')) = '' THEN
    RETURN jsonb_build_object('clients', '[]'::jsonb, 'visits', '[]'::jsonb,
                              'chemicals', '[]'::jsonb, 'invoices', '[]'::jsonb);
  END IF;
  like_q := '%' || btrim(p_q) || '%';

  RETURN jsonb_build_object(
    'clients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name_en', c.name_en,
                                          'name_ar', c.name_ar, 'city', c.city))
        FROM (SELECT id, name_en, name_ar, city FROM clients
               WHERE name_en ILIKE like_q OR name_ar ILIKE like_q
                  OR city ILIKE like_q OR contact_person ILIKE like_q
               LIMIT 20) c), '[]'::jsonb),

    'visits', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', v.id, 'scheduled_start', v.scheduled_start,
                                          'status', v.status, 'client_en', v.client_en))
        FROM (SELECT vv.id, vv.scheduled_start, vv.status, vv.client_en
                FROM v_visits vv
               WHERE vv.location ILIKE like_q OR vv.notes ILIKE like_q
                  OR vv.client_en ILIKE like_q OR vv.site_name ILIKE like_q
               ORDER BY vv.scheduled_start DESC
               LIMIT 20) v), '[]'::jsonb),

    'chemicals', CASE WHEN app_has_perm('chemicals.view') THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', ch.id, 'name_en', ch.name_en,
               'name_ar', ch.name_ar, 'quantity_in_stock', ch.quantity_in_stock,
               'unit', ch.unit))
        FROM (SELECT id, name_en, name_ar, quantity_in_stock, unit FROM chemicals
               WHERE name_en ILIKE like_q OR name_ar ILIKE like_q
                  OR active_ingredient ILIKE like_q
               LIMIT 20) ch), '[]'::jsonb) ELSE '[]'::jsonb END,

    'invoices', CASE WHEN app_has_perm('invoices.view') THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number,
               'total', i.total, 'status', i.status, 'client_en', i.client_en))
        FROM (SELECT iv.id, iv.number, iv.total, iv.status, c.name_en AS client_en
                FROM invoices iv JOIN clients c ON c.id = iv.client_id
               WHERE iv.number ILIKE like_q OR c.name_en ILIKE like_q
               ORDER BY iv.id DESC
               LIMIT 20) i), '[]'::jsonb) ELSE '[]'::jsonb END);
END
$fn$;
