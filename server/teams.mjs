import { createHash, randomUUID } from 'node:crypto';
import { migrate } from './migrations.mjs';
import { BusinessError } from './market.mjs';
import { recruitment } from '../dist/teams-model.mjs';
import {teamChannel} from './team-profiles.mjs';

const assert = (ok, message, status = 409) => { if (!ok) throw new BusinessError(message, status); };
const text = (value, min, max) => {
  assert(typeof value === 'string' && value.trim().length >= min && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value), `内容须为${min}—${max}字。`, 400);
  return value.trim();
};
const reportKinds = ['广告招募 / 引流', '骚扰 / 辱骂', '恶意或欺诈信息', '其他不当内容'];
const againOptions = ['愿意再次组队', '暂不确定', '节奏不合适'];
const communicationOptions = ['沟通友好、配合顺畅', '配合一般', '需要改善'];
const reliableOptions = ['按约上线', '提前沟通过调整', '未按约上线'];

export function createTeams(db, { now = Date.now, persona = () => null } = {}) {
  migrate(db, '004-free-teams', `
    CREATE TABLE team_rooms(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES user(id),status TEXT NOT NULL CHECK(status IN ('open','ended')),payload TEXT NOT NULL,created_at INTEGER NOT NULL,ended_at INTEGER,version INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX team_room_board ON team_rooms(status,created_at,id);
    CREATE INDEX team_room_owner ON team_rooms(owner_id,status);
    CREATE TABLE team_members(room_id TEXT NOT NULL REFERENCES team_rooms(id),user_id TEXT NOT NULL REFERENCES user(id),state TEXT NOT NULL CHECK(state IN ('requested','confirmed','ended','left','withdrawn','rejected')),note TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(room_id,user_id));
    CREATE INDEX team_member_user ON team_members(user_id,updated_at);
    CREATE TABLE team_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT NOT NULL REFERENCES team_rooms(id),user_id TEXT NOT NULL REFERENCES user(id),content TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX team_message_room ON team_messages(room_id,id);
    CREATE TABLE team_feedback(room_id TEXT NOT NULL REFERENCES team_rooms(id),actor_id TEXT NOT NULL REFERENCES user(id),target_id TEXT NOT NULL REFERENCES user(id),payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(room_id,actor_id,target_id));
    CREATE INDEX team_feedback_target ON team_feedback(target_id);
    CREATE TABLE team_reports(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES team_rooms(id),actor_id TEXT NOT NULL REFERENCES user(id),target_id TEXT NOT NULL REFERENCES user(id),kind TEXT NOT NULL,reason TEXT NOT NULL,snapshot TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','verified','dismissed')),decision_reason TEXT NOT NULL DEFAULT '',reviewer_id TEXT REFERENCES user(id),created_at INTEGER NOT NULL,reviewed_at INTEGER,UNIQUE(room_id,actor_id,target_id));
    CREATE TABLE team_restrictions(user_id TEXT PRIMARY KEY REFERENCES user(id),report_id TEXT NOT NULL REFERENCES team_reports(id),reason TEXT NOT NULL,recovery TEXT NOT NULL,expires_at INTEGER NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE team_appeals(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES user(id),report_id TEXT NOT NULL REFERENCES team_reports(id),reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),decision_reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,reviewed_at INTEGER);
    CREATE UNIQUE INDEX team_one_pending_appeal ON team_appeals(user_id,report_id) WHERE status='pending';
    CREATE TABLE team_blocks(user_id TEXT NOT NULL REFERENCES user(id),room_id TEXT NOT NULL REFERENCES team_rooms(id),created_at INTEGER NOT NULL,PRIMARY KEY(user_id,room_id));
    CREATE TABLE team_requests(user_id TEXT NOT NULL REFERENCES user(id),request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,request_id));
  `);
  migrate(db, '008-team-history', `
    CREATE TABLE team_history_hidden(user_id TEXT NOT NULL REFERENCES user(id),room_id TEXT NOT NULL REFERENCES team_rooms(id),member_updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,room_id));
  `);
  const audit = (actor, target, action, reason) => db.prepare('INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES (?,?,?,?,?)').run(actor, target, 'team_' + action, reason, now());
  const load = (id,channel) => {
    const row = db.prepare('SELECT * FROM team_rooms WHERE id=?').get(id);
    assert(row && (channel===undefined||(JSON.parse(row.payload).channel||'pc')===teamChannel(channel)), '当前平台招募不存在。', 404); return row;
  };
  const membership = (id, userId) => db.prepare('SELECT * FROM team_members WHERE room_id=? AND user_id=?').get(id, userId);
  const restriction = userId => {
    const row = db.prepare('SELECT * FROM team_restrictions WHERE user_id=? AND active=1 AND expires_at>?').get(userId, now());
    return row ? { reason: row.reason, recovery: row.recovery, expiresAt: row.expires_at, reportId: row.report_id } : null;
  };
  const canJoin = userId => assert(!restriction(userId), '组队功能暂受限，可查看原因并申诉。', 403);
  const reputation = (userId,channel='pc') => {
    teamChannel(channel);
    const row = db.prepare("SELECT count(*) AS samples,coalesce(sum(json_extract(f.payload,'$.again')='愿意再次组队'),0) AS again FROM team_feedback f JOIN team_rooms r ON r.id=f.room_id WHERE f.target_id=? AND coalesce(json_extract(r.payload,'$.channel'),'pc')=?").get(userId,channel);
    return { kind: restriction(userId) ? 'restricted' : row.samples ? 'feedback' : 'new', ...row };
  };
  const publicRoom = row => {
    const {gameId, ...payload} = JSON.parse(row.payload);
    const count = db.prepare("SELECT count(*) AS n FROM team_members WHERE room_id=? AND state='confirmed'").get(row.id).n;
    const channel=JSON.parse(row.payload).channel||'pc';
    const personal=persona(row.owner_id,channel);
    // Public images resolve through this recruitment, never expose the account ID.
    const appearance=personal?{...personal,avatarUrl:personal.avatarUrl?`/api/team-persona-images/${row.id}?type=avatar&v=${personal.version}`:null,backgroundUrl:personal.backgroundUrl?`/api/team-persona-images/${row.id}?type=background&v=${personal.version}`:null}:null;
    return { ...payload,channel, id: row.id, spaceRoom:channel==='pc'?row.id:null, appearance, host: db.prepare('SELECT name FROM user WHERE id=?').get(row.owner_id)?.name || '队友', status: row.status, need: row.status === 'open' ? Math.max(0, payload.need + 1 - count) : 0, capacity: payload.need + 1, createdAt: row.created_at, version: row.version, live: true, reputation: reputation(row.owner_id,channel) };
  };
  function board({ before, mode, style, mic, q = '',channel='pc' } = {}, user) {
    teamChannel(channel);
    assert(typeof q === 'string' && q.length <= 40, '关键词最多40字。', 400);
    if (before) assert(/^\d+:[a-zA-Z0-9-]+$/.test(before) && Number.isSafeInteger(Number(before.split(':')[0])), '分页标识无效。', 400);
    const cutoff = before ? before.split(':') : [Number.MAX_SAFE_INTEGER, ''];
    // Bounded SQL search, not an unbounded browser dump. '%' and '_' are literal search characters.
    const search = '%' + q.trim().replace(/[\\%_]/g, '\\$&') + '%';
    const rows = db.prepare(`SELECT r.* FROM team_rooms r JOIN user u ON u.id=r.owner_id
      WHERE r.status='open' AND coalesce(json_extract(r.payload,'$.channel'),'pc')=? AND (r.created_at<? OR (r.created_at=? AND r.id<?))
      AND NOT EXISTS(SELECT 1 FROM team_blocks b WHERE b.user_id=? AND b.room_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM team_restrictions x WHERE x.user_id=r.owner_id AND x.active=1 AND x.expires_at>?)
      AND (? IS NULL OR json_extract(r.payload,'$.mode')=? OR json_extract(r.payload,'$.mode')='不限') AND (? IS NULL OR json_extract(r.payload,'$.style')=?) AND (? IS NULL OR json_extract(r.payload,'$.mic')=? OR json_extract(r.payload,'$.mic')='text')
      AND (json_extract(r.payload,'$.title') LIKE ? ESCAPE '\\' OR json_extract(r.payload,'$.intro') LIKE ? ESCAPE '\\' OR json_extract(r.payload,'$.tags') LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')
      ORDER BY r.created_at DESC,r.id DESC LIMIT 41`).all(channel,Number(cutoff[0]), Number(cutoff[0]), cutoff[1], user?.id || '', now(), mode && mode !== 'all' ? mode : null, mode && mode !== 'all' ? mode : null, style && style !== 'all' ? style : null, style && style !== 'all' ? style : null, mic && mic !== 'all' ? mic : null, mic && mic !== 'all' ? mic : null, search, search, search, search);
    const page = rows.slice(0, 40), last = page.at(-1);
    return { rooms: page.map(publicRoom), next: rows.length > 40 ? `${last.created_at}:${last.id}` : null };
  }
  function read(id, user,channel='pc') {
    const row = load(id,channel), m = user ? membership(id, user.id) : null;
    const member = m ? { state: m.state, note: m.note, own: row.owner_id === user.id } : null;
    const isMember = m && ['confirmed', 'ended'].includes(m.state);
    const memberList = (isMember || m?.state === 'left') ? db.prepare("SELECT m.user_id AS id,u.name,m.state FROM team_members m JOIN user u ON u.id=m.user_id WHERE room_id=? AND state IN ('confirmed','ended','left') ORDER BY m.created_at,u.id").all(id) : [];
    return { room: publicRoom(row), gameId: isMember ? (JSON.parse(row.payload).gameId || '') : '', membership: member, members: memberList,
      applicants: user?.id === row.owner_id ? db.prepare("SELECT m.user_id AS id,u.name,m.note,m.created_at AS createdAt FROM team_members m JOIN user u ON u.id=m.user_id WHERE room_id=? AND state='requested' ORDER BY m.created_at,u.id LIMIT 30").all(id) : [],
      feedbackTargets: isMember && row.status === 'ended' ? memberList.filter(other => other.id !== user.id && other.state === 'ended').map(other => ({ ...other, submitted: !!db.prepare('SELECT 1 FROM team_feedback WHERE room_id=? AND actor_id=? AND target_id=?').get(id, user.id, other.id) })) : [],
      reported: !!(user && db.prepare('SELECT 1 FROM team_reports WHERE room_id=? AND actor_id=? AND target_id=?').get(id, user.id, row.owner_id)) };
  }
  function mine(user,channel='pc') {
    teamChannel(channel);
    return { user: { id: user.id, name: user.name }, reputation: reputation(user.id,channel), restriction: restriction(user.id),
      blocks: db.prepare("SELECT b.room_id AS id,json_extract(r.payload,'$.title') AS title FROM team_blocks b JOIN team_rooms r ON r.id=b.room_id WHERE b.user_id=? AND coalesce(json_extract(r.payload,'$.channel'),'pc')=? ORDER BY b.created_at DESC LIMIT 100").all(user.id,channel),
      teams: db.prepare(`SELECT r.* FROM team_members m JOIN team_rooms r ON r.id=m.room_id
        WHERE m.user_id=? AND coalesce(json_extract(r.payload,'$.channel'),'pc')=? AND NOT EXISTS (SELECT 1 FROM team_history_hidden h WHERE h.user_id=m.user_id AND h.room_id=m.room_id AND h.member_updated_at=m.updated_at AND (r.status='ended' OR m.state IN ('ended','left','withdrawn','rejected')))
        ORDER BY m.updated_at DESC,r.id DESC LIMIT 100`).all(user.id,channel).map(row => read(row.id, user,channel)),
      appeals: db.prepare("SELECT a.id,a.status,a.reason,a.decision_reason AS decisionReason,a.created_at AS createdAt FROM team_appeals a JOIN team_reports p ON p.id=a.report_id JOIN team_rooms r ON r.id=p.room_id WHERE a.user_id=? AND coalesce(json_extract(r.payload,'$.channel'),'pc')=? ORDER BY a.created_at DESC LIMIT 20").all(user.id,channel) };
  }
  function messages(id, user, { after = '0', before,channel='pc' } = {}) {
    const row = load(id,channel), m = membership(id, user.id);
    assert(m && ['confirmed', 'ended'].includes(m.state), '仅已确认的小队成员可以查看消息。', 403);
    const cursor = before ?? after;
    assert(/^\d{1,16}$/.test(String(cursor)) && Number.isSafeInteger(Number(cursor)), '消息分页标识无效。', 400);
    const direction = before != null ? '<' : '>';
    const page = db.prepare(`SELECT m.id,m.user_id AS userId,u.name AS who,m.content AS text,m.created_at AS createdAt FROM team_messages m JOIN user u ON u.id=m.user_id WHERE room_id=? AND m.id${direction}? ORDER BY m.id ${before != null ? 'DESC' : 'ASC'} LIMIT 101`).all(id, Number(cursor));
    const result = page.slice(0, 100);
    return { messages: before != null ? result.reverse() : result, more: page.length > 100, writable: row.status === 'open' && m.state === 'confirmed' && !restriction(user.id) };
  }
  function adminData(user) {
    assert(user.role === 'admin', '需要管理员权限。', 403);
    return { reports: db.prepare('SELECT id,room_id AS roomId,actor_id AS actorId,target_id AS targetId,kind,reason,status,decision_reason AS decisionReason,snapshot,created_at AS createdAt FROM team_reports ORDER BY created_at DESC LIMIT 100').all().map(r => ({ ...r, snapshot: JSON.parse(r.snapshot) })),
      restrictions: db.prepare('SELECT * FROM team_restrictions ORDER BY updated_at DESC LIMIT 100').all(),
      appeals: db.prepare('SELECT * FROM team_appeals ORDER BY created_at DESC LIMIT 100').all() };
  }
  function execute(user, scope, body,channel='pc') {
    if (scope === 'history-clear') {
      const result = db.prepare(`INSERT INTO team_history_hidden(user_id,room_id,member_updated_at)
        SELECT m.user_id,m.room_id,m.updated_at FROM team_members m JOIN team_rooms r ON r.id=m.room_id
        WHERE m.user_id=? AND coalesce(json_extract(r.payload,'$.channel'),'pc')=? AND (r.status='ended' OR m.state IN ('ended','left','withdrawn','rejected'))
        ON CONFLICT(user_id,room_id) DO UPDATE SET member_updated_at=excluded.member_updated_at`).run(user.id,channel);
      audit(user.id, user.id, 'history_cleared', '清除本人历史展示，保留组队与举报依据'); return { cleared: Number(result.changes) };
    }
    if (scope === 'publish') {
      canJoin(user.id); assert(body.agree === true, '请先确认免费组队说明。', 400);
      assert(!body.voice, '语音上传尚未开放，请使用文字发布。', 400);
      assert(db.prepare("SELECT count(*) AS n FROM team_rooms WHERE owner_id=? AND status='open'").get(user.id).n < 10, '同时开放的招募已达10条，请先结束旧招募。', 429);
      const fields = ['title', 'intro', 'when', 'mode', 'style', 'mic', 'tags', 'selfTags', 'gameId'];
      for (const field of fields) assert(body[field] == null || typeof body[field] === 'string', '招募参数格式无效。', 400);
      assert(['string','number'].includes(typeof body.need), '人数参数格式无效。', 400);
      let payload; try { payload = {...recruitment(body),channel}; } catch (error) { throw new BusinessError(error.message, 400); }
      const id = randomUUID(), time = now();
      db.prepare("INSERT INTO team_rooms VALUES (?,?,'open',?,?,NULL,0)").run(id, user.id, JSON.stringify(payload), time);
      db.prepare("INSERT INTO team_members VALUES (?,?,'confirmed','',?,?)").run(id, user.id, time, time);
      audit(user.id, id, 'published', '发布免费招募'); return { roomId: id };
    }
    if (scope === 'appeal') {
      const r = restriction(user.id); assert(r, '当前没有可申诉的组队限制。');
      assert(!db.prepare("SELECT 1 FROM team_appeals WHERE user_id=? AND report_id=? AND status='pending'").get(user.id, r.reportId), '已有待复核申诉，请勿重复提交。');
      const id = randomUUID(); db.prepare("INSERT INTO team_appeals VALUES (?,?,?,?,'pending','',?,NULL)").run(id, user.id, r.reportId, text(body.reason, 5, 300), now());
      audit(user.id, id, 'appealed', '提交组队限制申诉'); return { appealId: id, status: 'pending' };
    }
    if (scope.startsWith('admin:')) {
      assert(user.role === 'admin', '需要管理员权限。', 403);
      const reason = text(body.reason, 10, 300);
      if (scope === 'admin:review') {
        const report = db.prepare('SELECT * FROM team_reports WHERE id=?').get(text(body.id, 1, 80));
        assert(report, '举报不存在。', 404); const room = load(report.room_id);
        assert(![report.actor_id, report.target_id, room.owner_id].includes(user.id) && !membership(room.id, user.id), '不能处理本人参与的组队事件。', 403);
        assert(report.status === 'pending', '举报已处理。'); assert(['verified', 'dismissed'].includes(body.status), '请选择核实结果。', 400);
        db.prepare('UPDATE team_reports SET status=?,decision_reason=?,reviewer_id=?,reviewed_at=? WHERE id=?').run(body.status, reason, user.id, now(), report.id);
        audit(user.id, report.id, 'report_reviewed', reason); return { reportId: report.id };
      }
      if (scope === 'admin:restrict') {
        const report = db.prepare("SELECT * FROM team_reports WHERE id=? AND status='verified'").get(text(body.reportId, 1, 80));
        assert(report, '限制必须引用已核实的违规事件。'); const room = load(report.room_id);
        assert(![report.actor_id, report.target_id, room.owner_id].includes(user.id) && !membership(room.id, user.id), '不能限制本人参与事件的用户。', 403);
        const expiry = body.expiresAt; assert(Number.isSafeInteger(expiry) && expiry > now() && expiry <= now() + 90 * 86400_000, '请设置未来90天以内的明确期限。', 400);
        const recovery = text(body.recovery, 10, 300);
        db.prepare('INSERT INTO team_restrictions VALUES (?,?,?,?,?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET report_id=excluded.report_id,reason=excluded.reason,recovery=excluded.recovery,expires_at=excluded.expires_at,active=1,updated_at=excluded.updated_at').run(report.target_id, report.id, reason, recovery, expiry, now(), now());
        audit(user.id, report.target_id, 'restricted', reason); return { userId: report.target_id };
      }
      if (scope === 'admin:restore' || scope === 'admin:appeal') {
        const appeal = scope === 'admin:appeal' ? db.prepare('SELECT * FROM team_appeals WHERE id=?').get(text(body.id, 1, 80)) : null;
        if (scope === 'admin:appeal') assert(appeal?.status === 'pending', '申诉不存在或已处理。');
        const userId = appeal ? appeal.user_id : text(body.userId, 1, 128);
        const r = db.prepare('SELECT * FROM team_restrictions WHERE user_id=?').get(userId); assert(r, '限制记录不存在。', 404);
        const source = db.prepare('SELECT * FROM team_reports WHERE id=?').get(appeal?.report_id || r.report_id);
        assert(source && ![source.actor_id, source.target_id, load(source.room_id).owner_id].includes(user.id) && !membership(source.room_id, user.id), '不能处理本人相关的申诉。', 403);
        if (appeal) { assert(['accepted', 'rejected'].includes(body.status), '申诉结果无效。', 400); db.prepare('UPDATE team_appeals SET status=?,decision_reason=?,reviewed_at=? WHERE id=?').run(body.status, reason, now(), appeal.id); }
        if (!appeal || body.status === 'accepted') {
          assert(!appeal || r.report_id === appeal.report_id, '当前限制已更新，不能用旧申诉解除新限制。');
          db.prepare('UPDATE team_restrictions SET active=0,updated_at=? WHERE user_id=?').run(now(), userId);
        }
        audit(user.id, userId, 'restriction_reviewed', reason); return { userId };
      }
      throw new BusinessError('此管理操作尚未开放。', 404);
    }
    const [id, action] = scope.split(':'); const row = load(id,channel), m = membership(id, user.id);
    if (action === 'dismiss') {
      assert(m, '只能清除本人组队记录。', 403);
      assert(row.status === 'ended' || ['ended','left','withdrawn','rejected'].includes(m.state), '请先结束组队或退出，当前小队不能清除。');
      db.prepare('INSERT INTO team_history_hidden VALUES (?,?,?) ON CONFLICT(user_id,room_id) DO UPDATE SET member_updated_at=excluded.member_updated_at').run(user.id,id,m.updated_at);
      audit(user.id,id,'history_dismissed','清除本人历史展示，保留组队与举报依据'); return { roomId:id };
    }
    if (action === 'block' || action === 'unblock') {
      if (action === 'block') db.prepare('INSERT OR IGNORE INTO team_blocks VALUES (?,?,?)').run(user.id, id, now());
      else db.prepare('DELETE FROM team_blocks WHERE user_id=? AND room_id=?').run(user.id, id);
      audit(user.id, id, action, '本人招募屏蔽设置'); return { roomId: id };
    }
    if (action === 'report') {
      const target = body.targetId == null ? row.owner_id : text(body.targetId, 1, 128);
      assert(target !== user.id, '不能举报自己。', 400);
      assert(target === row.owner_id || (m && ['confirmed', 'ended', 'left'].includes(m.state) && ['confirmed', 'ended', 'left'].includes(membership(id, target)?.state)), '举报对象不属于本次组队。', 400);
      assert(reportKinds.includes(body.kind), '举报类型无效。', 400);
      const previous = db.prepare('SELECT id FROM team_reports WHERE room_id=? AND actor_id=? AND target_id=?').get(id, user.id, target);
      assert(!previous, '本次组队已举报此用户，请勿重复提交。');
      const reportId = randomUUID(), snapshot = { room: publicRoom(row), messages: m && ['confirmed', 'ended'].includes(m.state) ? db.prepare('SELECT user_id AS userId,content AS text,created_at AS createdAt FROM team_messages WHERE room_id=? ORDER BY id DESC LIMIT 20').all(id).reverse() : [] };
      db.prepare("INSERT INTO team_reports VALUES (?,?,?,?,?,?,?,'pending','',NULL,?,NULL)").run(reportId, id, user.id, target, body.kind, text(body.reason, 5, 300), JSON.stringify(snapshot), now());
      audit(user.id, reportId, 'reported', '提交待核实举报，不自动处罚'); return { reportId, status: 'pending', roomId: id };
    }
    if (action === 'feedback') {
      assert(row.status === 'ended' && m?.state === 'ended', '本次组队结束后，实际成员才能反馈。');
      const target = membership(id, text(body.targetId, 1, 128)); assert(target?.state === 'ended' && target.user_id !== user.id, '请选择本次实际队友。', 400);
      assert(againOptions.includes(body.again) && communicationOptions.includes(body.communication) && reliableOptions.includes(body.reliable), '反馈选项无效。', 400);
      assert(!db.prepare('SELECT 1 FROM team_feedback WHERE room_id=? AND actor_id=? AND target_id=?').get(id, user.id, target.user_id), '已经反馈过本次队友。');
      db.prepare('INSERT INTO team_feedback VALUES (?,?,?,?,?)').run(id, user.id, target.user_id, JSON.stringify({ again: body.again, communication: body.communication, reliable: body.reliable }), now());
      audit(user.id, id, 'feedback', '记录实际组队反馈，不自动处罚'); return { roomId: id };
    }
    assert(row.status === 'open', '本次组队已结束。');
    if (action === 'join') {
      canJoin(user.id); canJoin(row.owner_id); assert(user.id !== row.owner_id, '不能申请自己的招募。');
      assert(!m || ['withdrawn', 'rejected', 'left'].includes(m.state), '已申请或已加入本次组队。');
      assert(publicRoom(row).need > 0, '当前小队已满。');
      assert(db.prepare("SELECT count(*) AS n FROM team_members WHERE user_id=? AND state='requested'").get(user.id).n < 20, '待确认申请过多，请先撤回旧申请。', 429);
      assert(db.prepare("SELECT count(*) AS n FROM team_members WHERE room_id=? AND state='requested'").get(id).n < 30, '此招募待确认申请已满，请选择其他小队。', 429);
      db.prepare("INSERT INTO team_members VALUES (?,?,'requested',?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET state='requested',note=excluded.note,updated_at=excluded.updated_at").run(id, user.id, text(body.note ?? '', 0, 120), now(), now());
      db.prepare('DELETE FROM team_history_hidden WHERE user_id=? AND room_id=?').run(user.id,id);
    } else if (action === 'accept' || action === 'reject') {
      assert(row.owner_id === user.id, '只有房主可以处理申请。', 403);
      const target = membership(id, text(body.userId, 1, 128)); assert(target?.state === 'requested', '申请已更新，请刷新。');
      if (action === 'accept') { canJoin(user.id); canJoin(target.user_id); assert(publicRoom(row).need > 0, '当前小队已满。'); }
      db.prepare('UPDATE team_members SET state=?,updated_at=? WHERE room_id=? AND user_id=?').run(action === 'accept' ? 'confirmed' : 'rejected', now(), id, target.user_id);
    } else if (action === 'remove') {
      assert(row.owner_id === user.id, '只有房主可以移出成员。', 403);
      const target = membership(id, text(body.userId, 1, 128));
      assert(target?.state === 'confirmed' && target.user_id !== user.id, '请选择当前小队中的其他成员。');
      db.prepare("UPDATE team_members SET state='left',updated_at=? WHERE room_id=? AND user_id=?").run(now(), id, target.user_id);
    } else if (action === 'withdraw' || action === 'leave') {
      assert(user.id !== row.owner_id && m?.state === (action === 'withdraw' ? 'requested' : 'confirmed'), '当前状态不能撤回或退出。');
      db.prepare('UPDATE team_members SET state=?,updated_at=? WHERE room_id=? AND user_id=?').run(action === 'withdraw' ? 'withdrawn' : 'left', now(), id, user.id);
    } else if (action === 'end') {
      assert(row.owner_id === user.id, '只有房主可以结束组队；队友可以退出。', 403);
      db.prepare("UPDATE team_rooms SET status='ended',ended_at=? WHERE id=?").run(now(), id);
      db.prepare("UPDATE team_members SET state=CASE state WHEN 'confirmed' THEN 'ended' ELSE 'rejected' END,updated_at=? WHERE room_id=? AND state IN ('confirmed','requested')").run(now(), id);
    } else if (action === 'message') {
      assert(m?.state === 'confirmed', '仅已确认的小队成员可以发言。', 403); canJoin(user.id);
      assert(db.prepare('SELECT count(*) AS n FROM team_messages WHERE room_id=?').get(id).n < 5000, '本次小队消息已达保存上限，请结束后重新组队。', 429);
      const latest = db.prepare('SELECT created_at FROM team_messages WHERE room_id=? AND user_id=? ORDER BY id DESC LIMIT 1').get(id, user.id);
      assert(!latest || now() - latest.created_at >= 1000, '发送太快，请稍后再试。', 429);
      db.prepare('INSERT INTO team_messages(room_id,user_id,content,created_at) VALUES (?,?,?,?)').run(id, user.id, text(body.message, 1, 300), now());
    } else throw new BusinessError('此组队操作尚未开放。', 404);
    db.prepare('UPDATE team_rooms SET version=version+1 WHERE id=?').run(id);
    audit(user.id, id, action, '免费组队状态操作：' + action); return { roomId: id };
  }
  function command(user, scope, body,channel='pc') {
    teamChannel(channel);
    if (scope.startsWith('admin:')) assert(user.role === 'admin', '需要管理员权限。', 403);
    assert(typeof body.requestId === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(body.requestId), '请求标识无效。', 400);
    // Store only object references: a retry must not replay stale private messages or old privileges.
    const fingerprint = createHash('sha256').update(JSON.stringify(channel==='pc'?{scope,body}:{scope,body,channel})).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT * FROM team_requests WHERE user_id=? AND request_id=?').get(user.id, body.requestId);
      let result;
      if (previous) { assert(previous.fingerprint === fingerprint, '相同请求标识不能用于其他内容。'); result = JSON.parse(previous.result); }
      else { result = execute(user, scope, body,channel); db.prepare('INSERT INTO team_requests VALUES (?,?,?,?,?)').run(user.id, body.requestId, fingerprint, JSON.stringify(result), now()); }
      const response = { ...result, ...(result.roomId ? read(result.roomId, user,channel) : {}) };
      db.exec('COMMIT'); return response;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { board, read, mine, messages, command, adminData, reputation };
}
