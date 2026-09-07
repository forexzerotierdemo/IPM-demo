-- Cairo wall-clock, in the exact text format the app reads and writes.
CREATE OR REPLACE FUNCTION now_cairo() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT to_char(now() AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI:SS') $$;

CREATE OR REPLACE FUNCTION today_cairo() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT to_char(now() AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') $$;
ALTER DATABASE postgres SET timezone TO 'Africa/Cairo';
