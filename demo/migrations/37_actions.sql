-- =====================================================================
-- THE ACTION BUTTONS.
--
-- The screens listed and read fine; the buttons on them did nothing.
-- Appendix C marked these "PostgREST", which was optimistic — a status
-- toggle that also cancels the diary, or an approval that moves stock, is
-- not a table write. They fell through to the Edge Function and 501'd, and
-- coverage.js could not see them because it only walked the 83 routes the
-- appendix called computed. That blind spot is closed; this closes the
-- routes it exposed.
--
-- Every one of these writes an audit row and, where the original notified
-- somebody, a notification — because a workflow whose other half never
-- hears about it is not a workflow.
-- =====================================================================

-- ---- the two things every action does --------------------------------
CREATE OR REPLACE FUNCTION app_audit(p_action text, p_entity text,
                                     p_entity_id bigint, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
BEGIN
  INSERT INTO audit_log(user_id, user_name, action, entity, entity_id, detail, created_at)
  SELECT app_uid(), u.full_name, p_action, p_entity, p_entity_id::text, p_detail, now_cairo()
    FROM users u WHERE u.id = app_uid();
END
$fn$;

-- dedup_key stops the same event landing twice when a screen retries.
CREATE OR REPLACE FUNCTION app_notify(p_user_id bigint, p_type text, p_title text,
                                      p_body text, p_view text DEFAULT NULL,
                                      p_link_id bigint DEFAULT NULL,
                                      p_dedup text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
BEGIN
  IF p_user_id IS NULL OR p_user_id = app_uid() THEN RETURN; END IF;
  IF p_dedup IS NOT NULL AND EXISTS (
       SELECT 1 FROM notifications n
        WHERE n.user_id = p_user_id AND n.dedup_key = p_dedup) THEN RETURN; END IF;
  INSERT INTO notifications(user_id, type, title, body, link_view, link_id,
                            is_read, dedup_key, created_at)
  VALUES (p_user_id, p_type, p_title, p_body, p_view, p_link_id, 0, p_dedup, now_cairo());
END
$fn$;

-- Everyone holding one of these roles, for the "tell the office" cases.
CREATE OR REPLACE FUNCTION app_notify_roles(p_roles text[], p_type text, p_title text,
                                            p_body text, p_view text DEFAULT NULL,
                                            p_link_id bigint DEFAULT NULL,
                                            p_dedup text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE r record;
BEGIN
  FOR r IN SELECT u.id FROM users u
            WHERE u.role = ANY(p_roles) AND u.active = 1 AND u.id <> app_uid()
  LOOP
    PERFORM app_notify(r.id, p_type, p_title, p_body, p_view, p_link_id,
                       p_dedup || ':' || r.id);
  END LOOP;
END
$fn$;


-- =====================================================================
-- SWITCHING A CUSTOMER OR A BRANCH OFF
-- `cancel_visits` also clears what is still booked — the office's choice,
-- because a place that shuts for a month wants its diary kept and a
-- customer who leaves does not. Cancelled, never deleted: the office can
-- see what was called off.
-- =====================================================================
CREATE OR REPLACE FUNCTION set_client_status(p_client_id bigint, p_status text,
                                             p_cancel_visits boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE n int := 0; upcoming int;
BEGIN
  IF NOT app_has_perm('clients.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF p_status NOT IN ('active','inactive') THEN
    RAISE EXCEPTION 'Status must be active or inactive';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = p_client_id) THEN
    RAISE EXCEPTION 'Client not found';
  END IF;

  IF p_status = 'inactive' AND p_cancel_visits THEN
    UPDATE visits SET status = 'cancelled',
                      notes = COALESCE(notes || ' | ', '') || 'Customer switched off'
     WHERE client_id = p_client_id AND status = 'scheduled'
       AND left(scheduled_start, 10) >= today_cairo();
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;

  UPDATE clients SET status = p_status WHERE id = p_client_id;
  PERFORM app_audit('client.status', 'client', p_client_id,
                    p_status || CASE WHEN n > 0 THEN ', ' || n || ' upcoming visit(s) cancelled'
                                     ELSE '' END);

  SELECT count(*) INTO upcoming FROM visits
   WHERE client_id = p_client_id AND status = 'scheduled'
     AND left(scheduled_start, 10) >= today_cairo();
  RETURN jsonb_build_object('ok', true, 'status', p_status,
                            'cancelled_visits', n, 'upcoming_visits', upcoming);
END
$fn$;

CREATE OR REPLACE FUNCTION set_site_status(p_site_id bigint, p_status text,
                                           p_cancel_visits boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE n int := 0; upcoming int;
BEGIN
  IF NOT app_has_perm('clients.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF p_status NOT IN ('active','inactive') THEN
    RAISE EXCEPTION 'Status must be active or inactive';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id) THEN
    RAISE EXCEPTION 'Site not found';
  END IF;

  IF p_status = 'inactive' AND p_cancel_visits THEN
    UPDATE visits SET status = 'cancelled',
                      notes = COALESCE(notes || ' | ', '') || 'Branch switched off'
     WHERE site_id = p_site_id AND status = 'scheduled'
       AND left(scheduled_start, 10) >= today_cairo();
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;

  UPDATE sites SET status = p_status WHERE id = p_site_id;
  PERFORM app_audit('site.status', 'site', p_site_id, p_status);

  SELECT count(*) INTO upcoming FROM visits
   WHERE site_id = p_site_id AND status = 'scheduled'
     AND left(scheduled_start, 10) >= today_cairo();
  RETURN jsonb_build_object('ok', true, 'status', p_status,
                            'cancelled_visits', n, 'upcoming_visits', upcoming);
END
$fn$;


-- =====================================================================
-- CHECK IN / CHECK OUT — the engineer's core action.
-- Checking in is now the only way a visit starts, so the "visit started"
-- alert hangs here rather than on a manual status change.
-- =====================================================================
CREATE OR REPLACE FUNCTION visit_checkin(p_visit_id bigint,
                                         p_lat double precision DEFAULT NULL,
                                         p_lng double precision DEFAULT NULL,
                                         p_acc double precision DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE v record; info record;
BEGIN
  IF NOT app_has_perm('visits.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF app_role() = 'client' THEN
    RAISE EXCEPTION 'Not available to client accounts';
  END IF;
  SELECT * INTO v FROM visits WHERE id = p_visit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF app_role() = 'agent' AND v.agent_id IS DISTINCT FROM app_uid() THEN
    RAISE EXCEPTION 'Not your visit';
  END IF;
  IF NOT app_can_see_visit(p_visit_id) THEN RAISE EXCEPTION 'No permission'; END IF;
  IF v.checkin_at IS NOT NULL THEN RAISE EXCEPTION 'Already checked in'; END IF;
  IF v.status IN ('completed','cancelled') THEN RAISE EXCEPTION 'Visit is closed'; END IF;

  UPDATE visits
     SET checkin_at = now_cairo(), checkin_lat = p_lat, checkin_lng = p_lng,
         checkin_acc = p_acc,
         status = CASE WHEN status = 'scheduled' THEN 'in_progress' ELSE status END
   WHERE id = p_visit_id;

  PERFORM app_audit('visit.checkin', 'visit', p_visit_id,
                    CASE WHEN p_lat IS NULL THEN 'no GPS'
                         ELSE round(p_lat::numeric,5) || ',' || round(p_lng::numeric,5) END);

  IF v.status = 'scheduled' THEN
    SELECT c.name_en AS client, u.full_name AS agent INTO info
      FROM visits vv JOIN clients c ON c.id = vv.client_id
      LEFT JOIN users u ON u.id = vv.agent_id WHERE vv.id = p_visit_id;
    PERFORM app_notify_roles(ARRAY['admin','manager'], 'visit_started', 'Visit started',
      COALESCE(info.agent, 'Engineer') || ' started the visit at ' || info.client,
      'visit', p_visit_id, 'vstart:' || p_visit_id);
  END IF;

  RETURN (SELECT to_jsonb(x) FROM (SELECT * FROM visits WHERE id = p_visit_id) x);
END
$fn$;

CREATE OR REPLACE FUNCTION visit_checkout(p_visit_id bigint,
                                          p_lat double precision DEFAULT NULL,
                                          p_lng double precision DEFAULT NULL,
                                          p_acc double precision DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE v record;
BEGIN
  IF NOT app_has_perm('visits.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF app_role() = 'client' THEN
    RAISE EXCEPTION 'Not available to client accounts';
  END IF;
  SELECT * INTO v FROM visits WHERE id = p_visit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF app_role() = 'agent' AND v.agent_id IS DISTINCT FROM app_uid() THEN
    RAISE EXCEPTION 'Not your visit';
  END IF;
  IF NOT app_can_see_visit(p_visit_id) THEN RAISE EXCEPTION 'No permission'; END IF;
  IF v.checkin_at IS NULL THEN RAISE EXCEPTION 'Check in first'; END IF;
  IF v.checkout_at IS NOT NULL THEN RAISE EXCEPTION 'Already checked out'; END IF;

  UPDATE visits SET checkout_at = now_cairo(), checkout_lat = p_lat,
                    checkout_lng = p_lng, checkout_acc = p_acc
   WHERE id = p_visit_id;
  PERFORM app_audit('visit.checkout', 'visit', p_visit_id,
                    CASE WHEN p_lat IS NULL THEN 'no GPS'
                         ELSE round(p_lat::numeric,5) || ',' || round(p_lng::numeric,5) END);
  RETURN (SELECT to_jsonb(x) FROM (SELECT * FROM visits WHERE id = p_visit_id) x);
END
$fn$;


-- =====================================================================
-- MATERIALS: the office answers a request, the engineer confirms receipt.
-- Stock moves at APPROVAL, not when it was asked for, and not again on
-- receipt — receipt records the handover rather than changing a number.
-- =====================================================================
CREATE OR REPLACE FUNCTION approve_issue(p_id bigint) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE r record; moved int := 0;
BEGIN
  IF NOT app_has_perm('issues.approve') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT * INTO r FROM engineer_issues WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'requested' THEN
    RAISE EXCEPTION 'This request has already been handled';
  END IF;

  -- Approving IS the issuing: what was approved leaves stock now.
  -- the column is line_status, not status: the row's own state, kept
  -- apart from the request's, because the office answers line by line
  UPDATE engineer_issue_items SET line_status = 'approved',
         approved_quantity = COALESCE(approved_quantity, quantity)
   WHERE issue_id = p_id AND COALESCE(line_status, 'requested') = 'requested';
  GET DIAGNOSTICS moved = ROW_COUNT;

  UPDATE chemicals ch SET quantity_in_stock = GREATEST(0, ch.quantity_in_stock - u.q)
    FROM (SELECT chemical_id, sum(COALESCE(approved_quantity, quantity)) q
            FROM engineer_issue_items WHERE issue_id = p_id AND chemical_id IS NOT NULL
           GROUP BY chemical_id) u
   WHERE ch.id = u.chemical_id;

  INSERT INTO inventory_transactions(chemical_id, change, reason, reference, created_at)
  SELECT chemical_id, -sum(COALESCE(approved_quantity, quantity)), 'issue',
         'issue:' || p_id, now_cairo()
    FROM engineer_issue_items WHERE issue_id = p_id AND chemical_id IS NOT NULL
   GROUP BY chemical_id;

  UPDATE engineer_issues SET status = 'approved', handled_by = app_uid(),
                             handled_at = now_cairo()
   WHERE id = p_id;
  PERFORM app_audit('issue.approve', 'engineer_issue', p_id, moved || ' line(s)');
  PERFORM app_notify(r.agent_id, 'issue_approved', 'Materials approved',
                     'Your materials request was approved.', 'issues', p_id,
                     'issueok:' || p_id);
  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'lines', moved);
END
$fn$;

CREATE OR REPLACE FUNCTION decline_issue(p_id bigint, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE r record;
BEGIN
  IF NOT app_has_perm('issues.approve') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT * INTO r FROM engineer_issues WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'requested' THEN
    RAISE EXCEPTION 'This request has already been handled';
  END IF;
  UPDATE engineer_issues SET status = 'declined', handled_by = app_uid(),
         handled_at = now_cairo(), decline_reason = NULLIF(btrim(COALESCE(p_reason,'')), '')
   WHERE id = p_id;
  PERFORM app_audit('issue.decline', 'engineer_issue', p_id, p_reason);
  PERFORM app_notify(r.agent_id, 'issue_declined', 'Materials request declined',
                     COALESCE(NULLIF(btrim(COALESCE(p_reason,'')), ''),
                              'Your materials request was declined.'),
                     'issues', p_id, 'issueno:' || p_id);
  RETURN jsonb_build_object('ok', true, 'status', 'declined');
END
$fn$;

-- The engineer's half. Nothing is moved back automatically on a dispute —
-- an engineer must not be able to unwind a warehouse movement on their own —
-- so it is flagged for the office to settle.
CREATE OR REPLACE FUNCTION receipt_issue(p_id bigint, p_state text,
                                         p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE r record;
BEGIN
  IF NOT app_has_perm('issues.view') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF p_state NOT IN ('received','disputed') THEN RAISE EXCEPTION 'Invalid state'; END IF;
  SELECT * INTO r FROM engineer_issues WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF app_role() = 'agent' AND r.agent_id IS DISTINCT FROM app_uid() THEN
    RAISE EXCEPTION 'Not your request';
  END IF;
  IF r.receipt_status = 'received' THEN
    RAISE EXCEPTION 'You have already confirmed these materials';
  END IF;

  UPDATE engineer_issues SET receipt_status = p_state, receipt_at = now_cairo(),
         receipt_note = NULLIF(btrim(COALESCE(p_note,'')), '')
   WHERE id = p_id;
  PERFORM app_audit('issue.' || p_state, 'engineer_issue', p_id, p_note);
  PERFORM app_notify_roles(ARRAY['admin','manager'],
    'issue_' || p_state,
    CASE p_state WHEN 'received' THEN 'Materials confirmed'
                 ELSE 'Materials not received' END,
    (SELECT u.full_name FROM users u WHERE u.id = app_uid())
      || CASE p_state WHEN 'received' THEN ' confirmed receiving the materials.'
                      ELSE ' reports not receiving the materials.' END,
    'issues', p_id, 'issue' || p_state || ':' || p_id);
  RETURN jsonb_build_object('ok', true, 'receipt_status', p_state);
END
$fn$;

-- Returns are the same shape in the other direction.
CREATE OR REPLACE FUNCTION handle_return(p_id bigint, p_action text,
                                         p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM material_returns WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;

  IF p_action IN ('approve','decline') THEN
    IF NOT app_has_perm('issues.approve') THEN RAISE EXCEPTION 'Not permitted'; END IF;
    IF r.status <> 'requested' THEN RAISE EXCEPTION 'Already handled'; END IF;

    IF p_action = 'approve' THEN
      -- What comes back goes on the shelf.
      UPDATE material_return_items SET line_status = 'approved',
             approved_quantity = COALESCE(approved_quantity, quantity)
       WHERE return_id = p_id;
      UPDATE chemicals ch SET quantity_in_stock = ch.quantity_in_stock + u.q
        FROM (SELECT chemical_id, sum(COALESCE(approved_quantity, quantity)) q
                FROM material_return_items WHERE return_id = p_id AND chemical_id IS NOT NULL
               GROUP BY chemical_id) u
       WHERE ch.id = u.chemical_id;
      -- reason is a closed vocabulary (purchase|usage|adjustment|issue);
      -- a return is an adjustment, and the reference says which one.
      INSERT INTO inventory_transactions(chemical_id, change, reason, reference, created_at)
      SELECT chemical_id, sum(COALESCE(approved_quantity, quantity)), 'adjustment',
             'return:' || p_id, now_cairo()
        FROM material_return_items WHERE return_id = p_id AND chemical_id IS NOT NULL
       GROUP BY chemical_id;
    END IF;

    UPDATE material_returns
       SET status = CASE p_action WHEN 'approve' THEN 'approved' ELSE 'declined' END,
           handled_by = app_uid(), handled_at = now_cairo(),
           decline_reason = CASE WHEN p_action = 'decline'
                                 THEN NULLIF(btrim(COALESCE(p_note,'')), '') END
     WHERE id = p_id;
    PERFORM app_audit('return.' || p_action, 'material_return', p_id, p_note);
    PERFORM app_notify(r.agent_id, 'return_' || p_action,
      CASE p_action WHEN 'approve' THEN 'Return approved' ELSE 'Return declined' END,
      COALESCE(NULLIF(btrim(COALESCE(p_note,'')), ''), 'Your material return was handled.'),
      'returns', p_id, 'ret' || p_action || ':' || p_id);
    RETURN jsonb_build_object('ok', true, 'status',
      CASE p_action WHEN 'approve' THEN 'approved' ELSE 'declined' END);
  END IF;

  IF p_action IN ('receive','dispute') THEN
    IF NOT app_has_perm('issues.view') THEN RAISE EXCEPTION 'Not permitted'; END IF;
    UPDATE material_returns
       SET receipt_status = CASE p_action WHEN 'receive' THEN 'received' ELSE 'disputed' END,
           receipt_at = now_cairo(), receipt_by = app_uid(),
           receipt_note = NULLIF(btrim(COALESCE(p_note,'')), '')
     WHERE id = p_id;
    PERFORM app_audit('return.' || p_action, 'material_return', p_id, p_note);
    RETURN jsonb_build_object('ok', true, 'receipt_status',
      CASE p_action WHEN 'receive' THEN 'received' ELSE 'disputed' END);
  END IF;

  RAISE EXCEPTION 'Invalid action';
END
$fn$;


-- =====================================================================
-- POCKET MONEY. The office may settle a claim for LESS than was asked —
-- a receipt that does not add up is trimmed here rather than declined.
-- =====================================================================
CREATE OR REPLACE FUNCTION handle_cash(p_id bigint, p_action text,
                                       p_amount double precision DEFAULT NULL,
                                       p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE r record; amt double precision;
BEGIN
  IF NOT app_has_perm('cash.approve') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT * INTO r FROM petty_cash WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This has already been handled'; END IF;

  IF p_action = 'approve' THEN
    amt := CASE WHEN p_amount IS NOT NULL AND p_amount > 0
                THEN round(p_amount::numeric, 2)::double precision ELSE r.amount END;
    UPDATE petty_cash SET status = 'approved', amount = amt,
           handled_by = app_uid(), handled_at = now_cairo()
     WHERE id = p_id;
    PERFORM app_audit('cash.approve', 'petty_cash', p_id, r.kind || ' ' || amt);
    PERFORM app_notify(r.agent_id, 'cash_approved', 'Pocket money approved',
                       amt || ' was approved.', 'cash', p_id, 'cashok:' || p_id);
    RETURN jsonb_build_object('ok', true, 'status', 'approved', 'amount', amt);
  ELSIF p_action = 'decline' THEN
    UPDATE petty_cash SET status = 'declined', handled_by = app_uid(),
           handled_at = now_cairo(),
           decline_reason = NULLIF(btrim(COALESCE(p_reason,'')), '')
     WHERE id = p_id;
    PERFORM app_audit('cash.decline', 'petty_cash', p_id, p_reason);
    PERFORM app_notify(r.agent_id, 'cash_declined', 'Pocket money declined',
                       COALESCE(NULLIF(btrim(COALESCE(p_reason,'')), ''),
                                'Your pocket money claim was declined.'),
                       'cash', p_id, 'cashno:' || p_id);
    RETURN jsonb_build_object('ok', true, 'status', 'declined');
  END IF;
  RAISE EXCEPTION 'Invalid action';
END
$fn$;


-- =====================================================================
-- A CUSTOMER'S REQUEST BECOMES A REAL VISIT.
-- Approving books the job, so it needs both the inbox and the diary.
-- =====================================================================
CREATE OR REPLACE FUNCTION handle_visit_request(
  p_id bigint, p_action text,
  p_scheduled_start text DEFAULT NULL, p_agent_id bigint DEFAULT NULL,
  p_service_type_id bigint DEFAULT NULL, p_site_id bigint DEFAULT NULL,
  p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE r record; vid bigint; start_at text;
BEGIN
  IF NOT app_has_perm('requests.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT * INTO r FROM visit_requests WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already handled'; END IF;

  IF p_action = 'approve' THEN
    IF NOT app_has_perm('visits.create') THEN RAISE EXCEPTION 'Not permitted'; END IF;
    start_at := COALESCE(NULLIF(p_scheduled_start, ''),
                         COALESCE(r.preferred_date, today_cairo()) || ' 09:00:00');
    INSERT INTO visits(client_id, site_id, agent_id, service_type_id,
                       scheduled_start, status, notes)
    VALUES (r.client_id, COALESCE(p_site_id, r.site_id), p_agent_id,
            p_service_type_id, start_at, 'scheduled', r.note)
    RETURNING id INTO vid;

    UPDATE visit_requests SET status = 'approved', visit_id = vid,
           handled_by = app_uid(), handled_at = now_cairo()
     WHERE id = p_id;
    PERFORM app_audit('visit_request.approve', 'visit', vid, 'from request #' || p_id);
    PERFORM app_notify(r.created_by, 'request_approved', 'Visit scheduled',
                       'Your visit request was scheduled.', 'visits', vid,
                       'vreqok:' || p_id);
    RETURN jsonb_build_object('ok', true, 'status', 'approved', 'visit_id', vid);
  ELSIF p_action = 'decline' THEN
    UPDATE visit_requests SET status = 'declined', handled_by = app_uid(),
           handled_at = now_cairo() WHERE id = p_id;
    PERFORM app_audit('visit_request.decline', 'visit_request', p_id, p_reason);
    PERFORM app_notify(r.created_by, 'request_declined', 'Visit request declined',
                       COALESCE(NULLIF(btrim(COALESCE(p_reason,'')), ''),
                                'Your visit request was declined.'),
                       'requests', p_id, 'vreqno:' || p_id);
    RETURN jsonb_build_object('ok', true, 'status', 'declined');
  END IF;
  RAISE EXCEPTION 'Invalid action';
END
$fn$;


-- =====================================================================
-- STOCK, USAGE, THE SIGNATURE AND THE RATING
-- =====================================================================
CREATE OR REPLACE FUNCTION adjust_stock(p_chemical_id bigint, p_change double precision,
                                        p_reason text DEFAULT 'adjustment',
                                        p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
BEGIN
  IF NOT app_has_perm('chemicals.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF p_reason NOT IN ('purchase','adjustment') THEN RAISE EXCEPTION 'Invalid reason'; END IF;
  UPDATE chemicals SET quantity_in_stock = GREATEST(0, quantity_in_stock + p_change)
   WHERE id = p_chemical_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Chemical not found'; END IF;
  INSERT INTO inventory_transactions(chemical_id, change, reason, note, created_at)
  VALUES (p_chemical_id, p_change, p_reason, p_note, now_cairo());
  PERFORM app_audit('stock.adjust', 'chemical', p_chemical_id,
                    p_reason || ' ' || p_change);
  RETURN (SELECT to_jsonb(c) FROM chemicals c WHERE c.id = p_chemical_id);
END
$fn$;

CREATE OR REPLACE FUNCTION chemical_transactions(p_chemical_id bigint) RETURNS jsonb
  LANGUAGE sql STABLE AS
$fn$
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id DESC), '[]'::jsonb)
    FROM (SELECT id, chemical_id, change, reason, reference, note, created_at
            FROM inventory_transactions WHERE chemical_id = p_chemical_id
           ORDER BY id DESC LIMIT 200) t
$fn$;

CREATE OR REPLACE FUNCTION record_usage(p_visit_id bigint, p_chemical_id bigint,
                                        p_quantity double precision,
                                        p_area_treated text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE uid bigint;
BEGIN
  IF NOT app_has_perm('visits.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF NOT app_can_see_visit(p_visit_id) THEN RAISE EXCEPTION 'No permission'; END IF;
  INSERT INTO chemical_usage(visit_id, chemical_id, quantity, area_treated)
  VALUES (p_visit_id, p_chemical_id, p_quantity, p_area_treated)
  RETURNING id INTO uid;

  -- What is applied on a job comes off the shelf, with a ledger line so the
  -- level can always be accounted for.
  UPDATE chemicals SET quantity_in_stock = GREATEST(0, quantity_in_stock - p_quantity)
   WHERE id = p_chemical_id;
  INSERT INTO inventory_transactions(chemical_id, change, reason, reference, created_at)
  VALUES (p_chemical_id, -p_quantity, 'usage', 'visit:' || p_visit_id, now_cairo());

  PERFORM app_audit('usage.add', 'visit', p_visit_id, p_quantity::text);
  RETURN jsonb_build_object('ok', true, 'id', uid);
END
$fn$;

CREATE OR REPLACE FUNCTION delete_usage(p_id bigint) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE u record;
BEGIN
  IF NOT app_has_perm('visits.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  SELECT * INTO u FROM chemical_usage WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found'; END IF;
  -- Putting the record back also puts the product back.
  UPDATE chemicals SET quantity_in_stock = quantity_in_stock + u.quantity
   WHERE id = u.chemical_id;
  INSERT INTO inventory_transactions(chemical_id, change, reason, reference, created_at)
  VALUES (u.chemical_id, u.quantity, 'adjustment', 'usage-undo:' || p_id, now_cairo());
  DELETE FROM chemical_usage WHERE id = p_id;
  PERFORM app_audit('usage.delete', 'visit', u.visit_id, NULL);
  RETURN jsonb_build_object('ok', true);
END
$fn$;

CREATE OR REPLACE FUNCTION save_signature(p_visit_id bigint, p_customer_name text,
                                          p_signature text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
BEGIN
  IF NOT app_has_perm('visits.edit') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF NOT app_can_see_visit(p_visit_id) THEN RAISE EXCEPTION 'No permission'; END IF;
  UPDATE reports SET customer_name = p_customer_name, customer_signature = p_signature
   WHERE visit_id = p_visit_id;
  IF NOT FOUND THEN
    INSERT INTO reports(visit_id, customer_name, customer_signature, status)
    VALUES (p_visit_id, p_customer_name, p_signature, 'draft');
  END IF;
  PERFORM app_audit('visit.signature', 'visit', p_visit_id, p_customer_name);
  RETURN jsonb_build_object('ok', true);
END
$fn$;

CREATE OR REPLACE FUNCTION rate_visit(p_visit_id bigint, p_stars int,
                                      p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
BEGIN
  IF p_stars IS NULL OR p_stars < 1 OR p_stars > 5 THEN
    RAISE EXCEPTION 'Rating must be 1 to 5';
  END IF;
  IF NOT app_can_see_visit(p_visit_id) THEN RAISE EXCEPTION 'No permission'; END IF;
  DELETE FROM visit_ratings WHERE visit_id = p_visit_id;
  INSERT INTO visit_ratings(visit_id, client_id, stars, comment, created_by, created_at)
  SELECT p_visit_id, v.client_id, p_stars,
         NULLIF(btrim(COALESCE(p_comment,'')), ''), app_uid(), now_cairo()
    FROM visits v WHERE v.id = p_visit_id;
  PERFORM app_audit('visit.rating', 'visit', p_visit_id, p_stars::text);
  RETURN jsonb_build_object('ok', true, 'stars', p_stars);
END
$fn$;

-- The bell. Marking read is per-user by construction: notifications carries
-- user_id and §6.5 scopes it to the caller.
CREATE OR REPLACE FUNCTION mark_notifications_read(p_ids bigint[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE n int;
BEGIN
  UPDATE notifications SET is_read = 1
   WHERE user_id = app_uid() AND is_read = 0
     AND (p_ids IS NULL OR id = ANY(p_ids));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'marked', n);
END
$fn$;


-- =====================================================================
-- A BRANCH ADDED UNDER ITS CUSTOMER
-- =====================================================================
CREATE OR REPLACE FUNCTION add_site(p_client_id bigint, p_name text,
                                    p_address text DEFAULT NULL,
                                    p_area text DEFAULT NULL,
                                    p_area_id bigint DEFAULT NULL,
                                    p_visits_per_month bigint DEFAULT 1,
                                    p_visit_minutes bigint DEFAULT 60,
                                    p_service_from text DEFAULT '09:00',
                                    p_service_to text DEFAULT '17:00')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE sid bigint;
BEGIN
  IF NOT app_has_perm('clients.create') AND NOT app_has_perm('clients.edit') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = p_client_id) THEN
    RAISE EXCEPTION 'Client not found';
  END IF;
  INSERT INTO sites(client_id, name, address, area, area_id, visits_per_month,
                    visit_minutes, service_from, service_to, status)
  VALUES (p_client_id, p_name, p_address, p_area, p_area_id,
          COALESCE(p_visits_per_month, 1), COALESCE(p_visit_minutes, 60),
          p_service_from, p_service_to, 'active')
  RETURNING id INTO sid;
  PERFORM app_audit('site.create', 'site', sid, p_name);
  RETURN (SELECT to_jsonb(s) FROM v_sites s WHERE s.id = sid);
END
$fn$;


-- =====================================================================
-- THE AUDIT TRAIL ITSELF
-- =====================================================================
CREATE OR REPLACE FUNCTION list_audit(p_limit int DEFAULT 100) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS
$fn$
BEGIN
  IF NOT app_has_perm('permissions.view') THEN RAISE EXCEPTION 'Not permitted'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id DESC)
      FROM (SELECT * FROM audit_log ORDER BY id DESC
             LIMIT GREATEST(1, LEAST(p_limit, 500))) a), '[]'::jsonb);
END
$fn$;

CREATE OR REPLACE FUNCTION health() RETURNS jsonb LANGUAGE sql STABLE AS
$fn$ SELECT jsonb_build_object('ok', true, 'at', now_cairo()) $fn$;
