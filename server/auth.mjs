import { betterAuth } from 'better-auth';
import { twoFactor, phoneNumber, anonymous } from 'better-auth/plugins';
import { APIError } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLocalEmail } from './providers/email-local.mjs';
import { createLocalPhone, validPhone } from './providers/phone-local.mjs';

export async function createAuth({ baseURL, dataDirectory, environment = process.env.APP_ENV || (process.env.NODE_ENV === 'test' ? 'test' : 'local'), emailProvider = createLocalEmail({ dataDirectory, environment }), requireEmailVerification = environment === 'staging' || process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === 'true', phoneMode = process.env.AUTH_PHONE_MODE || 'disabled' }) {
  mkdirSync(dataDirectory, { recursive: true });
  let secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') throw new Error('Production requires BETTER_AUTH_SECRET.');
    const filename = path.join(dataDirectory, 'auth-secret');
    if (!existsSync(filename) && existsSync(path.join(dataDirectory, 'auth.sqlite'))) throw new Error('已有用户库缺少认证密钥，请从备份恢复；不会重新生成。');
    try { writeFileSync(filename, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    secret = readFileSync(filename, 'utf8').trim();
  }
  if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters.');
  if (process.env.NODE_ENV === 'production' && !baseURL.startsWith('https://')) throw new Error('Production requires HTTPS.');
  const fingerprint = createHash('sha256').update(secret).digest('hex');
  const keyIdentity = path.join(dataDirectory, 'auth-key.json');
  if (existsSync(keyIdentity)) {
    const stored = JSON.parse(readFileSync(keyIdentity, 'utf8'));
    if (stored.version !== 1 || stored.fingerprint !== fingerprint) throw new Error('认证密钥与此数据目录不一致，请恢复原密钥。');
  } else {
    const restoredManifest = path.join(dataDirectory, 'manifest.json');
    if (existsSync(restoredManifest)) {
      const restored = JSON.parse(readFileSync(restoredManifest, 'utf8'));
      if (restored.auth?.mode === 'external' && restored.auth.fingerprint !== fingerprint) throw new Error('恢复环境的认证密钥不匹配。');
    }
    writeFileSync(keyIdentity, JSON.stringify({ version: 1, fingerprint }), { flag: 'wx', mode: 0o600 });
  }
  const database = new DatabaseSync(path.join(dataDirectory, 'auth.sqlite'));
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const lifecycleAudit = (actor, target, action) => {
    // Standalone auth/seed initialization can precede the business schema.
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='audit_events'").get())
      database.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES (?,?,?,?,?)').run(actor,target,action,'认证库生命周期事件；二次验证是否完成须另查安全事件',Date.now());
  };
  const options = {
    appName: '三角洲陪玩',
    baseURL,
    secret,
    database,
    trustedOrigins: [baseURL],
    plugins: [anonymous({ disableDeleteAnonymousUser: true, generateName: () => '游客 ' + randomBytes(3).toString('hex') }), twoFactor({ issuer: 'Delta Companion', skipVerificationOnEnable: false }), ...(phoneMode === 'mock' ? [phoneNumber({
      sendOTP: createLocalPhone({ dataDirectory, environment }).send,
      phoneNumberValidator: validPhone, expiresIn: 300, allowedAttempts: 3, requireVerification: true,
      signUpOnVerification: { getTempEmail: phone => createHash('sha256').update(phone).digest('hex').slice(0, 32) + '@phone.example.invalid', getTempName: () => '新队友' },
      callbackOnVerification: async ({ user }) => lifecycleAudit(user.id, user.id, 'phone_mock_verified'),
    })] : [])],
    telemetry: { enabled: false },
    logger: { disabled: true }, // App-level audit/status logs omit addresses and recovery credentials.
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128,
      requireEmailVerification, revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 15 * 60,
      ...(emailProvider ? { sendResetPassword: async ({ user, token }) => {
        await emailProvider.send({ recipient: user.email, purpose: 'reset', url: baseURL + '/recovery.html#reset=' + encodeURIComponent(token) });
      }, onPasswordReset: async ({ user }) => lifecycleAudit(user.id, user.id, 'password_reset') } : {}),
    },
    ...(emailProvider ? { emailVerification: { expiresIn: 15 * 60,
      sendOnSignUp: true, autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, token }) => {
        await emailProvider.send({ recipient: user.email, purpose: 'verify', url: baseURL + '/recovery.html#verify=' + encodeURIComponent(token) });
      }, afterEmailVerification: async user => lifecycleAudit(user.id, user.id, 'email_verified'),
    } } : {}),
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    user: {
      additionalFields: {
        role: { type: ['user', 'admin'], required: false, defaultValue: 'user', input: false },
        termsAccepted: { type: 'boolean', required: true, input: true, returned: false },
        termsVersion: { type: 'string', required: false, defaultValue: '2026-09-30-preview', input: false, returned: false },
      },
    },
    databaseHooks: {
      user: { create: { before: async user => {
        // The HTTP guest endpoint checks explicit consent before invoking the plugin.
        if (user.isAnonymous === true) user = { ...user, termsAccepted: true };
        if (user.termsAccepted !== true) throw new APIError('BAD_REQUEST', { message: '请先阅读并同意用户服务协议与免责声明。' });
        const name = user.name.trim();
        if (!name || name.length > 32) throw new APIError('BAD_REQUEST', { message: '昵称需要 1–32 个字符。' });
        return { data: { ...user, name } };
      }, after: async user => lifecycleAudit(user.id,user.id,'user_registered') } },
      session: { create: { after: async session => lifecycleAudit(session.userId,session.id,'session_created') },
        delete: { after: async session => lifecycleAudit(session.userId,session.id,'session_revoked') } },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 100,
      customRules: { '/sign-in/anonymous': { window: 3600, max: 5 }, '/sign-in/email': { window: 60, max: 10 }, '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 3 }, '/send-verification-email': { window: 60, max: 3 },
        '/reset-password': { window: 60, max: 5 }, '/verify-email': { window: 60, max: 5 } } },
    advanced: { cookiePrefix: environment === 'local' ? 'delta' : `delta-${environment}`, useSecureCookies: baseURL.startsWith('https://'), ipAddress: { ipAddressHeaders: ['x-delta-client-ip'] } },
  };
  // Better Auth owns its schema and password/session handling. Apply its supported migration API.
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const auth = betterAuth(options);
  // Finish the library's initialization/schema check before a short-lived seed closes SQLite.
  const context = await auth.$context;
  await context.checkSchema?.();
  return { auth, database };
}
