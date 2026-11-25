BEGIN;

UPDATE activity_revision
SET content = content - 'result_expected_date'
WHERE content ? 'result_expected_date';

-- 已成功的创建、编辑、送审和审核请求可能重放原响应。保留原幂等键和审核结果。
UPDATE command_receipt
SET response = response
    #- '{data,result_expected_date}' #- '{data,result_expected_at}'
    #- '{data,snapshot,content,result_expected_date}' #- '{data,snapshot,content,result_expected_at}'
    #- '{data,previous_published_snapshot,content,result_expected_date}'
    #- '{data,previous_published_snapshot,content,result_expected_at}'
WHERE (response->'data') ?| ARRAY['result_expected_date', 'result_expected_at']
   OR (response #> '{data,snapshot,content}') ?| ARRAY['result_expected_date', 'result_expected_at']
   OR (response #> '{data,previous_published_snapshot,content}') ?| ARRAY['result_expected_date', 'result_expected_at'];

UPDATE command_receipt
SET response = jsonb_set(response, '{data,changes}', COALESCE((
    SELECT jsonb_agg(change ORDER BY position)
    FROM jsonb_array_elements(response #> '{data,changes}') WITH ORDINALITY AS changes(change, position)
    WHERE change->>'field_path' NOT IN ('result_expected_date', 'result_expected_at')
), '[]'::jsonb))
WHERE (response #> '{data,changes}') @> '[{"field_path":"result_expected_date"}]'
   OR (response #> '{data,changes}') @> '[{"field_path":"result_expected_at"}]';

COMMIT;
