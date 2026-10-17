import {isProvider} from '../dist/order-participants.mjs';
import { migrate } from './migrations.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { BusinessError } from './market.mjs';

export const FILE_LIMIT = 5 * 1024 * 1024;
export const CASE_LIMIT = 20 * 1024 * 1024;
export const FILE_COUNT = 10;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (ok, message, status = 400) => { if (!ok) throw new BusinessError(message, status); };

// Content signatures complement extension checks; they do not prove authenticity or replace malware scanning.
export function fileType(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0 && width * height <= 25_000_000) return ['image/png', ['png']];
  }
  if (bytes.length >= 4 && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) && bytes.subarray(-2).equals(Buffer.from('ffd9', 'hex'))) return ['image/jpeg', ['jpg', 'jpeg']];
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8) {
    if (bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return ['image/webp', ['webp']];
    if (bytes.length >= 44 && bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.toString('ascii', 12, 16) === 'fmt ') return ['audio/wav', ['wav']];
  }
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'ID3' && [2, 3, 4].includes(bytes[3]) && bytes.subarray(6, 10).every(b => b < 128)) return ['audio/mpeg', ['mp3']];
  if (bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 224) === 224 && (bytes[1] & 24) !== 8 && (bytes[1] & 6) !== 0 && (bytes[2] & 240) !== 0 && (bytes[2] & 240) !== 240 && (bytes[2] & 12) !== 12) return ['audio/mpeg', ['mp3']];
  return null;
}

export function createEvidence(database, market, storage) {
  migrate(database, '002-evidence-baseline', `CREATE TABLE IF NOT EXISTS evidence_files (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), case_id TEXT NOT NULL,
    uploader_id TEXT NOT NULL REFERENCES user(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(uploader_id,request_id));
    CREATE INDEX IF NOT EXISTS evidence_by_case ON evidence_files(order_id,case_id,created_at);`);
  function access(user, orderId, caseId, upload = false) {
    const order = market.readOrder(orderId, user);
    const c = [order.case, ...(order.cases || [])].find(c => c?.id === caseId);
    requireThat(c, '售后不存在或无权查看。', 404);
    if (upload) requireThat(!order.readOnly && (user.id===order.buyerId||isProvider(order,user.id)) && order.case?.id === caseId && ['human', 'appeal'].includes(c.stage), '方案确认期间请先提出异议再补交；已处理售后与历史交接记录只供查看。', 409);
    return order;
  }
  function quota(orderId, caseId, bytes, userId) {
    const row = database.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM evidence_files WHERE order_id=? AND case_id=?').get(orderId, caseId);
    requireThat(row.count < FILE_COUNT && row.bytes + bytes <= CASE_LIMIT, '本次售后最多10个附件，总大小不超过20MB。', 413);
    const own = database.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM evidence_files WHERE order_id=? AND case_id=? AND uploader_id=?').get(orderId, caseId, userId);
    requireThat(own.count < FILE_COUNT / 2 && own.bytes + bytes <= CASE_LIMIT / 2, '每方最多5个附件、共10MB，为另一方保留补交空间。', 413);
  }
  const dto = row => ({ id: row.id, orderId: row.order_id, caseId: row.case_id, name: row.name, mime: row.mime, bytes: row.bytes, sha256: row.sha256, summary: row.summary, createdAt: row.created_at,
    uploader: database.prepare('SELECT name FROM user WHERE id=?').get(row.uploader_id)?.name || '订单参与者', url: `/api/attachments/${row.id}` });
  async function upload(user, orderId, caseId, { name, summary = '', requestId, mime = 'application/octet-stream', content }) {
    const initialOrder = access(user, orderId, caseId, true);
    requireThat(typeof name === 'string' && name.length > 0 && name.length <= 160 && !/[\x00-\x1f\x7f/\\:<>"|?*]/.test(name) && !name.startsWith('.'), '文件名无效。');
    requireThat(typeof summary === 'string' && summary.length <= 300, '附件说明最多300字。');
    requireThat(typeof requestId === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(requestId), '上传请求标识无效。');
    requireThat(content instanceof Uint8Array && content.length > 0 && content.length <= FILE_LIMIT, '每个附件需为非空文件，且不超过5MB。', 413);
    const bytes = Buffer.from(content), type = fileType(bytes), extension = name.split('.').pop().toLowerCase();
    requireThat(type && type[1].includes(extension), '仅支持PNG、JPG、WEBP图片和MP3、WAV音频，文件内容须与后缀一致。', 415);
    const aliases = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/mp3': 'audio/mpeg' };
    requireThat(mime === 'application/octet-stream' || (aliases[mime] || mime) === type[0], '文件类型与内容不一致。', 415);
    const sha256 = hash(bytes), fingerprint = hash(JSON.stringify({ orderId, caseId, name, summary, sha256 }));
    const previous = database.prepare('SELECT * FROM evidence_files WHERE uploader_id=? AND request_id=?').get(user.id, requestId);
    if (previous) { requireThat(previous.fingerprint === fingerprint, '重复上传参数不一致。', 409); return { ...dto(previous), orderVersion: initialOrder.version }; }
    quota(orderId, caseId, bytes.length, user.id);
    const key = `evidence-${hash(user.id + ':' + requestId)}.${extension}`;
    try { await storage.put({ key, content: bytes, requestId: `evidence-${hash(user.id + ':' + requestId)}` }); }
    catch (error) { if (error.code === 'IDEMPOTENCY_CONFLICT') throw new BusinessError('重复上传参数不一致。', 409); throw error; }
    // Recheck after the asynchronous storage boundary; the case could have closed or the provider changed.
    access(user, orderId, caseId, true);
    return market.recordEvidence(user, orderId, caseId, () => {
      const raced = database.prepare('SELECT * FROM evidence_files WHERE uploader_id=? AND request_id=?').get(user.id, requestId);
      if (raced) { requireThat(raced.fingerprint === fingerprint, '重复上传参数不一致。', 409); return { file: dto(raced), created: false }; }
      quota(orderId, caseId, bytes.length, user.id);
      const id = randomUUID(), createdAt = Date.now();
      database.prepare('INSERT INTO evidence_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, orderId, caseId, user.id, requestId, fingerprint, key, name, type[0], bytes.length, sha256, summary, createdAt);
      return { file: dto(database.prepare('SELECT * FROM evidence_files WHERE id=?').get(id)), created: true };
    });
    // ponytail: storage and metadata are separate resources; interrupted writes can leave private orphan files. Retention/reconciliation before public production.
  }
  function list(user, orderId, caseId) {
    const order = access(user, orderId, caseId);
    return database.prepare('SELECT * FROM evidence_files WHERE order_id=? AND case_id=? ORDER BY created_at,id').all(orderId, caseId).filter(row => !order.readOnly || row.uploader_id === user.id).map(dto);
  }
  async function download(user, id) {
    const row = database.prepare('SELECT * FROM evidence_files WHERE id=?').get(id);
    requireThat(row, '附件不存在或无权查看。', 404);
    const order = access(user, row.order_id, row.case_id);
    requireThat(!order.readOnly || row.uploader_id === user.id, '附件不存在或无权查看。', 404);
    const content = await storage.get(row.storage_key);
    const latestOrder = access(user, row.order_id, row.case_id);
    requireThat(!latestOrder.readOnly || row.uploader_id === user.id, '附件不存在或无权查看。', 404);
    requireThat(content && content.length === row.bytes && hash(content) === row.sha256, '附件缺失或完整性校验失败，请联系平台处理。', 409);
    database.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES (?,?,?,?,?)').run(user.id, row.order_id, 'evidence_viewed', `授权访问附件：${row.id}`, Date.now());
    return { ...dto(row), content };
  }
  return { access, upload, list, download };
}
