-- Migration number: 0002
-- Create the memory table during deployment rather than on every tool call.
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    memory TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Supports per-user history retrieval ordered from newest to oldest.
CREATE INDEX IF NOT EXISTS idx_memories_user_created_at
    ON memories (user_id, created_at DESC);
