-- CreateTable
CREATE TABLE "review_audit" (
    "review_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "before_status" TEXT NOT NULL,
    "after_status" TEXT NOT NULL,
    "before_public" INTEGER,
    "after_public" INTEGER,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_audit_pkey" PRIMARY KEY ("review_id")
);

-- CreateTable
CREATE TABLE "activity_change_event" (
    "review_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "changed_fields" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_change_event_pkey" PRIMARY KEY ("review_id","student_id")
);

