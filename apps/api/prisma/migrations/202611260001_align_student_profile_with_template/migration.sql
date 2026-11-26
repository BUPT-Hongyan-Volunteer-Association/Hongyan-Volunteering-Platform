BEGIN;
-- 旧任务不能按更宽的条件重新生成。已生成的旧格式文件需重新导出。
UPDATE export_job
SET status = 'failed', version = version + 1, contents = NULL, size = NULL,
    error_message = '导出格式已更新，请重新导出', updated_at = CURRENT_TIMESTAMP
WHERE type = 'admin_students' AND
      (status = 'ready' OR (scope ? 'cohort' AND status IN ('pending', 'running')));
UPDATE export_job SET scope = scope - 'cohort' WHERE scope ? 'cohort';
UPDATE command_receipt SET response = response #- '{data,cohort}' WHERE (response->'data') ? 'cohort';
-- 启动后按当前表头重新校验尚未确认的预览。
UPDATE student_import_batch SET status = 'validating', version = version + 1, updated_at = CURRENT_TIMESTAMP
WHERE status IN ('ready','invalid');
UPDATE student_import_row SET raw_values = raw_values - 'cohort' WHERE raw_values ? 'cohort';
ALTER TABLE student_import_row DROP COLUMN cohort;
ALTER TABLE student DROP COLUMN cohort;
COMMIT;
