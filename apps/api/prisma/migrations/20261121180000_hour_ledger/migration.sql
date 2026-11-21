BEGIN;

-- 旧库没有正式入账审批路径。保留原 ID、值和安排版本，来源和审批时间留空。
DROP INDEX "hour_record_student_id_service_date_activity_id_key";

ALTER TABLE "hour_record" DROP CONSTRAINT "hour_record_valid_values";
ALTER TABLE "hour_record" ADD CONSTRAINT "hour_record_valid_values" CHECK (
    "status" IN ('current', 'superseded', 'voided') AND "hours" > 0 AND "version" >= 1 AND
    "origin_schedule_revision" >= 1 AND "misconduct_version" >= 0 AND
    "misconduct_reported" IN ('none', 'reported', 'not_provided')
);
CREATE UNIQUE INDEX "hour_record_current_key"
    ON "hour_record" ("student_id", "service_date", "activity_id") WHERE "status" = 'current';

CREATE TABLE "hour_ledger_lock" ("key" TEXT PRIMARY KEY);

-- AlterTable
ALTER TABLE "hour_import_batch" ADD COLUMN     "decision_reason" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reviewed_by" UUID,
ADD COLUMN     "submitted_at" TIMESTAMPTZ(3),
ADD COLUMN     "void_record_id" UUID,
ALTER COLUMN "source_file_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "hour_record" ADD COLUMN     "batch_id" UUID,
ADD COLUMN     "correction_group_id" UUID,
ADD COLUMN     "created_at" TIMESTAMPTZ(3),
ADD COLUMN     "remark" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "supersedes_record_id" UUID,
ADD COLUMN     "updated_at" TIMESTAMPTZ(3),
ADD COLUMN     "voided_by_batch_id" UUID,
ADD COLUMN     "voided_by_group_id" UUID;

ALTER TABLE "hour_record" ADD CONSTRAINT "hour_record_single_origin"
    CHECK (num_nonnulls("batch_id", "correction_group_id") <= 1);
CREATE UNIQUE INDEX "hour_import_batch_pending_void"
    ON "hour_import_batch" ("void_record_id") WHERE "mode" = 'void' AND "status" = 'pending_review';

-- CreateTable
CREATE TABLE "incident" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "activity_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "service_date" DATE NOT NULL,
    "occurred_at" TIMESTAMPTZ(3),
    "facts" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_batch_id" UUID,
    "source_row_number" INTEGER,
    "submitted_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "review_reason" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hour_fact_review" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "service_date" DATE NOT NULL,
    "fact" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "incident_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hour_fact_review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hour_correction_group" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "reason" TEXT NOT NULL,
    "submitted_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "decision_reason" TEXT,
    "appeal_id" UUID,
    "items" JSONB NOT NULL,
    "source_record_ids" UUID[],
    "warnings" JSONB NOT NULL,
    "warning_snapshot_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hour_correction_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hour_correction_group_activity" (
    "group_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,

    CONSTRAINT "hour_correction_group_activity_pkey" PRIMARY KEY ("group_id","activity_id")
);

-- CreateTable
CREATE TABLE "hour_appeal" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "student_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID,
    "service_date" DATE NOT NULL,
    "requested_hours" DECIMAL(4,1),
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolution" TEXT,
    "correction_batch_id" UUID,
    "correction_group_id" UUID,
    "result_hour_record_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "hour_appeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incident_activity_id_student_id_service_date_idx" ON "incident"("activity_id", "student_id", "service_date");

-- CreateIndex
CREATE INDEX "incident_student_id_status_created_at_idx" ON "incident"("student_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "hour_fact_review_student_id_service_date_activity_id_idx" ON "hour_fact_review"("student_id", "service_date", "activity_id");

-- CreateIndex
CREATE INDEX "audit_event_actor_id_created_at_idx" ON "audit_event"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_event_resource_id_created_at_idx" ON "audit_event"("resource_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_event_created_at_idx" ON "audit_event"("created_at");

-- CreateIndex
CREATE INDEX "hour_correction_group_status_created_at_idx" ON "hour_correction_group"("status", "created_at");

-- CreateIndex
CREATE INDEX "hour_correction_group_source_record_ids_idx" ON "hour_correction_group" USING GIN ("source_record_ids");

-- CreateIndex
CREATE INDEX "hour_correction_group_activity_activity_id_idx" ON "hour_correction_group_activity"("activity_id");

-- CreateIndex
CREATE INDEX "hour_appeal_student_id_created_at_idx" ON "hour_appeal"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "hour_appeal_activity_id_status_created_at_idx" ON "hour_appeal"("activity_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "hour_appeal_status_created_at_idx" ON "hour_appeal"("status", "created_at");

-- CreateIndex
CREATE INDEX "hour_record_student_id_service_date_activity_id_idx" ON "hour_record"("student_id", "service_date", "activity_id");

-- CreateIndex
CREATE INDEX "hour_record_activity_id_service_date_idx" ON "hour_record"("activity_id", "service_date");

-- AddForeignKey
ALTER TABLE "hour_fact_review" ADD CONSTRAINT "hour_fact_review_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hour_correction_group_activity" ADD CONSTRAINT "hour_correction_group_activity_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "hour_correction_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hour_correction_group_activity" ADD CONSTRAINT "hour_correction_group_activity_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hour_appeal" ADD CONSTRAINT "hour_appeal_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hour_appeal" ADD CONSTRAINT "hour_appeal_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "hour_appeal_open_record"
    ON "hour_appeal" ("student_id", "target_type", "target_id")
    WHERE "status" IN ('pending', 'in_review') AND "target_id" IS NOT NULL;
CREATE UNIQUE INDEX "hour_appeal_open_missing"
    ON "hour_appeal" ("student_id", "activity_id", "service_date")
    WHERE "status" IN ('pending', 'in_review') AND "target_type" = 'missing_hours';

COMMIT;
