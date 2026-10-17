import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import path from 'node:path';
import { PROJECT_ROOT, localConfig } from '../server/config.mjs';

const command = process.argv[2] || 'start';
let config;
async function health() {
  try {
    const origin = new URL(config.baseURL);
    return await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: config.port, path: '/api/health', signal: AbortSignal.timeout(2000), headers: {
      Host: origin.host,
      ...(config.trustedProxies.length ? { 'X-Forwarded-Host': origin.host, 'X-Forwarded-Proto': origin.protocol.slice(0, -1), 'X-Forwarded-For': '127.0.0.1' } : {}),
      ...(config.stagingAccessToken ? { 'X-Delta-Staging-Access': config.stagingAccessToken } : {}),
      } }, response => {
        let text = ''; response.on('error', reject);
        response.on('data', chunk => { text += chunk; if (text.length > 16384) request.destroy(new Error('健康响应过大。')); });
        response.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve(null); } });
      });
      request.on('error', reject);
    });
  } catch { /* A stopped local server is an expected state, not an external dependency failure. */ }
  return null;
}
async function run(args) {
  const env = { ...process.env, NODE_ENV: 'test', APP_ENV: 'test' };
  for (const key of ['PORT', 'BETTER_AUTH_URL', 'AUTH_DATA_DIR', 'BETTER_AUTH_SECRET', 'TRUSTED_PROXY_IPS', 'STAGING_ACCESS_TOKEN', 'ALLOW_STAGING_MOCKS', 'EXTERNAL_SERVICE_MODE', 'BACKUP_KEY_FILE', 'AUTH_KEY_REF', 'AUTH_REQUIRE_EMAIL_VERIFICATION', 'AUTH_PHONE_MODE']) delete env[key];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, stdio: 'inherit', env });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}
try {
  config = localConfig();
  if (command === 'start') {
    const current = await health();
    if (current?.app === 'delta-companion') console.log(`项目已启动：${config.baseURL}，不会重复启动。`);
    else await import('../server/index.mjs');
  } else if (command === 'check') {
    const problems = [];
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (nodeMajor < 24) problems.push('本地底座建议使用 Node 24 LTS 或更高版本。');
    try { import.meta.resolve('better-auth'); } catch { problems.push('缺少 better-auth，请按 package-lock.json 安装依赖。'); }
    if (!existsSync(path.join(PROJECT_ROOT, 'dist/index.html'))) problems.push('缺少当前前端页面。');
    const filename = path.join(config.dataDirectory, 'auth.sqlite');
    let databaseStatus = '尚未初始化，首次启动自动创建';
    if (existsSync(filename)) {
      const database = new DatabaseSync(filename, { readOnly: true });
      try {
        databaseStatus = database.prepare('PRAGMA quick_check').get().quick_check;
        if (databaseStatus !== 'ok') problems.push('数据库完整性检查未通过。');
      } finally { database.close(); }
    }
    const current = await health();
    if (current && (current.app !== 'delta-companion' || current.status !== 'ok')) problems.push('运行中的服务健康检查未通过。');
    console.log(JSON.stringify({ project: PROJECT_ROOT, node: process.version, database: databaseStatus, service: current || '未启动；运行 node scripts/dev.mjs start', problems }, null, 2));
    if (problems.length) process.exitCode = 1;
  } else if (command === 'seed') {
    const { seedLocalUsers, TEST_PASSWORD } = await import('./seed-local.mjs');
    console.log(JSON.stringify(await seedLocalUsers(config.dataDirectory), null, 2));
    console.log(`仅供本地测试的公开示例密码：${TEST_PASSWORD}`);
    console.log('重复执行保留已有账号，不重置密码、不删除其他数据。');
  } else if (command === 'test') {
    const files = readdirSync(path.join(PROJECT_ROOT, 'tests')).filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`);
    const result = await run(['--test', ...files]);
    const preview = await run(['tests/preview-smoke.mjs']);
    process.exitCode = result || preview;
  } else throw new Error('可用命令：start、check、seed、test。');
} catch (error) {
  console.error('本地开发操作失败：' + error.message);
  process.exitCode = 1;
}
