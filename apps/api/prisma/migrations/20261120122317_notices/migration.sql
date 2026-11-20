-- CreateTable
CREATE TABLE "notice" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "activity_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "requires_ack" BOOLEAN NOT NULL DEFAULT true,
    "notice_kind" TEXT NOT NULL,
    "information_version" INTEGER NOT NULL DEFAULT 1,
    "source_notice_id" UUID,
    "supersedes_id" UUID,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice_receipt" (
    "notice_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "acknowledged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_receipt_pkey" PRIMARY KEY ("notice_id","student_id")
);

-- CreateTable
CREATE TABLE "notification_event" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "event_type" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "activity_id" UUID,
    "resource_id" UUID,
    "source_revision" INTEGER,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_retry_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notice_activity_id_notice_kind_is_current_idx" ON "notice"("activity_id", "notice_kind", "is_current");

-- CreateIndex
CREATE INDEX "notice_receipt_student_id_idx" ON "notice_receipt"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_event_event_key_key" ON "notification_event"("event_key");

-- CreateIndex
CREATE INDEX "notification_event_status_next_retry_at_idx" ON "notification_event"("status", "next_retry_at");

-- AddForeignKey
ALTER TABLE "notice_receipt" ADD CONSTRAINT "notice_receipt_notice_id_fkey" FOREIGN KEY ("notice_id") REFERENCES "notice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_receipt" ADD CONSTRAINT "notice_receipt_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
