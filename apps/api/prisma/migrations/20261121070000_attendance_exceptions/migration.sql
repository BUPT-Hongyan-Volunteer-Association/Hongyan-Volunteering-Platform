CREATE TYPE "AttendanceStatus" AS ENUM ('late', 'absent', 'excused', 'other', 'unregistered_participation');

CREATE TABLE "attendance_record" (
  "id" UUID PRIMARY KEY,
  "activity_id" UUID NOT NULL REFERENCES "activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "student_id" UUID NOT NULL REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "service_date" DATE NOT NULL,
  "status" "AttendanceStatus" NOT NULL,
  "reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cleared_at" TIMESTAMPTZ(3)
);

CREATE UNIQUE INDEX "attendance_record_activity_id_student_id_service_date_key"
  ON "attendance_record" ("activity_id", "student_id", "service_date");
CREATE INDEX "attendance_record_activity_id_cleared_at_service_date_idx"
  ON "attendance_record" ("activity_id", "cleared_at", "service_date");
