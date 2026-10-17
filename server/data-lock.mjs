import net from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

function canonical(target) {
  const resolved = existsSync(target) ? realpathSync(target) : path.join(canonical(path.dirname(target)), path.basename(target));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// OS lifetime, not a stale PID file. All supported writer CLIs acquire this same lock.
// This is a single-machine guard, not a distributed lock or a security boundary.
export async function acquireDataLock(directory) {
  const id = createHash('sha256').update(canonical(path.resolve(directory))).digest('hex').slice(0, 40);
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('数据目录互斥目前仅支持 Windows 和 Linux。');
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\delta-data-${id}` : `\0delta-data-${id}`;
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(new Error(error.code === 'EADDRINUSE' ? '数据目录正在使用；请先停止网站或其他写入工具。' : '无法取得数据目录互斥锁。')));
    server.listen({ path: endpoint, exclusive: true }, resolve);
  });
  server.unref();
  return async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); };
}
