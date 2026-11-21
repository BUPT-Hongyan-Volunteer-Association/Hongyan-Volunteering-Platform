-- Align existing invalid preview summaries with their stored row-filter flags.
WITH review_counts AS (
    SELECT batch_id, COUNT(*) AS total
    FROM hour_import_row
    WHERE needs_review
    GROUP BY batch_id
    HAVING bool_or(action = 'error')
)
UPDATE hour_import_batch AS batch
SET summary = jsonb_set(batch.summary, '{misconduct_review_required_count}', to_jsonb(review_counts.total))
FROM review_counts
WHERE batch.id = review_counts.batch_id
  AND batch.status = 'invalid'
  AND batch.summary->'misconduct_review_required_count' IS DISTINCT FROM to_jsonb(review_counts.total);
