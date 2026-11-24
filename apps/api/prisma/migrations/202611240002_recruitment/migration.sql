BEGIN;
ALTER TABLE exit_request ADD COLUMN kind TEXT NOT NULL DEFAULT 'exit'
    CHECK (kind IN ('exit','restoration'));
ALTER TABLE notice_receipt ADD COLUMN follow_up_closed BOOLEAN NOT NULL DEFAULT false;
UPDATE notice_receipt receipt SET follow_up_closed=true
FROM notice n JOIN registration r ON r.activity_id=n.activity_id
WHERE receipt.notice_id=n.id AND receipt.student_id=r.student_id
  AND n.notice_kind='gathering' AND r.status='exited';
DROP INDEX notice_activity_id_notice_kind_information_version_key;
CREATE UNIQUE INDEX notice_source_version ON notice(activity_id, notice_kind, information_version)
    WHERE source_notice_id IS NULL;

CREATE FUNCTION close_recruitment_requests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    WITH cancelled AS (
        UPDATE exit_request q SET status = 'cancelled', version = q.version + 1,
            updated_at = CURRENT_TIMESTAMP
        FROM registration r WHERE r.id = q.registration_id AND r.activity_id = NEW.id AND q.status = 'pending'
        RETURNING q.id, q.kind, r.student_id
    )
    INSERT INTO notification_event(id,event_type,event_key,activity_id,resource_id,payload,updated_at)
        SELECT gen_random_uuid(),'request_decided','request_cancelled:' || id,NEW.id,id,
            jsonb_build_object('student_id',student_id,'kind',kind,'status','cancelled'),CURRENT_TIMESTAMP
        FROM cancelled;
    RETURN NEW;
END $$;
CREATE TRIGGER activity_close_recruitment AFTER UPDATE OF status ON activity
    FOR EACH ROW WHEN (NEW.status IN ('completed','cancelled') AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION close_recruitment_requests();
-- 收尾升级前已处于终态的申请，保留历史申请及原报名。
WITH closed AS (
    UPDATE exit_request q SET status='cancelled', version=q.version+1, updated_at=CURRENT_TIMESTAMP
    FROM registration r JOIN activity a ON a.id=r.activity_id
    WHERE q.registration_id=r.id AND q.status='pending' AND a.status IN ('completed','cancelled')
    RETURNING q.id,q.kind,r.activity_id,r.student_id
)
INSERT INTO notification_event(id,event_type,event_key,activity_id,resource_id,payload,updated_at)
SELECT gen_random_uuid(),'request_decided','request_cancelled:' || id,activity_id,id,
       jsonb_build_object('student_id',student_id,'kind',kind,'status','cancelled'),CURRENT_TIMESTAMP FROM closed;
CREATE FUNCTION retire_gathering_supplements() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE notice SET is_current=false, version=version+1, updated_at=CURRENT_TIMESTAMP
    WHERE source_notice_id=NEW.id AND is_current;
    RETURN NEW;
END $$;
CREATE TRIGGER retire_gathering AFTER UPDATE OF is_current ON notice
    FOR EACH ROW WHEN (OLD.is_current AND NOT NEW.is_current AND NEW.notice_kind='gathering' AND NEW.source_notice_id IS NULL)
    EXECUTE FUNCTION retire_gathering_supplements();
COMMIT;
