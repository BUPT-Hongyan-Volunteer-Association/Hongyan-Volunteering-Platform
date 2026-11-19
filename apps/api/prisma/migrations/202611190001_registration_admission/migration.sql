BEGIN;

ALTER TABLE registration ADD COLUMN statement TEXT, ADD COLUMN decision_reason TEXT;

CREATE TABLE registration_history (
    registration_id UUID NOT NULL REFERENCES registration(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    submitted_at TIMESTAMPTZ(3) NOT NULL,
    statement TEXT,
    decision_reason TEXT,
    changed_at TIMESTAMPTZ(3),
    actor_id UUID,
    PRIMARY KEY (registration_id, version)
);

-- Legacy rows carry a submission time, but no timestamp or actor for later decisions.
INSERT INTO registration_history (registration_id, version, status, submitted_at, changed_at)
SELECT id, version, status, submitted_at, CASE WHEN status = 'submitted' THEN submitted_at END
FROM registration;

CREATE TABLE registration_decision_event (
    event_id UUID PRIMARY KEY,
    event_type TEXT NOT NULL DEFAULT 'registration_decided',
    activity_id UUID NOT NULL,
    registration_id UUID NOT NULL,
    student_id UUID NOT NULL,
    registration_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX registration_decision_version_key
    ON registration_decision_event (registration_id, registration_version);

COMMIT;
