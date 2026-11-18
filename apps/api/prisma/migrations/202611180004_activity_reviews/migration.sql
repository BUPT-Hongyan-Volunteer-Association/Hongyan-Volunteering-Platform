-- CreateTable
CREATE TABLE "activity_review" (
    "id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "previous_revision" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "submitted_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(3),

    CONSTRAINT "activity_review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "command_receipt" (
    "account_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "command_receipt_pkey" PRIMARY KEY ("account_id","method","path","key")
);

-- CreateIndex
CREATE INDEX "activity_review_status_created_at_idx" ON "activity_review"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "activity_review_activity_id_revision_key" ON "activity_review"("activity_id", "revision");

-- AddForeignKey
ALTER TABLE "activity_review" ADD CONSTRAINT "activity_review_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX one_pending_review ON activity_review(activity_id) WHERE status='pending';
ALTER TABLE activity_review ADD CONSTRAINT reviewed_snapshot FOREIGN KEY (activity_id,revision) REFERENCES activity_revision(activity_id,revision);
ALTER TABLE activity_review ADD CONSTRAINT previous_snapshot FOREIGN KEY (activity_id,previous_revision) REFERENCES activity_revision(activity_id,revision);
CREATE SEQUENCE activity_code_seq START 10001;
INSERT INTO activity_review(id,activity_id,revision,submitted_by)
SELECT gen_random_uuid(),activity_id,revision,created_by FROM activity_revision WHERE revision_state='pending_review';
