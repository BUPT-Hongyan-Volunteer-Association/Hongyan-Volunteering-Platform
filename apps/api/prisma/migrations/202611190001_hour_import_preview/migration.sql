-- CreateTable
CREATE TABLE "hour_import_file" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "contents" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hour_import_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hour_import_batch" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "source_file_id" UUID NOT NULL,
    "report_file_id" UUID,
    "submitted_by" UUID NOT NULL,
    "validation_by" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'validating',
    "version" INTEGER NOT NULL DEFAULT 1,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "metadata" JSONB NOT NULL,
    "summary" JSONB NOT NULL,

    CONSTRAINT "hour_import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hour_import_row" (
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "needs_review" BOOLEAN NOT NULL,
    "detail" JSONB NOT NULL,

    CONSTRAINT "hour_import_row_pkey" PRIMARY KEY ("batch_id","row_number")
);

-- CreateTable
CREATE TABLE "hour_record" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "service_date" DATE NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "hours" DECIMAL(4,1) NOT NULL,
    "origin_schedule_revision" INTEGER NOT NULL,
    "misconduct_reported" TEXT NOT NULL,
    "misconduct_version" INTEGER NOT NULL,
    "misconduct_fact" TEXT,
    "reusable_facts" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "hour_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hour_import_batch_activity_id_created_at_id_idx" ON "hour_import_batch"("activity_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "hour_import_batch_status_created_at_idx" ON "hour_import_batch"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "hour_record_student_id_service_date_activity_id_key" ON "hour_record"("student_id", "service_date", "activity_id");

-- AddForeignKey
ALTER TABLE "hour_import_file" ADD CONSTRAINT "hour_import_file_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hour_import_batch" ADD CONSTRAINT "hour_import_batch_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hour_import_batch" ADD CONSTRAINT "hour_import_batch_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "hour_import_file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hour_import_batch" ADD CONSTRAINT "hour_import_batch_report_file_id_fkey" FOREIGN KEY ("report_file_id") REFERENCES "hour_import_file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hour_import_row" ADD CONSTRAINT "hour_import_row_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "hour_import_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hour_record" ADD CONSTRAINT "hour_record_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hour_record" ADD CONSTRAINT "hour_record_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hour_record" ADD CONSTRAINT "hour_record_valid_values" CHECK (
    "status" IN ('current', 'voided') AND "hours" > 0 AND "version" >= 1 AND
    "origin_schedule_revision" >= 1 AND "misconduct_version" >= 0 AND
    "misconduct_reported" IN ('none', 'reported', 'not_provided')
);
