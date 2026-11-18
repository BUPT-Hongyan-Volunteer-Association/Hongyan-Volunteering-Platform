CREATE TABLE "http_session" (
    "id_hash" CHAR(64) PRIMARY KEY,
    "csrf_token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL
);

CREATE INDEX "http_session_expires_at_idx" ON "http_session" ("expires_at");
