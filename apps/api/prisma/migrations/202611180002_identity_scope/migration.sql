-- CreateEnum
CREATE TYPE "Role" AS ENUM ('student', 'organizer', 'reviewer', 'tech_admin');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('owner', 'collaborator');

-- AlterTable
ALTER TABLE "http_session" ADD COLUMN     "account_id" UUID;

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "student_no" CHAR(10) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_grant" (
    "account_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "role_grant_pkey" PRIMARY KEY ("account_id","role")
);

-- CreateTable
CREATE TABLE "login_window" (
    "key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "login_window_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "activity" (
    "id" UUID NOT NULL,
    "activity_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "team_version" INTEGER NOT NULL DEFAULT 1,
    "working_revision" INTEGER NOT NULL,
    "published_revision" INTEGER,

    CONSTRAINT "activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_revision" (
    "activity_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "revision_state" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ(3),

    CONSTRAINT "activity_revision_pkey" PRIMARY KEY ("activity_id","revision")
);

-- CreateTable
CREATE TABLE "activity_member" (
    "activity_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "member_role" "MemberRole" NOT NULL,

    CONSTRAINT "activity_member_pkey" PRIMARY KEY ("activity_id","account_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_username_key" ON "account"("username");

-- CreateIndex
CREATE UNIQUE INDEX "student_account_id_key" ON "student"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_student_no_key" ON "student"("student_no");

-- CreateIndex
CREATE INDEX "login_window_expires_at_idx" ON "login_window"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "activity_activity_code_key" ON "activity"("activity_code");

-- CreateIndex
CREATE INDEX "activity_member_account_id_idx" ON "activity_member"("account_id");

-- CreateIndex
CREATE INDEX "http_session_account_id_idx" ON "http_session"("account_id");

-- AddForeignKey
ALTER TABLE "http_session" ADD CONSTRAINT "http_session_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student" ADD CONSTRAINT "student_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_grant" ADD CONSTRAINT "role_grant_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_revision" ADD CONSTRAINT "activity_revision_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_member" ADD CONSTRAINT "activity_member_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_member" ADD CONSTRAINT "activity_member_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX activity_one_owner ON activity_member(activity_id) WHERE member_role='owner';
