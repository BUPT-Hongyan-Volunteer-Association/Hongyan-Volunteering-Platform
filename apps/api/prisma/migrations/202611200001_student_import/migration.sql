BEGIN;

ALTER TABLE student
    ADD COLUMN cohort TEXT,
    ADD COLUMN grade TEXT,
    ADD COLUMN class_name TEXT,
    ADD COLUMN created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE student_import_batch (
    id UUID PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'validating',
    source_hash TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_data BYTEA NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    created_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX student_import_batch_creator_time_idx
    ON student_import_batch (created_by, created_at);

CREATE TABLE student_import_row (
    batch_id UUID NOT NULL REFERENCES student_import_batch(id) ON DELETE CASCADE ON UPDATE CASCADE,
    row_number INTEGER NOT NULL,
    action TEXT NOT NULL,
    student_no TEXT,
    name TEXT,
    cohort TEXT,
    grade TEXT,
    class_name TEXT,
    raw_values JSONB NOT NULL,
    errors JSONB NOT NULL,
    resulting_account_status TEXT,
    PRIMARY KEY (batch_id, row_number)
);

COMMIT;
