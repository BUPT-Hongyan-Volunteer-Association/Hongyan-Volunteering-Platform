BEGIN;

CREATE TABLE questionnaire_response (
    id uuid PRIMARY KEY, activity_id uuid NOT NULL REFERENCES activity(id),
    student_id uuid NOT NULL REFERENCES student(id), questionnaire_version text NOT NULL,
    questions jsonb NOT NULL,
    UNIQUE (activity_id, student_id, questionnaire_version)
);
CREATE TABLE questionnaire_answer (
    response_id uuid NOT NULL REFERENCES questionnaire_response(id) ON DELETE CASCADE,
    question_id uuid NOT NULL, position integer NOT NULL, title text NOT NULL, type text NOT NULL,
    text text, option_ids uuid[] NOT NULL, labels text[] NOT NULL,
    PRIMARY KEY (response_id, question_id)
);
ALTER TABLE registration
    ADD COLUMN item_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    ADD COLUMN item_label text, ADD COLUMN response_id uuid REFERENCES questionnaire_response(id);
DROP INDEX registration_activity_id_student_id_key;
CREATE UNIQUE INDEX registration_activity_id_student_id_item_id_key ON registration(activity_id,student_id,item_id);
CREATE INDEX registration_activity_id_item_id_status_idx ON registration(activity_id,item_id,status);
CREATE INDEX registration_response_id_idx ON registration(response_id);

WITH counts AS (
    SELECT activity_id, count(*) FILTER (WHERE status IN ('accepted','submitted','waitlisted')) AS active,
           count(*) FILTER (WHERE status = 'waitlisted') AS waiting
    FROM registration GROUP BY activity_id
)
UPDATE activity_revision r SET content =
    (content - ARRAY['eligibility_text','selection_text','expected_hours','expected_hours_basis'])
    || jsonb_build_object('registration_mode','whole','waitlist_capacity',coalesce((
        SELECT greatest(waiting,active - coalesce((r.content->>'capacity')::integer,0),0)
        FROM counts WHERE activity_id=r.activity_id
    ),0));

-- Preserve the original success and key when an old whole-activity application is replayed.
UPDATE command_receipt SET response=jsonb_set(response,'{data}',
    jsonb_build_object('items',jsonb_build_array((response->'data') - 'statement')))
WHERE method='POST' AND path ~ '/activities/[0-9a-fA-F-]+/registrations$' AND response->'data' ? 'student_id';

COMMIT;
