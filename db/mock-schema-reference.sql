-- 2026-10-04 schema reference only. Use runtime migrations, never execute this as bootstrap SQL.
CREATE TABLE mock_operations (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, action TEXT NOT NULL,
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(provider, action, request_id)
    );
