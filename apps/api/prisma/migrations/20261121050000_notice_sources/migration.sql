CREATE INDEX "activity_change_event_activity_id_revision_idx" ON "activity_change_event" ("activity_id", "revision");
CREATE INDEX "notification_event_activity_id_event_type_source_revision_idx" ON "notification_event" ("activity_id", "event_type", "source_revision");

-- 早期投递曾把业务来源换成通知 ID。保留原队列和回执的标识，恢复可追溯的业务来源。
UPDATE notification_event q
SET resource_id = r.id
FROM activity_review r
WHERE q.event_type = 'activity_changed' AND q.event_key = 'activity_change:' || r.id
  AND q.resource_id IS DISTINCT FROM r.id;

UPDATE notification_event q
SET resource_id = d.registration_id,
    payload = q.payload || jsonb_build_object('registration_version', d.registration_version)
FROM registration_decision_event d
WHERE q.event_type = 'registration_decided' AND q.payload->>'event_id' = d.event_id::text
  AND (q.resource_id IS DISTINCT FROM d.registration_id OR NOT (q.payload ? 'registration_version'));

ALTER TABLE notification_event ALTER COLUMN resource_id SET NOT NULL;

-- 升级前已获批的变更沿用审核时的接收人快照，每次审核只登记一个投递事件。
INSERT INTO notification_event
  (id, event_type, event_key, activity_id, resource_id, source_revision, payload, created_at, updated_at)
SELECT gen_random_uuid(), 'activity_changed', 'activity_change:' || review_id,
       activity_id, review_id, revision, '{}'::jsonb, MIN(created_at), CURRENT_TIMESTAMP
FROM activity_change_event
GROUP BY review_id, activity_id, revision
ON CONFLICT DO NOTHING;

-- 使用该次决定的历史版本，即使之后报名状态或处理意见发生了变化。
INSERT INTO notification_event
  (id, event_type, event_key, activity_id, resource_id, payload, created_at, updated_at)
SELECT e.event_id, e.event_type, 'registration_decision:' || e.event_id, e.activity_id, e.registration_id,
       jsonb_build_object('event_id', e.event_id, 'registration_id', e.registration_id,
                          'student_id', e.student_id, 'registration_version', e.registration_version,
                          'status', e.status, 'decision_reason', h.decision_reason, 'actor_id', h.actor_id),
       e.created_at, CURRENT_TIMESTAMP
FROM registration_decision_event e
LEFT JOIN registration_history h ON h.registration_id = e.registration_id AND h.version = e.registration_version
WHERE NOT EXISTS (
  SELECT 1 FROM notification_event q
  WHERE q.event_type = 'registration_decided' AND q.payload->>'event_id' = e.event_id::text
)
ON CONFLICT DO NOTHING;
