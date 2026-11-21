CREATE TABLE "activity_group_image" (
  "id" UUID PRIMARY KEY,
  "activity_id" UUID NOT NULL REFERENCES "activity"("id") ON DELETE CASCADE,
  "media_type" TEXT NOT NULL,
  "contents" BYTEA NOT NULL
);
CREATE INDEX "activity_group_image_activity_id_idx" ON "activity_group_image" ("activity_id");
