BEGIN;

-- 年级统一为四位入学年份；历史遗留的空年级按学号前四位补齐。
UPDATE student
SET grade = substring(student_no from 1 for 4)
WHERE (grade IS NULL OR btrim(grade) = '')
  AND student_no ~ '^(19|20)[0-9]{2}';

UPDATE student
SET grade = regexp_replace(grade, '级$', '')
WHERE grade ~ '^[0-9]{4}级$';

COMMIT;
