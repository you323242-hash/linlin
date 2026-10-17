import { APIError } from 'better-auth/api';
import { migrate } from './migrations.mjs';
import { BusinessError } from './market.mjs';
import { createPersistentLimiter } from './limits.mjs';

const PROOF_AGE = 15 * 60_000;
const messages = {
  INVALID_PASSWORD: '当前密码不正确。', PASSWORD_TOO_SHORT: '新密码至少12个字符。',
  PASSWORD_TOO_LONG: '密码最多128个字符。', INVALID_CODE: '验证码不正确。',
  INVALID_BACKUP_CODE: '恢复码无效或已使用。', INVALID_TWO_FACTOR_COOKIE: '验证已失效，请重新登录。',
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: '尝试次数过多，请重新登录后验证。',
  ACCOUNT_TEMPORARILY_LOCKED: '验证尝试过多，请15分钟后重试。',
  TOTP_ALREADY_ENABLED: '已启用二次验证。', TOTP_NOT_ENABLED: '请先设置二次验证。',
};

// Forward rotated/expired cookies between native auth calls; never return session tokens to this UI.
export function authCookies(headers, responseHeaders) {
  const next = new Headers(headers), cookies = new Map();
  for (const part of (next.get('cookie') || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) cookies.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const value of responseHeaders.getSetCookie()) {
    const part = value.split(';')[0], i = part.indexOf('=');
    if (i > 0) { if (part.slice(i + 1)) cookies.set(part.slice(0, i), part.slice(i + 1)); else cookies.delete(part.slice(0, i)); }
  }
  next.set('cookie', [...cookies].map(([k, v]) => k + '=' + v).join('; ')); return next;
}

export function createSecurity(db, auth, { environment = 'local', now = Date.now } = {}) {
  migrate(db, '005-account-security', `
CREATE TABLE security_proofs (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  verified_at INTEGER NOT NULL
);
CREATE INDEX security_proofs_user ON security_proofs(user_id);
`);
  const attempts = createPersistentLimiter(db, { namespace: 'security', limit: 5, now });
  // In-process serialization complements database transactions; multi-host needs a shared database.
  const active = new Set();
  const audit = (actor, action, reason, target = actor) => db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES (?,?,?,?,?)').run(actor, target, 'security_' + action, reason, now());
  function proof(session) {
    const row = db.prepare('SELECT verified_at FROM security_proofs WHERE session_id=? AND user_id=?').get(session.session.id, session.user.id);
    return !!row && row.verified_at <= now() && now() - row.verified_at < PROOF_AGE;
  }
  function requireProof(session) {
    if (!session.user.twoFactorEnabled || !proof(session)) throw new BusinessError('请在账户安全中完成二次验证，再执行此操作。', 428);
  }
  function assertAdmin(session) {
    if (session.user.role !== 'admin') throw new BusinessError('需要管理员权限。', 403);
    // Legacy local test admins stay usable; all deployed staging admins must enroll and verify.
    if (!['local', 'test'].includes(environment) || session.user.twoFactorEnabled) requireProof(session);
  }
  function view(session) {
    const rows = db.prepare('SELECT id,createdAt,expiresAt,userAgent FROM session WHERE userId=? AND expiresAt>? ORDER BY createdAt DESC LIMIT 100').all(session.user.id, now());
    return { emailRecoveryEligible: !session.user.email.toLowerCase().endsWith('@phone.example.invalid'), twoFactorEnabled: !!session.user.twoFactorEnabled, verifiedUntil: proof(session) ? db.prepare('SELECT verified_at FROM security_proofs WHERE session_id=?').get(session.session.id).verified_at + PROOF_AGE : null,
      admin: session.user.role === 'admin', adminVerificationRequired: !['local', 'test'].includes(environment),
      sessions: rows.map(row => ({ id: row.id, current: row.id === session.session.id, createdAt: row.createdAt, expiresAt: row.expiresAt,
        device: /mobile|android|iphone/i.test(row.userAgent || '') ? '移动设备' : row.userAgent ? '电脑或其他设备' : '未记录设备' })) };
  }
  async function command(action, body, headers, session, clientIP) {
    if (!session && action !== 'verify') throw new BusinessError('请先登录。', 401);
    if (!attempts((session?.user.id || clientIP) + ':' + action)) throw new BusinessError('安全操作过于频繁，请一分钟后重试。', 429);
    const actorKey = session?.user.id || clientIP;
    if (active.has(actorKey)) throw new BusinessError('另一项安全操作正在处理，请稍后重试。', 409);
    active.add(actorKey);
    let forwarded = headers;
    const responseHeaders = new Headers();
    const call = async (method, fields = {}) => {
      const result = await auth.api[method]({ headers: forwarded, body: fields, returnHeaders: true });
      for (const cookie of result.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
      forwarded = authCookies(forwarded, result.headers); return result.response;
    };
    const current = async () => {
      const result = await auth.api.getSession({ headers: forwarded, returnHeaders: true });
      for (const cookie of result.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
      if (!result.response) throw new BusinessError('会话已失效，请重新登录。', 401);
      return result.response;
    };
    try {
      let data = { success: true };
      if (action === 'verify') {
        if (typeof body.code !== 'string' || !body.code.trim() || body.code.length > 40 || !['totp', 'backup'].includes(body.method || 'totp')) throw new BusinessError('请输入有效验证码或恢复码。', 400);
        const enrolling = session && !session.user.twoFactorEnabled;
        await call(body.method === 'backup' ? 'verifyBackupCode' : 'verifyTOTP', { code: body.code.trim(), trustDevice: false });
        const verified = await current();
        if (!verified.user.twoFactorEnabled) throw new BusinessError('二次验证未完成。', 428);
        if (enrolling) { await call('revokeOtherSessions'); db.prepare('DELETE FROM security_proofs WHERE user_id=?').run(verified.user.id); }
        db.prepare('INSERT INTO security_proofs VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET verified_at=excluded.verified_at').run(verified.session.id, verified.user.id, now());
        audit(verified.user.id, 'verified', enrolling ? '确认二次验证设置并撤销其他会话' : '使用验证码或单次恢复码完成二次验证');
      } else if (action === 'password') {
        if (session.user.twoFactorEnabled) requireProof(session);
        await call('changePassword', { currentPassword: body.currentPassword, newPassword: body.newPassword, revokeOtherSessions: true });
        db.prepare('DELETE FROM security_proofs WHERE user_id=?').run(session.user.id);
        audit(session.user.id, 'password_changed', '通过认证库修改密码并撤销原会话；管理员需重新二次验证');
      } else if (action === 'enroll') {
        if (session.user.twoFactorEnabled) throw new BusinessError('已启用二次验证。', 409);
        data = await call('enableTwoFactor', { password: body.password, method: 'totp' });
        audit(session.user.id, 'enrollment_started', '通过当前密码开始设置；尚未验证不视为启用');
      } else if (action === 'disable') {
        if (session.user.role === 'admin') throw new BusinessError('管理员不能关闭二次验证；需先由授权操作撤销管理权限。', 403);
        requireProof(session); await call('disableTwoFactor', { password: body.password }); await call('revokeOtherSessions');
        db.prepare('DELETE FROM security_proofs WHERE user_id=?').run(session.user.id);
        audit(session.user.id, 'disabled', '通过近期二次验证和密码关闭；撤销其他会话');
      } else if (action === 'backup-codes') {
        requireProof(session); data = await call('generateBackupCodes', { password: body.password });
        audit(session.user.id, 'backup_codes_rotated', '重新生成单次恢复码，旧码失效');
      } else if (action === 'revoke') {
        if (typeof body.id !== 'string' || body.id.length > 128) throw new BusinessError('会话编号无效。', 400);
        const target = db.prepare('SELECT id,token FROM session WHERE id=? AND userId=?').get(body.id, session.user.id);
        if (!target) throw new BusinessError('该会话不存在或已失效。', 404);
        if (target.id === session.session.id) throw new BusinessError('退出当前会话请使用退出登录。', 409);
        await call('revokeSession', { token: target.token }); db.prepare('DELETE FROM security_proofs WHERE session_id=?').run(target.id);
        audit(session.user.id, 'session_revoked', '用户撤销自己的一条其他登录会话');
      } else if (action === 'revoke-others') {
        await call('revokeOtherSessions'); db.prepare('DELETE FROM security_proofs WHERE user_id=? AND session_id<>?').run(session.user.id, session.session.id);
        audit(session.user.id, 'other_sessions_revoked', '用户撤销其他登录会话');
      } else throw new BusinessError('此账户安全操作尚未开放。', 404);
      return { data, headers: responseHeaders };
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      if (session) audit(session.user.id, 'rejected', '认证库拒绝安全操作：' + action);
      const code = error.body?.code;
      throw new BusinessError(messages[code] || '安全验证未成功，请检查输入或重新登录。', error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500);
    } finally { active.delete(actorKey); }
  }
  return { view, command, assertAdmin };
}
