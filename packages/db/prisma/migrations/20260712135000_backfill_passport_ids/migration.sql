-- Backfill `User.passportId` for every existing row that still has NULL.
--
-- Format: `TP-<year>-<6-digit>`, where `<year>` is the user's registration
-- year and the suffix is a random zero-padded 6-digit number. On the (very
-- rare) unique conflict we retry up to 8 times per user before giving up.
--
-- Idempotent — rows that already have a passportId are skipped, so this
-- migration is safe to leave in place even after all users have one.

DO $$
DECLARE
  u          RECORD;
  candidate  TEXT;
  attempts   INT;
BEGIN
  FOR u IN
    SELECT id, EXTRACT(YEAR FROM "createdAt")::int AS year
    FROM "User"
    WHERE "passportId" IS NULL
    ORDER BY "createdAt" ASC
  LOOP
    attempts := 0;
    LOOP
      candidate := 'TP-' || u.year || '-' || LPAD(floor(random() * 1000000)::int::text, 6, '0');
      BEGIN
        UPDATE "User" SET "passportId" = candidate WHERE id = u.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        attempts := attempts + 1;
        IF attempts > 8 THEN
          RAISE EXCEPTION 'passport-backfill: could not assign passportId for user % after 8 attempts', u.id;
        END IF;
      END;
    END LOOP;
  END LOOP;
END $$;
