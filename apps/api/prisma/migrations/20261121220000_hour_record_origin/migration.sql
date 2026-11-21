BEGIN;

-- 旧预览数据保留原值。新增或修改的记录必须关联一个实际存在的入账来源。
ALTER TABLE hour_record
    ADD CONSTRAINT hour_record_requires_origin CHECK (num_nonnulls(batch_id, correction_group_id) = 1) NOT VALID,
    ADD CONSTRAINT hour_record_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES hour_import_batch(id) ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
    ADD CONSTRAINT hour_record_correction_group_id_fkey FOREIGN KEY (correction_group_id) REFERENCES hour_correction_group(id) ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

DROP INDEX hour_record_current_key;
CREATE UNIQUE INDEX hour_record_current_key ON hour_record (student_id, service_date, activity_id)
    WHERE status = 'current' AND (batch_id IS NOT NULL OR correction_group_id IS NOT NULL);

COMMIT;
