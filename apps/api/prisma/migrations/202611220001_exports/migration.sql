CREATE TABLE "export_job" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "file_name" TEXT,
    "content_type" TEXT,
    "size" INTEGER,
    "contents" BYTEA,
    "error_message" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "export_job_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "export_job_actor_id_created_at_idx" ON "export_job"("actor_id", "created_at");
CREATE INDEX "export_job_status_expires_at_idx" ON "export_job"("status", "expires_at");
