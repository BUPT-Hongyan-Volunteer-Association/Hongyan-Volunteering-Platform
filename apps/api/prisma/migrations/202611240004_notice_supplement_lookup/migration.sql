-- 集合源被替代时，按源 ID 找到仍有效的独立补发通知。
CREATE INDEX notice_current_supplement_source ON notice(source_notice_id)
WHERE source_notice_id IS NOT NULL AND is_current;
