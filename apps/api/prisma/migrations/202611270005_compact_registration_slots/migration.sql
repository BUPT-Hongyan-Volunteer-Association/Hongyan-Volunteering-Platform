BEGIN;

-- Only rewrite a snapshot if its label exactly matches the one generated from its approved item.
-- This also leaves role names or custom text that happen to contain date ranges untouched.
CREATE TEMP TABLE compact_registration_labels ON COMMIT DROP AS
WITH slots AS (
    SELECT a.id AS activity_id, item->>'id' AS item_id, item->>'role' AS role,
           (item->>'starts_at')::timestamptz AT TIME ZONE 'Asia/Shanghai' AS start_time,
           (item->>'ends_at')::timestamptz AT TIME ZONE 'Asia/Shanghai' AS end_time
    FROM activity a
    JOIN activity_revision rev ON (rev.activity_id, rev.revision) = (a.id, a.published_revision)
    CROSS JOIN LATERAL jsonb_array_elements(rev.content->'registration_items') AS item
    WHERE item ? 'starts_at' AND item ? 'ends_at'
), labels AS (
    SELECT activity_id, item_id,
           concat_ws(' · ', nullif(role, ''), to_char(start_time, 'YYYY-MM-DD HH24:MI') || ' 至 ' ||
               to_char(end_time, 'YYYY-MM-DD HH24:MI')) AS old_label,
           concat_ws(' · ', nullif(role, ''), CASE WHEN start_time::date = end_time::date
               THEN to_char(start_time, 'YYYY-MM-DD HH24:MI') || '–' || to_char(end_time, 'HH24:MI')
               ELSE to_char(start_time, 'YYYY-MM-DD') || ' 全天' END) AS new_label
    FROM slots
    WHERE start_time::date = end_time::date OR
          (start_time::time = time '00:00' AND end_time = start_time + interval '1 day')
)
SELECT r.id, r.activity_id, l.old_label, l.new_label
FROM registration r JOIN labels l ON r.activity_id = l.activity_id AND r.item_id::text = lower(l.item_id)
WHERE r.item_label = l.old_label;

UPDATE registration r SET item_label = l.new_label FROM compact_registration_labels l WHERE l.id = r.id;

-- Delivered system notifications contain a frozen title/role prefix and optionally the organizer's remarks.
-- Swap just the label in that prefix; leave the original title, remarks, receipt and notice version intact.
WITH prefixes AS (
    SELECT n.id, l.old_label, l.new_label,
           CASE WHEN e.event_type = 'request_decided' THEN ''
                WHEN e.payload->>'status' = 'accepted' THEN '恭喜，你已被录取：「' || (rev.content->>'title') || ' · '
                ELSE '「' || (rev.content->>'title') || ' · ' END AS prefix
    FROM notice n
    JOIN notification_event e ON e.id = n.source_event_id
    JOIN activity_revision rev ON (rev.activity_id, rev.revision) = (n.activity_id, n.source_revision)
    LEFT JOIN exit_request x ON e.event_type = 'request_decided' AND x.id = e.resource_id
    JOIN compact_registration_labels l ON l.activity_id = n.activity_id AND l.id = coalesce(x.registration_id, e.resource_id)
    WHERE n.notice_kind = 'result' AND e.event_type IN ('registration_decided', 'request_decided')
)
UPDATE notice n
SET body = p.prefix || p.new_label || substr(n.body, length(p.prefix || p.old_label) + 1)
FROM prefixes p WHERE n.id = p.id AND starts_with(n.body, p.prefix || p.old_label);

COMMIT;
