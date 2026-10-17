-- Better Auth 1.7.6 with native two-factor plugin; SQLite schema snapshot, 2026-10-04.
-- Reference only: runtime migrations are owned by server/auth.mjs; do not run this file as a migration.
CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

CREATE TABLE "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

CREATE TABLE "twoFactor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references "user" ("id") on delete cascade, "verified" integer, "failedVerificationCount" integer, "lockedUntil" date);

CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "role" text, "termsAccepted" integer not null, "termsVersion" text, "twoFactorEnabled" integer default 0);

CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

CREATE INDEX "account_userId_idx" on "account" ("userId");

CREATE INDEX "session_userId_idx" on "session" ("userId");

CREATE INDEX "twoFactor_secret_idx" on "twoFactor" ("secret");

CREATE INDEX "twoFactor_userId_idx" on "twoFactor" ("userId");

CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");
