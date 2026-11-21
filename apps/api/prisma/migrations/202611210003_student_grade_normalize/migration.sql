BEGIN;

-- 年级只保留四位入学年份；历史「YYYY级」去掉后缀，其他非空格式清空后按学号前四位补齐。
UPDATE student
SET grade = regexp_replace(grade, '级$', '')
WHERE grade ~ '^[0-9]{4}级$';

UPDATE student
SET grade = NULL
WHERE grade IS NOT NULL AND grade !~ '^[0-9]{4}$';

UPDATE student
SET grade = substring(student_no from 1 for 4)
WHERE grade IS NULL AND student_no ~ '^(19|20)[0-9]{2}';

COMMIT;
