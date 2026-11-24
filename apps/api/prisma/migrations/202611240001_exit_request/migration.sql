CREATE TABLE exit_request (
    id UUID PRIMARY KEY,
    registration_id UUID NOT NULL REFERENCES registration(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'cancelled')),
    decision_reason TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX exit_request_registration_id_idx ON exit_request(registration_id);
CREATE UNIQUE INDEX exit_request_one_pending ON exit_request(registration_id) WHERE status = 'pending';
