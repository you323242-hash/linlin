import { backupBeforeUpgrade } from './upgrade-backup.mjs';
import { randomUUID } from 'node:crypto';
import { acquireDataLock } from './data-lock.mjs';
import { createWorker, checkDisk, safeErrorCode } from './operations.mjs';
import { createLogger } from './logger.mjs';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { createAuth } from './auth.mjs';
import { PROJECT_ROOT, localConfig, prepareRuntimeDirectory } from './config.mjs';
import { applyRequestContext } from './request-context.mjs';
import { createLocalProviders } from './providers/local.mjs';
import { createMarket, BusinessError } from './market.mjs';
import { createEvidence, FILE_LIMIT } from './evidence.mjs';
import { createPersistentLimiter } from './limits.mjs';
import { createTeams } from './teams.mjs';
import { createPersonas } from './personas.mjs';
import { createSecurity } from './security.mjs';
import { createFeedback } from './feedback.mjs';
import { inspectClosureDependencies } from './privacy-lifecycle.mjs';
import { createPrivacyGrants } from './privacy-grants.mjs';
import {createTeamProfiles,teamChannel} from './team-profiles.mjs';
import { appendOwnEvidenceCopy } from './privacy-evidence-copy.mjs';
import { protectResponse, isJSON } from './http-protection.mjs';
import { integrationCapabilities, inspectIntegrationPreparation } from './integrations.mjs';
import { validPhone } from './providers/phone-local.mjs';

const project = PROJECT_ROOT;
const dist = path.join(project, 'dist');
const config = localConfig();
const { port, baseURL, dataDirectory, providerMode, environment } = config;
const releaseDataLock = await acquireDataLock(dataDirectory);
prepareRuntimeDirectory(config);
const logger = createLogger(path.join(dataDirectory, 'logs'));
const providers = createLocalProviders({ directory: dataDirectory, mode: providerMode, storageMaxBytes: FILE_LIMIT, environment, allowStagingMocks: config.allowStagingMocks });
const upgradeSnapshot = await backupBeforeUpgrade(config);
if (upgradeSnapshot) logger({ event: 'upgrade_backup_created' });
const { auth, database } = await createAuth(config);
const market = createMarket(database, providers, { paidOrdersEnabled: config.paidOrdersEnabled });
const personas = createPersonas(database,{canEditPaid:id=>!!market.profile(id)});
const teamProfiles=createTeamProfiles(database,{legacy:personas.view});
const teams = createTeams(database, { persona:teamProfiles.appearance });
const security = createSecurity(database, auth, config);
const feedback = createFeedback(database,{assertAdmin:security.assertAdmin});
const privacyGrants = createPrivacyGrants(database,auth,{enrich:(copy,userId)=>appendOwnEvidenceCopy(database,userId,copy,providers.storage)});
const allowFeedback = createPersistentLimiter(database,{namespace:'site-feedback',limit:5});
const evidence = createEvidence(database, market, providers.storage);
let activeUploads = 0;
const allowPeer = createPersistentLimiter(database, { namespace: 'peer', limit: 600 });
const allowUser = createPersistentLimiter(database, { namespace: 'user', limit: 200 });
const allowAuthPeer = createPersistentLimiter(database, { namespace: 'auth-peer', limit: 40 });
const allowGuest = createPersistentLimiter(database, { namespace: 'guest-login', limit: 5, windowMs: 3600000 });
const allowHealthPeer = createPersistentLimiter(database, { namespace: 'health-peer', limit: 60 });
const allowPersona = createPersistentLimiter(database, { namespace:'persona-edit', limit:10 });
const allowSquad = createPersistentLimiter(database, { namespace:'paid-squad-edit', limit:10 });
const allowPhoneSend = createPersistentLimiter(database, { namespace: 'phone-send', limit: 1 });
const allowPhoneBind = createPersistentLimiter(database, { namespace: 'phone-bind', limit: 5 });
const allowPhonePassword = createPersistentLimiter(database, { namespace: 'phone-password-login', limit: 10 });
const phoneLocks = new Set();
const worker = createWorker(database, market.operations, [
  { id: 'payments', run: () => market.drainPayments() },
  { id: 'dispatch', run: () => market.dispatch() },
  { id: 'maintenance', run: () => market.maintain() },
  { id: 'notifications', run: () => market.drainNotifications() },
  { id: 'storage-health', run: () => {
    checkDisk(dataDirectory, market.operations);
    if (logger.healthy()) market.operations.resolve('runtime:logs');
    else market.operations.alert('runtime:logs', 'runtime', 'logs', 'LOG_WRITE_FAILED');
  } },
], { logger });
await worker.start();
const userView = ({ id, name, email, emailVerified, role, phoneNumber, isAnonymous }) => ({ id, name, email: isAnonymous ? '' : email, emailVerified, role, isGuest: isAnonymous === true, ...(phoneNumber ? { phoneMasked: phoneNumber.slice(0, 6) + '****' + phoneNumber.slice(-4), phoneVerification: 'mock', phonePasswordSet: !!database.prepare("SELECT 1 FROM account WHERE userId=? AND providerId='credential' AND password IS NOT NULL").get(id) } : {}) });
const handler = toNodeHandler(async request => {
  const response = await auth.handler(request);
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  const data = await response.json();
  if (new URL(request.url).pathname === '/api/auth/phone-number/verify' && response.ok && data.token && data.user) {
    const session = database.prepare('SELECT id FROM session WHERE token=? AND userId=?').get(data.token, data.user.id);
    if (session) {
      const identifier = 'phone-password:' + session.id, now = Date.now();
      database.prepare('DELETE FROM verification WHERE identifier=?').run(identifier);
      await (await auth.$context).internalAdapter.createVerificationValue({identifier,value:data.user.id,expiresAt:new Date(now+300000)});
    }
  }
  // This website authenticates through HttpOnly cookies, never JSON bearer tokens.
  if (data && typeof data === 'object') {
    if (new URL(request.url).pathname === '/api/auth/sign-up/email' && data.token === null) data.verificationRequired = true;
    delete data.token;
    if (data.user) data.user = userView(data.user);
    if (data.session) data.session = { id: data.session.id, expiresAt: data.session.expiresAt };
    if (new URL(request.url).pathname === '/api/auth/phone-number/send-otp' && response.ok) { data.message = '验证码已写入私有测试收件箱，不会发送短信。'; data.simulated = true; data.delivered = false; }
  }
  const headers = new Headers(response.headers); headers.delete('content-length');
  return new Response(JSON.stringify(data), { status: response.status, headers });
});
const authRoutes = new Map([
  ['/api/auth/sign-up/email', 'POST'], ['/api/auth/sign-in/email', 'POST'],
  ['/api/auth/sign-in/anonymous', 'POST'],
  ['/api/auth/sign-out', 'POST'], ['/api/auth/get-session', 'GET'],
  ['/api/auth/send-verification-email', 'POST'], ['/api/auth/verify-email', 'GET'],
  ['/api/auth/request-password-reset', 'POST'], ['/api/auth/reset-password', 'POST'],
]);
if (config.phoneMode === 'mock') { for (const route of ['/api/auth/phone-number/send-otp','/api/auth/phone-number/verify','/api/auth/phone-number/set-password','/api/auth/sign-in/phone-number']) authRoutes.set(route, 'POST'); }
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const json = (res, status, body) => { if (status === 413) { res.shouldKeepAlive = false; res.setHeader('Connection', 'close'); } res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
async function getSession(req, res) {
  const result = await auth.api.getSession({ headers: fromNodeHeaders(req.headers), returnHeaders: true });
  const cookies = result.headers.getSetCookie();
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  return result.response;
}
async function readJSON(req, limit = 65536) {
  let size = 0; const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new BusinessError('提交内容过大。', 413); }
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BusinessError('JSON 格式无效。', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BusinessError('参数无效。', 400);
  return body;
}

const server = http.createServer({ maxHeaderSize: 16384 }, async (req, res) => {
  const requestId = randomUUID(), startedAt = Date.now();
  let route = 'unknown', orderId;
  res.setHeader('X-Request-ID', requestId);
  res.once('finish', () => logger({ event: 'request', requestId, method: req.method, route, orderId, status: res.statusCode, durationMs: Date.now() - startedAt }));
  protectResponse(res, config);
  res.setHeader('X-Delta-Environment', environment);
  try {
    const context = applyRequestContext(req, config);
    if (context.status) return json(res, context.status, { message: context.message });
    const url = new URL(req.url, baseURL);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { message: '请求路径无效。' }); }
    if (/[\u0000-\u001f\u007f]/.test(pathname)) return json(res, 400, { message: '请求路径无效。' });
    route = pathname.startsWith('/api/auth/') ? 'auth' : pathname.startsWith('/api/admin') ? 'admin' : pathname.startsWith('/api/orders') ? 'orders' : pathname.startsWith('/api/') ? 'api' : 'page';
    orderId = pathname.match(/^\/api\/orders\/(DF[A-Za-z0-9]{20})(?:\/|$)/)?.[1];
    if (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/') && pathname !== '/api/health' && !allowPeer(context.clientIP)) { res.setHeader('Retry-After', '60'); return json(res, 429, { message: '请求过于频繁，请稍后重试。' }); }
    if (pathname.startsWith('/api/') && req.headers.cookie) {
      const session = await getSession(req, res);
      if (session?.user.isAnonymous) {
        const guestAuth = ['/api/auth/sign-out', '/api/auth/get-session', '/api/auth/sign-in/anonymous'].includes(pathname);
        if ((pathname.startsWith('/api/auth/') && !guestAuth) || /^\/api\/(security|privacy|admin|team-admin)(\/|$)/.test(pathname)) return json(res, 403, { message: '此功能需要正式账号；请先退出游客登录。' });
      }
    }
    if (pathname === '/api/integrations' && req.method === 'GET') return json(res, 200, integrationCapabilities());
    if (/^\/api\/payment-callbacks\/(wechat|alipay)$/.test(pathname)) {
      // No acknowledgement, parsing, receipt insertion or order mutation until a verified adapter exists.
      res.shouldKeepAlive = false; res.setHeader('Connection', 'close');
      return json(res, req.method === 'POST' ? 503 : 405, { code: 'CHANNEL_NOT_READY', message: '真实支付回调尚未开放。' });
    }
    if (pathname.startsWith('/api/auth/')) {
      if (authRoutes.get(pathname) !== req.method) return json(res, 404, { message: '此认证功能尚未开放。' });
      if (req.method === 'POST' && req.headers.origin !== baseURL) return json(res, 403, { message: '请求来源无效。' });
      if (!allowAuthPeer(context.clientIP)) { res.setHeader('Retry-After', '60'); return json(res, 429, { message:'认证请求过于频繁，请稍后重试。' }); }
      if (Number(req.headers['content-length'] || 0) > 16_384) return json(res, 413, { message: '提交内容过长。' });
      if (req.method === 'POST') {
        if (!isJSON(req)) return json(res, 415, { message:'请使用JSON请求。' });
        // Better Call's supported parsed-body bridge retains native auth/cookies,
        // while bounding chunked bodies before the auth handler reads them.
        req.body = await readJSON(req, 16384);
        if (pathname === '/api/auth/sign-in/anonymous') {
          if (req.body.termsAccepted !== true) return json(res,400,{message:'请先阅读并同意用户协议和个人信息说明。'});
          const session = await getSession(req,res);
          if (session) return session.user.isAnonymous ? json(res,200,{user:userView(session.user)}) : json(res,409,{message:'已登录正式账号，请先退出再选择游客登录。'});
          if (!allowGuest(context.clientIP)) { res.setHeader('Retry-After','3600'); return json(res,429,{message:'游客创建过于频繁，请一小时后再试。'}); }
          if (database.prepare('SELECT count(*) n FROM user WHERE isAnonymous=1').get().n >= 1000) return json(res,503,{message:'游客体验名额暂满，请使用正式账号。'});
        }
        if (['/api/auth/sign-up/email', '/api/auth/request-password-reset', '/api/auth/send-verification-email'].includes(pathname) && typeof req.body.email === 'string' && req.body.email.trim().toLowerCase().endsWith('@phone.example.invalid')) return json(res, 400, { message: '该地址仅供手机号内部身份映射。' });
      }
      const redirects = [...url.searchParams.entries()].filter(([field]) => ['callbackURL', 'redirectTo'].includes(field));
      for (const field of ['callbackURL', 'redirectTo']) if (req.body?.[field] !== undefined) redirects.push([field, req.body[field]]);
      for (const [, value] of redirects) {
          let target;
          try {
            if (typeof value !== 'string' || value.length > 2048) throw Error();
            target = new URL(value, baseURL);
          } catch { return json(res, 403, { message: '返回地址无效。' }); }
          if (target.origin !== baseURL || target.username || target.password) return json(res, 403, { message: '返回地址必须属于本站。' });
      }
      // The recovery page consumes JSON and handles its own navigation. Do not
      // expose the auth library's redirect branch for verification errors.
      if (pathname === '/api/auth/verify-email' && ['callbackURL', 'redirectTo'].some(field => url.searchParams.has(field))) {
        return json(res, 400, { message: '验证链接不支持返回地址，请使用邮件中的原始链接。' });
      }
      if (pathname === '/api/auth/reset-password') {
        // Better Auth 1.7.6 uses body.token first, then query.token. Block legacy
        // internal-mailbox tokens before its handler consumes them or changes credentials.
        const token = req.body.token || url.searchParams.get('token');
        if (typeof token === 'string' && token.length <= 2048) {
          const target = database.prepare('SELECT u.email FROM verification v JOIN user u ON u.id=v.value WHERE v.identifier=?').get('reset-password:' + token);
          if (target?.email.toLowerCase().endsWith('@phone.example.invalid')) return json(res, 400, { message: '该账户不支持邮箱密码找回。' });
        }
      }
      res.setHeader('Cache-Control', 'no-store');
      if (pathname === '/api/auth/phone-number/set-password') {
        const session = await getSession(req,res);
        if (!session) return json(res,401,{message:'请先登录。'});
        if (!session.user.phoneNumber || session.user.role === 'admin' || session.user.twoFactorEnabled) return json(res,403,{message:'该账户不支持此密码设置入口。'});
        const identifier='phone-password:'+session.session.id;
        const proof=database.prepare('SELECT value,expiresAt FROM verification WHERE identifier=?').get(identifier);
        if (!proof || proof.value !== session.user.id || !Number.isFinite(new Date(proof.expiresAt).getTime()) || new Date(proof.expiresAt).getTime() <= Date.now()) return json(res,403,{message:'请退出后重新通过手机号验证码登录，5分钟内设置密码。'});
        const password=req.body.newPassword;
        if (typeof password !== 'string' || password.length < 12 || password.length > 128) return json(res,400,{message:'密码需要12–128个字符。'});
        const lock='password:'+session.user.id;
        if (phoneLocks.has(lock)) return json(res,409,{message:'密码设置正在处理。'});
        phoneLocks.add(lock);
        try {
          if (database.prepare("SELECT 1 FROM account WHERE userId=? AND providerId='credential' AND password IS NOT NULL").get(session.user.id)) return json(res,409,{message:'已设置密码，请使用原密码登录；此入口不能修改密码。'});
          await auth.api.setPassword({headers:fromNodeHeaders(req.headers),body:{newPassword:password}});
          database.prepare('DELETE FROM verification WHERE identifier=?').run(identifier);
          await auth.api.revokeOtherSessions({headers:fromNodeHeaders(req.headers)});
          database.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES (?,?,?,?,?)').run(session.user.id,session.user.id,'phone_password_set','首次设置密码；近期模拟验证码证明；撤销其他会话',Date.now());
          return json(res,200,{status:true});
        } finally { phoneLocks.delete(lock); }
      }
      if (pathname === '/api/auth/sign-in/phone-number') {
        const phone=req.body.phoneNumber;
        if (!validPhone(phone) || typeof req.body.password !== 'string' || req.body.password.length > 128) return json(res,400,{message:'手机号或密码格式无效。'});
        if (!allowPhonePassword(phone)) {res.setHeader('Retry-After','60');return json(res,429,{message:'登录尝试过于频繁，请稍后再试。'});}
        const target=database.prepare('SELECT id,role,twoFactorEnabled,phoneNumberVerified FROM user WHERE phoneNumber=?').get(phone);
        if (!target || target.role==='admin' || target.twoFactorEnabled || !target.phoneNumberVerified || !database.prepare("SELECT 1 FROM account WHERE userId=? AND providerId='credential' AND password IS NOT NULL").get(target.id)) return json(res,401,{code:'INVALID_PHONE_NUMBER_OR_PASSWORD',message:'手机号或密码不正确。'});
        if (await getSession(req,res)) return json(res,409,{message:'请先退出当前账户再登录。'});
        req.body={phoneNumber:phone,password:req.body.password,rememberMe:req.body.rememberMe!==false};
      }
      if (pathname.startsWith('/api/auth/phone-number/')) {
        const phone = req.body.phoneNumber;
        if (!validPhone(phone)) return json(res, 400, { message: '请输入+86开头的中国大陆手机号。' });
        if (phoneLocks.has(phone)) return json(res, 409, { message: '验证码操作正在处理，请稍后重试。' });
        phoneLocks.add(phone);
        let bindingLock;
        try {
          if (pathname.endsWith('/send-otp')) {
            if (!allowPhoneSend(phone)) { res.setHeader('Retry-After', '60'); return json(res, 429, { message: '同一号码60秒内只能发送一次。' }); }
            // Resending invalidates any old challenge, preventing multiple valid codes.
            database.prepare('DELETE FROM verification WHERE identifier=?').run(phone);
          } else {
            if (!/^\d{6}$/.test(req.body.code || '')) return json(res, 400, { message: '请输入6位验证码。' });
            const target = database.prepare('SELECT id,role,twoFactorEnabled FROM user WHERE phoneNumber=?').get(phone);
            if (target && (target.role === 'admin' || target.twoFactorEnabled)) return json(res, 403, { message: '此账户请使用原登录方式及二次验证。' });
            const session = await getSession(req, res);
            if (req.body.updatePhoneNumber === true) {
              if (!session) return json(res, 401, { message: '绑定手机号请先登录。' });
              const accountLock = 'bind:' + session.user.id;
              if (phoneLocks.has(accountLock)) return json(res, 409, { message: '手机号绑定正在处理，请稍后重试。' });
              phoneLocks.add(accountLock); bindingLock = accountLock;
              // Re-read under the account lock: the session may predate another binding.
              const current = database.prepare('SELECT role,twoFactorEnabled,phoneNumber FROM user WHERE id=?').get(session.user.id);
              if (!current || current.role === 'admin' || current.twoFactorEnabled || current.phoneNumber) return json(res, 403, { message: '该账户暂不支持模拟绑定或换绑。' });
              if (!allowPhoneBind(session.user.id)) return json(res, 429, { message: '绑定尝试过于频繁。' });
              try { await auth.api.verifyPassword({ headers: fromNodeHeaders(req.headers), body: { password: req.body.password || '' } }); }
              catch { return json(res, 403, { message: '原账户密码核对失败或会话需要重新登录。' }); }
              if (target) return json(res, 409, { message: '此号码已经绑定其他账户。' });
            } else {
              if (session) return json(res, 409, { message: '已登录，请使用绑定功能或先退出账户。' });
              if (!target && req.body.termsAccepted !== true) return json(res, 400, { message: '新用户请先阅读并同意用户协议。' });
            }
            // Forward only the explicitly permitted plugin fields.
            req.body = { phoneNumber: phone, code: req.body.code, ...(req.body.updatePhoneNumber === true ? { updatePhoneNumber: true } : { termsAccepted: req.body.termsAccepted === true }) };
          }
          return await handler(req, res);
        } finally { phoneLocks.delete(phone); if (bindingLock) phoneLocks.delete(bindingLock); }
      }
      return await handler(req, res);
    }
    if (pathname === '/api/products' && req.method === 'GET') return json(res, 200, { products: config.paidOrdersEnabled ? market.products().filter(p => p.status === 'available') : [], paidOrdersEnabled: config.paidOrdersEnabled });
    if (pathname === '/api/persona') {
      const session = await getSession(req, res);
      if (!session) return json(res, 401, { message:'请先登录。' });
      const kind=url.searchParams.get('kind') || 'social';personas.requirePaid(session.user.id,kind);
      if (req.method === 'GET') return json(res, 200, { persona:personas.view(session.user.id,kind) });
      if (req.method !== 'POST') return json(res, 405, { message:'不支持的名片请求。' });
      if (req.headers.origin !== baseURL || !isJSON(req)) return json(res, 403, { message:'请求来源或类型无效。' });
      if (!allowPersona(session.user.id)) return json(res, 429, { message:'名片修改过于频繁，请稍后重试。' });
      return json(res, 200, { persona:personas.save(session.user, await readJSON(req, 740000),kind) });
    }
    const teamPersonaImage=pathname.match(/^\/api\/team-persona-images\/([A-Za-z0-9-]{36})$/);
    if(teamPersonaImage && ['GET','HEAD'].includes(req.method)){
      const type=url.searchParams.get('type');
      if(!['avatar','background'].includes(type))return json(res,400,{message:'图片类型无效。'});
      const room=database.prepare('SELECT owner_id,payload FROM team_rooms WHERE id=?').get(teamPersonaImage[1]);
      const bytes=room && (JSON.parse(room.payload).channel||'pc')==='pc'?(type==='avatar'?personas.avatar(room.owner_id):personas.background(room.owner_id)):null;
      if(!bytes)return json(res,404,{message:'图片不存在。'});
      res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':bytes.length,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox"});return res.end(req.method==='HEAD'?undefined:bytes);
    }
    const avatarRoute = pathname.match(/^\/api\/avatars\/([A-Za-z0-9-]{1,128})$/);
    if (avatarRoute && ['GET','HEAD'].includes(req.method)) {
      const bytes = personas.avatar(avatarRoute[1],url.searchParams.get('kind') || 'social');
      if (!bytes) return json(res, 404, {message:'头像不存在。'});
      res.writeHead(200, {'Content-Type':'image/jpeg','Content-Length':bytes.length,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox"});
      return res.end(req.method === 'HEAD' ? undefined : bytes);
    }
    const personaBackground=pathname.match(/^\/api\/persona-backgrounds\/([A-Za-z0-9-]{1,128})$/);
    const personaSpace=pathname.match(/^\/api\/persona-space\/([A-Za-z0-9-]{1,128})$/);
    const roomSpace=pathname.match(/^\/api\/persona-space\/room\/([A-Za-z0-9-]{36})$/);
    const postImage=pathname.match(/^\/api\/persona-post-images\/([A-Za-z0-9-]{36})$/);
    if(personaBackground && ['GET','HEAD'].includes(req.method)){
      const bytes=personas.background(personaBackground[1],url.searchParams.get('kind') || 'social');
      if(!bytes)return json(res,404,{message:'背景不存在。'});
      res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':bytes.length,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox"});return res.end(req.method==='HEAD'?undefined:bytes);
    }
    if(personaSpace || roomSpace || postImage || pathname==='/api/persona-space'){
      const session=await getSession(req,res);if(!session)return json(res,401,{message:'请先登录后查看个人空间。'});
      if(personaSpace && req.method==='GET')return json(res,200,{posts:personas.listPosts(personaSpace[1])});
      if(roomSpace && req.method==='GET'){
        const room=database.prepare('SELECT owner_id,payload FROM team_rooms WHERE id=?').get(roomSpace[1]);
        if(!room)return json(res,404,{message:'个人空间不存在。'});
        if((JSON.parse(room.payload).channel||'pc')==='mobile')return json(res,404,{message:'手游游戏名片不关联端游个人空间。'});
        return json(res,200,{posts:personas.listPosts(room.owner_id)});
      }
      if(postImage && ['GET','HEAD'].includes(req.method)){
        const bytes=personas.postImage(postImage[1]);if(!bytes)return json(res,404,{message:'图片不存在。'});
        res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':bytes.length,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox"});return res.end(req.method==='HEAD'?undefined:bytes);
      }
      if(pathname==='/api/persona-space' && req.method==='POST'){
        if(req.headers.origin!==baseURL || !isJSON(req))return json(res,403,{message:'请求来源或类型无效。'});
        if(!allowPersona(session.user.id))return json(res,429,{message:'修改过于频繁，请稍后重试。'});
        return json(res,200,{posts:personas.post(session.user,await readJSON(req,540000))});
      }
      return json(res,405,{message:'不支持的空间请求。'});
    }
    if (pathname==='/api/privacy/copy/proof'||pathname==='/api/privacy/copy/download') {
      if(req.method!=='POST')return json(res,405,{message:'请通过本站密码核对领取本人部分资料副本。'});
      if(req.headers.origin!==baseURL||!isJSON(req))return json(res,403,{message:'仅接受本站提交。'});
      if(url.search)return json(res,400,{message:'请勿将密码或领取凭据放入网址。'});
      const body=await readJSON(req,2048);
      const proof=pathname.endsWith('/proof'),field=proof?'password':'token';
      if(Object.keys(body).length!==1||!Object.hasOwn(body,field)||typeof body[field]!=='string')return json(res,400,{message:'提交内容无效。'});
      try {
        const headers=fromNodeHeaders(req.headers);
        if(proof)return json(res,200,await privacyGrants.issue(headers,body.password));
        const copy=await privacyGrants.consume(headers,body.token);
        res.setHeader('Content-Disposition','attachment; filename="qingbo-personal-partial-copy.json"');
        return json(res,200,{...copy,deliveryAvailable:true,scope:'经当前账号密码复验领取的本人部分资料与参与记录摘要；非完整隐私导出，未包含项目见excluded'});
      } catch(error) {
        if(error instanceof BusinessError&&error.status===429)res.setHeader('Retry-After','600');
        throw error;
      }
    }
    if (pathname==='/api/privacy/closure-preflight') {
      if(req.method!=='GET')return json(res,405,{message:'只支持查看本人待处理事项。'});
      const session=await getSession(req,res);
      if(!session)return json(res,401,{message:'请先登录。'});
      if(!allowUser(session.user.id)){res.setHeader('Retry-After','60');return json(res,429,{message:'操作过于频繁，请稍后再试。'});}
      return json(res,200,{preflight:inspectClosureDependencies(database,session.user.id)});
    }
    const feedbackAction=pathname.match(/^\/api\/site-feedback\/([a-f0-9-]{36})\/handle$/);
    const feedbackPreflight=pathname.match(/^\/api\/site-feedback\/([a-f0-9-]{36})\/closure-preflight$/);
    if(pathname==='/api/site-feedback'||pathname==='/api/site-feedback/admin'||feedbackAction||feedbackPreflight){
      const session=await getSession(req,res);
      if(!session)return json(res,401,{message:'请先登录。'});
      if(!allowUser(session.user.id)){res.setHeader('Retry-After','60');return json(res,429,{message:'操作过于频繁，请稍后再试。'});}
      if(feedbackPreflight){
        if(req.method!=='GET')return json(res,405,{message:'仅支持只读核对。'});
        return json(res,200,{preflight:feedback.closurePreflight(session,feedbackPreflight[1])});
      }
      if(req.method==='GET'&&!feedbackAction){
        const options={admin:pathname.endsWith('/admin'),offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||20)};
        return json(res,200,{feedback:feedback.list(session,options)});
      }
      if(req.method!=='POST'||pathname.endsWith('/admin'))return json(res,405,{message:'不支持的意见请求。'});
      if(req.headers.origin!==baseURL||!isJSON(req))return json(res,403,{message:'仅接受本站提交。'});
      if(!allowFeedback(session.user.id)){res.setHeader('Retry-After','60');return json(res,429,{message:'意见提交过于频繁，请一分钟后重试。'});}
      const body=await readJSON(req,12000);
      return json(res,200,{feedback:feedbackAction?feedback.handle(session,feedbackAction[1],body):feedback.submit(session,body)});
    }
    if(pathname==='/api/teams/profile'){
      const channel=teamChannel(url.searchParams.get('channel')||'pc'),session=await getSession(req,res);
      if(!session)return json(res,401,{message:'请先登录后设置游戏名片。'});
      if(!allowUser(session.user.id))return json(res,429,{message:'操作过于频繁，请稍后重试。'});
      if(req.method==='GET')return json(res,200,{profile:teamProfiles.view(session.user.id,channel)});
      if(req.method==='POST'){
        if(req.headers.origin!==baseURL||!isJSON(req))return json(res,403,{message:'仅接受本站提交。'});
        return json(res,200,{profile:teamProfiles.save(session.user,await readJSON(req,12000),channel)});
      }
      return json(res,405,{message:'不支持的名片请求。'});
    }
    const teamDetail = pathname.match(/^\/api\/teams\/([A-Za-z0-9-]{36})$/);
    if (req.method === 'GET' && (pathname === '/api/teams' || teamDetail)) {
      const session = await getSession(req, res);
      return json(res, 200, teamDetail ? teams.read(teamDetail[1], session?.user,teamChannel(url.searchParams.get('channel')||'pc')) : teams.board(Object.fromEntries(url.searchParams), session?.user));
    }
    const teamMessages = pathname.match(/^\/api\/teams\/([A-Za-z0-9-]{36})\/messages$/);
    const teamAction = pathname.match(/^\/api\/teams\/([A-Za-z0-9-]{36})\/actions\/([a-z]+)$/);
    const teamAdmin = pathname.match(/^\/api\/team-admin(?:\/([a-z]+))?$/);
    const teamRoute = ['/api/teams', '/api/teams/mine', '/api/teams/appeal', '/api/teams/history'].includes(pathname) || teamMessages || teamAction || teamAdmin;
    if (/^\/api\/security(?:\/[a-z-]+)?$/.test(pathname)) {
      const session = await getSession(req, res);
      if (req.method === 'GET' && pathname === '/api/security') {
        if (!session) return json(res, 401, { message: '请先登录。' });
        return json(res, 200, security.view(session));
      }
      if (req.method !== 'POST' || pathname === '/api/security') return json(res, 405, { message: '不支持的安全请求。' });
      if (!session && pathname !== '/api/security/verify') return json(res, 401, { message: '请先登录。' });
      if (req.headers.origin !== baseURL || !isJSON(req)) return json(res, 403, { message: '请求来源或类型无效。' });
      const result = await security.command(pathname.split('/')[3], await readJSON(req), fromNodeHeaders(req.headers), session, context.clientIP);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) res.setHeader('Set-Cookie', [...(res.getHeader('Set-Cookie') || []), ...cookies]);
      return json(res, 200, result.data);
    }
    const attachmentsRoute = pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)\/cases\/([A-Za-z0-9-]+)\/attachments$/);
    const fileRoute = pathname.match(/^\/api\/attachments\/([A-Za-z0-9-]+)$/);
    if (attachmentsRoute || fileRoute) {
      const session = await getSession(req, res);
      if (!session) return json(res, 401, { message: '请先登录。' });
      if (session.user.role === 'admin') security.assertAdmin(session);
      if (!allowUser(session.user.id)) { res.setHeader('Retry-After', '60'); return json(res, 429, { message: '操作过于频繁，请稍后重试。' }); }
      if (fileRoute && ['GET', 'HEAD'].includes(req.method)) {
        const file = await evidence.download(session.user, fileRoute[1]);
        res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.bytes, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `attachment; filename="attachment.${file.name.split('.').pop().toLowerCase()}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16))}`, 'Accept-Ranges': 'none' });
        return res.end(req.method === 'HEAD' ? undefined : file.content);
      }
      if (attachmentsRoute && req.method === 'GET') return json(res, 200, { files: evidence.list(session.user, attachmentsRoute[1], attachmentsRoute[2]) });
      if (attachmentsRoute && req.method === 'POST') {
        if (req.headers.origin !== baseURL) return json(res, 403, { message: '请求来源无效。' });
        evidence.access(session.user, attachmentsRoute[1], attachmentsRoute[2], true);
        if (Number(req.headers['content-length'] || 0) > FILE_LIMIT) return json(res, 413, { message: '每个附件不超过5MB。' });
        if (activeUploads >= 2) return json(res, 429, { message: '正在处理其他附件，请稍后重试。' });
        let name, summary;
        try { name = decodeURIComponent(req.headers['x-file-name'] || ''); summary = decodeURIComponent(req.headers['x-file-summary'] || ''); }
        catch { return json(res, 400, { message: '附件信息无效。' }); }
        activeUploads++;
        try {
          let size = 0; const chunks = [];
          for await (const chunk of req) { size += chunk.length; if (size > FILE_LIMIT) throw new BusinessError('每个附件不超过5MB。', 413); chunks.push(chunk); }
          const file = await evidence.upload(session.user, attachmentsRoute[1], attachmentsRoute[2], { name, summary, requestId: req.headers['x-upload-id'], mime: req.headers['content-type']?.split(';')[0] || 'application/octet-stream', content: Buffer.concat(chunks) });
          return json(res, 200, { file });
        } finally { activeUploads--; }
      }
      return json(res, 405, { message: '不支持的附件请求。' });
    }
    const orderRoute = pathname.match(/^\/api\/orders\/(DF[A-Za-z0-9]{20})(?:\/actions\/([A-Za-z]+))?$/);
    if (pathname.startsWith('/api/orders/') && !orderRoute) return json(res, 404, { message: '订单不存在或无权查看。' });
    const businessRoute = ['/api/squads','/api/preferences', '/api/provider', '/api/provider/presence', '/api/notifications', '/api/orders', '/api/queue', '/api/admin'].includes(pathname) || orderRoute || /^\/api\/admin\/[a-z]+$/.test(pathname);
    if (businessRoute || teamRoute) {
      const session = await getSession(req, res);
      if (!session) return json(res, 401, { message: '请先登录。' });
      const user = session.user;
      if (user.role === 'admin' || pathname.startsWith('/api/admin') || teamAdmin) security.assertAdmin(session);
      if (!allowUser(user.id)) { res.setHeader('Retry-After', '60'); return json(res, 429, { message: '操作过于频繁，请稍后重试。' }); }
      if (req.method === 'GET') {
        if(pathname==='/api/squads')return json(res,200,{squad:market.squads.view(user.id)});
        if (pathname === '/api/teams/mine') return json(res, 200, teams.mine(user,teamChannel(url.searchParams.get('channel')||'pc')));
        if (teamMessages) return json(res, 200, teams.messages(teamMessages[1], user, Object.fromEntries(url.searchParams)));
        if (pathname === '/api/team-admin') return json(res, 200, teams.adminData(user));
        if (pathname === '/api/notifications') return json(res, 200, url.searchParams.get('summary') === '1' ? market.unread(user) : market.inbox(user));
        if (pathname === '/api/preferences') return json(res, 200, { preferences: market.preferences(user.id) });
        if (pathname === '/api/provider') return json(res, 200, { profile: market.profile(user.id) });
        if (pathname === '/api/orders') return json(res, 200, { orders: market.list(user, url.searchParams.get('role')), serverNow: Date.now() });
        if (pathname === '/api/queue') return json(res, 200, { orders: market.queue(user) });
        if (pathname === '/api/admin') return json(res, 200, market.adminData(user));
        if (pathname === '/api/admin/integrations') return json(res, 200, inspectIntegrationPreparation());
        if (orderRoute && !orderRoute[2]) return json(res, 200, { order: market.readOrder(orderRoute[1], user) });
      } else if (req.method === 'POST') {
        if (req.headers.origin !== baseURL || !isJSON(req)) return json(res, 403, { message: '请求来源或类型无效。' });
        const body = await readJSON(req);
        if(pathname==='/api/squads'){
          if(!allowSquad(user.id)){res.setHeader('Retry-After','60');return json(res,429,{message:'小队操作过于频繁，请稍后重试。'});}
          if(!['create','join','leave'].includes(body.action))return json(res,400,{message:'小队操作无效。'});
          return json(res,200,await market.command(user,'squad'+body.action[0].toUpperCase()+body.action.slice(1),body));
        }
        if (teamRoute) {
          const scope = pathname === '/api/teams' ? 'publish' : pathname === '/api/teams/appeal' ? 'appeal' : pathname === '/api/teams/history' ? 'history-clear' : teamAction ? teamAction[1] + ':' + teamAction[2] : teamAdmin?.[1] ? 'admin:' + teamAdmin[1] : null;
          if (scope) return json(res, 200, teams.command(user, scope, body,teamChannel(url.searchParams.get('channel')||'pc')));
          return json(res, 405, { message: '不支持的组队请求。' });
        }
        if (pathname === '/api/notifications') return json(res, 200, market.markRead(user, body.id));
        if (pathname === '/api/provider/presence') return json(res, 200, market.heartbeat(user));
        const scope = pathname === '/api/preferences' ? 'preferences' : pathname === '/api/provider' ? 'profile' : pathname === '/api/orders' ? 'create' : /^\/api\/admin\/[a-z]+$/.test(pathname) ? { type: 'admin', action: pathname.split('/')[3] } : orderRoute?.[2] ? { type: 'order', id: orderRoute[1], action: orderRoute[2] } : null;
        if (scope) return json(res, 200, await market.command(user, scope, body));
      }
      return json(res, 405, { message: '不支持的业务请求。' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { message: '不支持的请求方式。' });
    if (pathname === '/api/health') {
      if (!allowHealthPeer(context.clientIP)) { res.setHeader('Retry-After','60'); return json(res,429,{message:'健康检查请求过于频繁。'}); }
      const authDatabase = database.prepare('PRAGMA quick_check').get().quick_check;
      const mockServices = providers.health();
      const tasks = worker.health();
      const openFailures = database.prepare("SELECT count(*) AS n FROM operation_alerts WHERE resolved_at IS NULL AND kind<>'attention'").get().n;
      const healthy = authDatabase === 'ok' && mockServices.database === 'ok' && tasks.status === 'ok' && openFailures === 0 && logger.healthy();
      return json(res, healthy ? 200 : 503, { app: 'delta-companion', status: healthy ? 'ok' : 'degraded', environment, ...(environment === 'staging' ? {} : { pid: process.pid, port }),
        automation: { status: healthy ? 'ok' : 'degraded' },
        database: { engine: 'sqlite', auth: authDatabase, mocks: mockServices.database },
        providers: { payment: 'mock', ai: 'mock', sms: 'mock', storage: 'local', notification: 'mock', email: 'private-mock-inbox' },
      });
    }
    if (pathname === '/api/me') {
      const session = await getSession(req, res);
      if (!session) return json(res, 401, { message: '请先登录。' });
      return json(res, 200, { user: userView(session.user), expiresAt: session.session.expiresAt });
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { message: '该业务尚未开放。' });
    const filename = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(dist + path.sep) || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) return json(res, 404, { message: '页面不存在。' });
    if (['account.html', 'admin.html'].some(name => filename === path.join(dist, name))) {
      res.setHeader('Cache-Control', 'no-store');
      const session = await getSession(req, res);
      if (!session) {
        res.writeHead(303, { Location: `/?login=1&returnTo=${encodeURIComponent('/' + path.basename(filename) + url.search)}` });
        return res.end();
      }
      if (filename === path.join(dist, 'admin.html') && session.user.role !== 'admin') return json(res, 403, { message: '需要管理员权限。' });
      if (filename === path.join(dist, 'admin.html')) {
        try { security.assertAdmin(session); }
        catch (error) {
          if (!(error instanceof BusinessError) || error.status !== 428) throw error;
          res.writeHead(303, { Location: '/account.html?security=1&returnTo=%2Fadmin.html' }); return res.end();
        }
      }
    }
    const info = await stat(filename);
    if (!info.isFile()) return json(res, 404, { message: '页面不存在。' });
    // Only bundled public artwork may be revalidated; uploads and API routes above remain private.
    const publicArtwork = ['GET', 'HEAD'].includes(req.method) && pathname.startsWith('/assets/original/') && /\.(webp|png|jpe?g|svg)$/.test(pathname);
    const headers = { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (publicArtwork) {
      const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
      headers['Cache-Control'] = 'public, max-age=0, must-revalidate';
      headers.ETag = etag;
      const candidates = String(req.headers['if-none-match'] || '').split(',').map(value => value.trim());
      if (candidates.some(value => value === '*' || value.replace(/^W\//, '') === etag.slice(2))) {
        res.writeHead(304, headers);
        return res.end();
      }
    }
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(filename);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    if (error instanceof BusinessError) return json(res, error.status, { message: error.message });
    if (error.code === 'ENOENT') return json(res, 404, { message: '页面不存在。' });
    logger({ event: 'request_error', requestId, orderId, code: safeErrorCode(error) });
    if (!res.headersSent) json(res, 500, { message: '服务暂时不可用，请稍后重试。' });
    else res.destroy();
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1000;
server.on('error', async error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请先运行本地检查，或关闭原项目进程后重试。` : `本地启动失败：${error.code || error.name}`);
  await worker.stop(); await market.waitForIdle(); providers.close(); database.close(); await releaseDataLock(); process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`三角洲用户系统已启动：${baseURL}`));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  const stoppedWorker = worker.stop();
  server.close(async () => { await stoppedWorker; await market.waitForIdle(); providers.close(); database.close(); await releaseDataLock(); process.exit(0); });
  server.closeIdleConnections();
});


