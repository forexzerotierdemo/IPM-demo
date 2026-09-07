-- §6.6 / build step 13, as SQL. The five things §12 says are most likely to
-- go wrong, asked of the live database rather than trusted.
SELECT 'rls_disabled' AS check, c.relname AS object,
       'RLS is OFF — every row is readable by any signed-in user' AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity

UNION ALL
SELECT 'no_policies', t.tablename,
       'RLS is on but no policy exists — the table is default-deny to everyone'
  FROM pg_tables t
 WHERE t.schemaname = 'public'
   AND NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = t.tablename)

UNION ALL
-- §12 failure #1: "A view without security_invoker = true. Bypasses every
-- policy silently. Grep for it."
SELECT 'view_not_invoker', c.relname,
       'view runs as its OWNER — bypasses every policy in §6'
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'v'
   AND COALESCE(array_to_string(c.reloptions, ','), '') NOT LIKE '%security_invoker=true%'

UNION ALL
-- A SECURITY DEFINER function with a mutable search_path can be hijacked by
-- a caller who plants a same-named object in a schema it will find first.
SELECT 'definer_mutable_search_path', p.proname,
       'SECURITY DEFINER without SET search_path'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
   AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) cfg
                    WHERE cfg LIKE 'search_path=%')

UNION ALL
-- §12 failure #2: the service-role key must never be reachable from a policy.
SELECT 'policy_grants_anon', p.tablename || '.' || p.policyname,
       'policy is granted to anon/public rather than authenticated'
  FROM pg_policies p
 WHERE p.schemaname = 'public'
   AND ('anon' = ANY(p.roles) OR 'public' = ANY(p.roles))

UNION ALL
SELECT 'storage_bucket_public', b.id,
       'bucket is PUBLIC — every object in it is on the open internet'
  FROM storage.buckets b WHERE b.public AND b.id <> 'branding'

ORDER BY 1, 2;
