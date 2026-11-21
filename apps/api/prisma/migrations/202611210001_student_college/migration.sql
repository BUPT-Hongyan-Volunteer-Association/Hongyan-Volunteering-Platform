BEGIN;

ALTER TABLE student ADD COLUMN college TEXT;
ALTER TABLE student_import_row ADD COLUMN college TEXT;

COMMIT;
