BEGIN;
CREATE INDEX notification_registration_decision_resource
    ON notification_event(resource_id) WHERE event_type = 'registration_decided';

-- 升级前已发送的旧报名结果仍可查看，其回执保留为历史。
UPDATE notice n
SET is_current = false, version = n.version + 1, updated_at = CURRENT_TIMESTAMP
FROM notification_event e JOIN registration r ON r.id = e.resource_id
WHERE n.source_event_id = e.id AND n.is_current AND e.event_type = 'registration_decided'
  AND e.payload->>'registration_version' <> r.version::text;
COMMIT;
