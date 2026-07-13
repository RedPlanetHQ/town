-- Re-assign passport IDs to base36 for any row still on the earlier
-- numeric `TP-YYYY-NNNNNN` format. New format is `TP-YYYY-XXXXXX` where
-- each X is from `[0-9A-Z]`, giving 36^6 ≈ 2.2B addresses per year —
-- effectively infinite headroom vs. the 1M cap of pure digits.
--
-- Same retry-on-collision pattern as the initial backfill. Idempotent:
-- rows already on the new format are skipped, so re-running is safe.

DO $$
DECLARE
  u          RECORD;
  candidate  TEXT;
  chars      TEXT := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  attempts   INT;
BEGIN
  FOR u IN
    SELECT id, EXTRACT(YEAR FROM "createdAt")::int AS year
    FROM "User"
    WHERE "passportId" ~ '^TP-[0-9]{4}-[0-9]{6}$'
    ORDER BY "createdAt" ASC
  LOOP
    attempts := 0;
    LOOP
      candidate := 'TP-' || u.year || '-' ||
        substr(chars, 1 + floor(random() * 36)::int, 1) ||
        substr(chars, 1 + floor(random() * 36)::int, 1) ||
        substr(chars, 1 + floor(random() * 36)::int, 1) ||
        substr(chars, 1 + floor(random() * 36)::int, 1) ||
        substr(chars, 1 + floor(random() * 36)::int, 1) ||
        substr(chars, 1 + floor(random() * 36)::int, 1);
      BEGIN
        UPDATE "User" SET "passportId" = candidate WHERE id = u.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        attempts := attempts + 1;
        IF attempts > 8 THEN
          RAISE EXCEPTION 'passport-base36: could not re-assign for user % after 8 attempts', u.id;
        END IF;
      END;
    END LOOP;
  END LOOP;
END $$;
