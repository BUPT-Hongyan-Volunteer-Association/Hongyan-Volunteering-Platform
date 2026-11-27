ALTER TABLE registration_history ADD response_id uuid REFERENCES questionnaire_response(id);

UPDATE registration_history h SET response_id=r.response_id
FROM registration r WHERE h.registration_id=r.id AND h.status='submitted'
  AND r.response_id IS NOT NULL AND h.submitted_at=r.submitted_at;
