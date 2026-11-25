BEGIN;

-- 仅更新含旧字段或旧校区名的活动版本。保留原修订号、审核时间和来源引用。
WITH legacy AS (
    SELECT activity_id, revision, content,
           COALESCE(content->'contacts', '[]'::jsonb) AS contacts
    FROM activity_revision
    WHERE content ?| ARRAY['phone','wechat','contact_text','result_expected_at','hours_import_expected_at']
       OR content->>'campus' IN ('沙河','海淀','海淀校区','西土城','两个校区')
), normalized AS (
    SELECT activity_id, revision,
           (content - ARRAY['phone','wechat','contact_text','result_expected_at','hours_import_expected_at'])
           || CASE WHEN content ?| ARRAY['contacts','phone','wechat','contact_text'] THEN
                jsonb_build_object('contacts', contacts || COALESCE((
                    SELECT jsonb_agg(item ORDER BY first_pos) FROM (
                        SELECT item, min(pos) AS first_pos
                        FROM unnest(ARRAY[content->>'phone',content->>'wechat',content->>'contact_text'])
                             WITH ORDINALITY AS legacy_contact(item,pos)
                        WHERE btrim(item) <> '' AND NOT (contacts ? item)
                        GROUP BY item
                    ) extras
                ), '[]'::jsonb))
              ELSE '{}'::jsonb END
           || jsonb_strip_nulls(jsonb_build_object(
                'campus', CASE content->>'campus'
                   WHEN '沙河' THEN '沙河校区' WHEN '海淀' THEN '西土城校区' WHEN '海淀校区' THEN '西土城校区'
                   WHEN '西土城' THEN '西土城校区' WHEN '两个校区' THEN '沙河及西土城校区' END,
                'result_expected_date', COALESCE(content->>'result_expected_date',
                   to_char((content->>'result_expected_at')::timestamptz AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')),
                'hours_import_date', COALESCE(content->>'hours_import_date',
                   to_char((content->>'hours_import_expected_at')::timestamptz AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD'))
           )) AS content
    FROM legacy
)
UPDATE activity_revision r SET content=n.content FROM normalized n
WHERE r.activity_id=n.activity_id AND r.revision=n.revision;

COMMIT;
