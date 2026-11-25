BEGIN;

INSERT INTO audit_event(id, actor_id, action, resource_type, resource_id, reason, before, after, created_at)
SELECT review_id, actor_id, 'review_activity', 'activity_review', review_id, reason,
       jsonb_build_object('activity_id', activity_id, 'revision', revision, 'status', before_status, 'published_revision', before_public),
       jsonb_build_object('activity_id', activity_id, 'revision', revision, 'status', after_status, 'published_revision', after_public),
       created_at
FROM review_audit;

-- 保留旧建种和导入记录此刻可核对的事实，仅提交状态有已知的变更时间。
INSERT INTO registration_history(registration_id, version, status, submitted_at, statement, decision_reason, changed_at)
SELECT id, version, status, submitted_at, statement, decision_reason,
       CASE WHEN status = 'submitted' THEN submitted_at END
FROM registration
ON CONFLICT (registration_id, version) DO NOTHING;

-- 旧决定均须已有版本历史和投递来源。任何不一致都回滚，保留原表供检查。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM registration_decision_event d
    WHERE NOT EXISTS (SELECT 1 FROM registration_history h
                      WHERE h.registration_id = d.registration_id AND h.version = d.registration_version AND h.status = d.status)
       OR NOT EXISTS (SELECT 1 FROM notification_event e
                      WHERE e.resource_id = d.registration_id AND e.activity_id = d.activity_id
                        AND e.event_type = 'registration_decided' AND e.payload->>'event_id' = d.event_id::text
                        AND e.payload->>'registration_version' = d.registration_version::text)
  ) THEN RAISE EXCEPTION '报名决定与历史版本或投递来源不一致'; END IF;
END $$;

CREATE UNIQUE INDEX notification_decision_version ON notification_event(resource_id, (payload->>'registration_version'))
    WHERE event_type = 'registration_decided';

DROP TABLE registration_decision_event;
DROP TABLE review_audit;
COMMIT;
