-- 2026-10-04 schema reference only. Use runtime migrations, never execute this as bootstrap SQL.
CREATE INDEX "account_userId_idx" on "account" ("userId");

CREATE INDEX evidence_by_case ON evidence_files(order_id,case_id,created_at);

CREATE INDEX notification_inbox ON notifications(user_id,created_at);

CREATE INDEX notification_jobs_due ON notification_jobs(status,next_at);

CREATE INDEX offer_history ON dispatch_offers(order_id,user_id,created_at);

CREATE UNIQUE INDEX one_order_invitation ON dispatch_offers(order_id) WHERE status='pending';

CREATE UNIQUE INDEX one_provider_invitation ON dispatch_offers(user_id) WHERE status='pending';

CREATE UNIQUE INDEX one_provider_order ON orders(provider_id) WHERE status IN ('ready','active','finishing','confirming','aftercare');

CREATE INDEX orders_buyer ON orders(buyer_id,created_at);

CREATE INDEX orders_provider ON orders(provider_id,created_at);

CREATE INDEX payment_jobs_due ON payment_jobs(status,next_at);

CREATE INDEX payment_receipts_order ON payment_receipts(order_id,observed_at);

CREATE INDEX runtime_limits_expiry ON runtime_limits(expires_at);

CREATE INDEX security_proofs_user ON security_proofs(user_id);

CREATE INDEX "session_userId_idx" on "session" ("userId");

CREATE INDEX team_feedback_target ON team_feedback(target_id);

CREATE INDEX team_member_user ON team_members(user_id,updated_at);

CREATE INDEX team_message_room ON team_messages(room_id,id);

CREATE UNIQUE INDEX team_one_pending_appeal ON team_appeals(user_id,report_id) WHERE status='pending';

CREATE INDEX team_room_board ON team_rooms(status,created_at,id);

CREATE INDEX team_room_owner ON team_rooms(owner_id,status);

CREATE INDEX "twoFactor_secret_idx" on "twoFactor" ("secret");

CREATE INDEX "twoFactor_userId_idx" on "twoFactor" ("userId");

CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");

CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

CREATE TABLE app_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);

CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, target_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE business_requests (user_id TEXT NOT NULL REFERENCES user(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id,request_id));

CREATE TABLE dispatch_offers (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), user_id TEXT NOT NULL REFERENCES user(id), status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','expired','invalidated')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, reason TEXT NOT NULL);

CREATE TABLE evidence_files (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), case_id TEXT NOT NULL,
    uploader_id TEXT NOT NULL REFERENCES user(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(uploader_id,request_id));

CREATE TABLE notification_jobs (id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE RESTRICT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0, retry_base INTEGER NOT NULL DEFAULT 0);

CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), order_id TEXT NOT NULL REFERENCES orders(id) DEFERRABLE INITIALLY DEFERRED, label TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);

CREATE TABLE operation_alerts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT NOT NULL, code TEXT NOT NULL, opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER, occurrences INTEGER NOT NULL DEFAULT 1);

CREATE TABLE orders (id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES user(id), provider_id TEXT REFERENCES user(id), status TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);

CREATE TABLE payment_jobs (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), action TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', next_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, retry_base INTEGER NOT NULL DEFAULT 0);

CREATE TABLE payment_journal_legacy (job_id TEXT PRIMARY KEY REFERENCES payment_jobs(id) ON DELETE RESTRICT);

CREATE TABLE payment_receipts (
      job_id TEXT PRIMARY KEY REFERENCES payment_jobs(id) ON DELETE RESTRICT,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      provider TEXT NOT NULL CHECK(provider='local'),
      receipt_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('pay','refund')),
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0 AND amount_cents<=9007199254740991),
      currency TEXT NOT NULL CHECK(currency='CNY'),
      payment_id TEXT,
      simulated INTEGER NOT NULL CHECK(simulated=1),
      observed_at INTEGER NOT NULL,
      UNIQUE(provider,receipt_id)
    );

CREATE TABLE products (id TEXT PRIMARY KEY, payload TEXT NOT NULL);

CREATE TABLE provider_presence (user_id TEXT PRIMARY KEY REFERENCES user(id), seen_at INTEGER NOT NULL);

CREATE TABLE provider_profiles (user_id TEXT PRIMARY KEY REFERENCES user(id), payload TEXT NOT NULL, suspended INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '');

CREATE TABLE "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

CREATE TABLE released_services (order_id TEXT NOT NULL REFERENCES orders(id), user_id TEXT NOT NULL REFERENCES user(id), payload TEXT NOT NULL, PRIMARY KEY(order_id,user_id));

CREATE TABLE runtime_limits (
  namespace TEXT NOT NULL, key_hash TEXT NOT NULL, count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, PRIMARY KEY(namespace,key_hash)
);

CREATE TABLE runtime_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER, finished_at INTEGER, next_at INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '');

CREATE TABLE security_proofs (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  verified_at INTEGER NOT NULL
);

CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

CREATE TABLE team_appeals(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES user(id),report_id TEXT NOT NULL REFERENCES team_reports(id),reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),decision_reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,reviewed_at INTEGER);

CREATE TABLE team_blocks(user_id TEXT NOT NULL REFERENCES user(id),room_id TEXT NOT NULL REFERENCES team_rooms(id),created_at INTEGER NOT NULL,PRIMARY KEY(user_id,room_id));

CREATE TABLE team_feedback(room_id TEXT NOT NULL REFERENCES team_rooms(id),actor_id TEXT NOT NULL REFERENCES user(id),target_id TEXT NOT NULL REFERENCES user(id),payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(room_id,actor_id,target_id));

CREATE TABLE team_members(room_id TEXT NOT NULL REFERENCES team_rooms(id),user_id TEXT NOT NULL REFERENCES user(id),state TEXT NOT NULL CHECK(state IN ('requested','confirmed','ended','left','withdrawn','rejected')),note TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(room_id,user_id));

CREATE TABLE team_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT NOT NULL REFERENCES team_rooms(id),user_id TEXT NOT NULL REFERENCES user(id),content TEXT NOT NULL,created_at INTEGER NOT NULL);

CREATE TABLE team_reports(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES team_rooms(id),actor_id TEXT NOT NULL REFERENCES user(id),target_id TEXT NOT NULL REFERENCES user(id),kind TEXT NOT NULL,reason TEXT NOT NULL,snapshot TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','verified','dismissed')),decision_reason TEXT NOT NULL DEFAULT '',reviewer_id TEXT REFERENCES user(id),created_at INTEGER NOT NULL,reviewed_at INTEGER,UNIQUE(room_id,actor_id,target_id));

CREATE TABLE team_requests(user_id TEXT NOT NULL REFERENCES user(id),request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,request_id));

CREATE TABLE team_restrictions(user_id TEXT PRIMARY KEY REFERENCES user(id),report_id TEXT NOT NULL REFERENCES team_reports(id),reason TEXT NOT NULL,recovery TEXT NOT NULL,expires_at INTEGER NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);

CREATE TABLE team_rooms(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES user(id),status TEXT NOT NULL CHECK(status IN ('open','ended')),payload TEXT NOT NULL,created_at INTEGER NOT NULL,ended_at INTEGER,version INTEGER NOT NULL DEFAULT 0);

CREATE TABLE "twoFactor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references "user" ("id") on delete cascade, "verified" integer, "failedVerificationCount" integer, "lockedUntil" date);

CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "role" text, "termsAccepted" integer not null, "termsVersion" text, "twoFactorEnabled" integer default 0);

CREATE TABLE user_preferences (user_id TEXT PRIMARY KEY REFERENCES user(id), payload TEXT NOT NULL);

CREATE TABLE team_history_hidden(user_id TEXT NOT NULL REFERENCES user(id),room_id TEXT NOT NULL REFERENCES team_rooms(id),member_updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,room_id));

CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

CREATE TRIGGER payment_receipts_no_delete BEFORE DELETE ON payment_receipts
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PAYMENT_RECEIPT'); END;

CREATE TRIGGER payment_receipts_no_update BEFORE UPDATE ON payment_receipts
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PAYMENT_RECEIPT'); END;

-- 013-site-feedback (2026-10-09). Reference only; runtime migration is authoritative.
CREATE TABLE site_feedback (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id),
 request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('bug','experience','suggestion')),
 content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','handling','resolved','rejected')),
 version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, UNIQUE(user_id,request_id)
);
CREATE INDEX site_feedback_owner ON site_feedback(user_id,created_at);
CREATE TABLE site_feedback_events (
 id INTEGER PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES site_feedback(id),
 actor_id TEXT NOT NULL REFERENCES user(id), status TEXT NOT NULL,
 reason TEXT NOT NULL, created_at INTEGER NOT NULL
);
