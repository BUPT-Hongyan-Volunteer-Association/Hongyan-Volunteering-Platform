-- CreateTable
CREATE TABLE "registration" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "registration_student_id_idx" ON "registration"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "registration_activity_id_student_id_key" ON "registration"("activity_id", "student_id");

-- AddForeignKey
ALTER TABLE "registration" ADD CONSTRAINT "registration_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration" ADD CONSTRAINT "registration_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

