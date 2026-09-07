INSERT INTO storage.buckets (id, name, public) VALUES
  ('photos',    'photos',    false),   -- visit photos, report images
  ('maps',      'maps',      false),   -- site map images and PDFs
  ('documents', 'documents', false),   -- the IPM file library
  ('branding',  'branding',  true);    -- company logo only; public is fine
CREATE POLICY photos_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'photos' AND app_has_perm('visits.view'));
CREATE POLICY photos_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'photos' AND app_has_perm('visits.edit'));

CREATE POLICY maps_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'maps' AND app_has_perm('maps.view'));
CREATE POLICY maps_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'maps' AND app_has_perm('maps.create'));

CREATE POLICY docs_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'documents' AND app_has_perm('ipm.view'));
CREATE POLICY docs_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents' AND app_has_perm('ipm.create'));
