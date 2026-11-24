-- Migration number: 0003
-- D1 migrations 0001 (tasks) and 0002 (memories) already exist in this repository,
-- so this migration uses the next available sequence number.
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS akashic_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_akashic_log_user_created
    ON akashic_log (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_akashic_log_created
    ON akashic_log (created_at DESC);
