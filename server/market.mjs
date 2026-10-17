import { migrate } from './migrations.mjs';
import { createPaymentJournal } from './payment-journal.mjs';
import { createOperations, boundedCall, retryDelay, safeErrorCode } from './operations.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { PRODUCTS, productArt } from '../dist/catalog.mjs';
import {
  providerIds,
  isProvider,
  providerCount,
  providerConfirmed,
  allProvidersConfirmed,
  lowKd,
} from '../dist/order-participants.mjs';
import { createPaidSquads } from './paid-squads.mjs';
import { aftercareChecks, aftercareGuide, aftercareMetricsFromDatabase } from './aftercare.mjs';
import { normalizeTags, matchFit } from '../dist/matching.mjs';

export class BusinessError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}
const requireThat = (ok, message, status) => {
  if (!ok) throw new BusinessError(message, status);
};
const text = (value, min = 1, max = 500) => {
  requireThat(
    typeof value === 'string' && value.trim().length >= min && value.length <= max,
    `请填写${min}—${max}字的有效内容。`,
    400
  );
  return value.trim();
};
const caseKinds = ['service', 'serious', 'zero', 'replace', 'time', 'complaint'];
const tags = (value) => {
  try {
    return normalizeTags(value);
  } catch (error) {
    throw new BusinessError(error.message, 400);
  }
};
const matchingFields = (body, previous = {}) => {
  const note = body.matchNote ?? previous.matchNote ?? '';
  requireThat(typeof note === 'string' && note.length <= 120, '派单备注最多120字。', 400);
  const trial = body.preferTrial ?? previous.preferTrial ?? false;
  requireThat(typeof trial === 'boolean', '试音偏好格式无效。', 400);
  return {
    desiredTags: tags(body.desiredTags ?? previous.desiredTags ?? []),
    matchNote: note.trim(),
    preferTrial: trial,
  };
};
export const serviceSeconds = (order, now = Date.now()) =>
  Math.min(
    order.duration,
    order.elapsed +
      (order.runningSince === null ? 0 : Math.max(0, Math.floor((now - order.runningSince) / 1000)))
  );

export function createMarket(
  database,
  providers,
  {
    now = Date.now,
    offerMs = 30_000,
    presenceMs = 90_000,
    attentionMs = 15 * 60_000,
    providerTimeoutMs = 10_000,
    paidOrdersEnabled = true,
  } = {}
) {
  if (typeof paidOrdersEnabled !== 'boolean') throw Error('付费发布配置必须为布尔值。');
  if (!Number.isSafeInteger(attentionMs) || attentionMs < 1000 || attentionMs > 7 * 86400_000)
    throw Error('提醒测试时限无效。');
  if (![offerMs, presenceMs].every((n) => Number.isSafeInteger(n) && n >= 1000 && n <= 600_000))
    throw new Error('派单测试时限须在1秒至10分钟之间。');
  if (
    !Number.isSafeInteger(providerTimeoutMs) ||
    providerTimeoutMs < 1 ||
    providerTimeoutMs > 30_000
  )
    throw Error('适配器超时参数无效。');
  migrate(
    database,
    '001-market-baseline',
    `
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_profiles (user_id TEXT PRIMARY KEY REFERENCES user(id), payload TEXT NOT NULL, suspended INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES user(id), provider_id TEXT REFERENCES user(id), status TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS orders_buyer ON orders(buyer_id,created_at);
    CREATE INDEX IF NOT EXISTS orders_provider ON orders(provider_id,created_at);
    CREATE TABLE IF NOT EXISTS released_services (order_id TEXT NOT NULL REFERENCES orders(id), user_id TEXT NOT NULL REFERENCES user(id), payload TEXT NOT NULL, PRIMARY KEY(order_id,user_id));
    CREATE UNIQUE INDEX IF NOT EXISTS one_provider_order ON orders(provider_id) WHERE status IN ('ready','active','finishing','confirming','aftercare');
    CREATE TABLE IF NOT EXISTS business_requests (user_id TEXT NOT NULL REFERENCES user(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id,request_id));
    CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, target_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_jobs (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), action TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS provider_presence (user_id TEXT PRIMARY KEY REFERENCES user(id), seen_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT PRIMARY KEY REFERENCES user(id), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dispatch_offers (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), user_id TEXT NOT NULL REFERENCES user(id), status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','expired','invalidated')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, reason TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_order_invitation ON dispatch_offers(order_id) WHERE status='pending';
    CREATE UNIQUE INDEX IF NOT EXISTS one_provider_invitation ON dispatch_offers(user_id) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS offer_history ON dispatch_offers(order_id,user_id,created_at);
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), order_id TEXT NOT NULL REFERENCES orders(id) DEFERRABLE INITIALLY DEFERRED, label TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
    CREATE INDEX IF NOT EXISTS notification_inbox ON notifications(user_id,created_at);
  `
  );
  const operations = createOperations(database, { now });
  const paymentJournal = createPaymentJournal(database, { now });
  for (const product of PRODUCTS)
    database
      .prepare('INSERT OR IGNORE INTO products VALUES (?,?)')
      .run(product.id, JSON.stringify(product));
  // Version the newly confirmed waiting-for-replacement exit; never rewrite old order snapshots or prices.
  database
    .prepare(
      "UPDATE products SET payload=json_set(payload,'$.ruleVersion','2026-10-01-preview') WHERE id IN ('secret','topsecret') AND json_extract(payload,'$.ruleVersion')='2026-09-30-preview'"
    )
    .run();
  const products = () =>
    database
      .prepare('SELECT payload FROM products ORDER BY id')
      .all()
      .map((row) => {
        const p = JSON.parse(row.payload);
        return { ...p, image: productArt(p.id) };
      });
  const preferences = (userId) =>
    JSON.parse(
      database.prepare('SELECT payload FROM user_preferences WHERE user_id=?').get(userId)
        ?.payload || '{"desiredTags":[],"matchNote":"","preferTrial":false}'
    );
  const log = (actor, target, action, reason) =>
    database
      .prepare(
        'INSERT INTO audit_events(actor_id,target_id,action,reason,created_at) VALUES (?,?,?,?,?)'
      )
      .run(actor, target, action, reason, now());
  const transaction = (operation) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
  const load = (id) => {
    const row = database.prepare('SELECT * FROM orders WHERE id=?').get(id);
    requireThat(row, '订单不存在或无权查看。', 404);
    return { ...JSON.parse(row.payload), version: row.version };
  };
  const save = (order) => {
    const before = database.prepare('SELECT status,payload FROM orders WHERE id=?').get(order.id);
    if (before.status !== order.status) order.stageSince = now();
    if (order.case && JSON.parse(before.payload).case?.stage !== order.case.stage)
      order.case.changedAt = now();
    const version = order.version;
    order.version++;
    const result = database
      .prepare(
        'UPDATE orders SET provider_id=?,status=?,payload=?,version=? WHERE id=? AND version=?'
      )
      .run(order.providerId, order.status, JSON.stringify(order), order.version, order.id, version);
    requireThat(result.changes === 1, '订单已更新，请刷新后重试。');
    database.prepare('DELETE FROM order_providers WHERE order_id=?').run(order.id);
    for (const id of providerIds(order))
      database
        .prepare('INSERT INTO order_providers VALUES(?,?,?)')
        .run(
          order.id,
          id,
          Number(['ready', 'active', 'finishing', 'confirming', 'aftercare'].includes(order.status))
        );
  };
  const event = (order, actor, action, reason) => {
    const actorRole = !actor
      ? 'system'
      : actor === order.buyerId
        ? 'buyer'
        : isProvider(order, actor) ||
            database
              .prepare('SELECT 1 FROM released_services WHERE order_id=? AND user_id=?')
              .get(order.id, actor)
          ? 'provider'
          : 'admin';
    const actorName =
      actorRole === 'buyer'
        ? order.customer
        : actorRole === 'provider'
          ? order.providers?.find((p) => p.id === actor)?.name ||
            (order.providerId === actor ? order.provider?.name : undefined)
          : undefined;
    order.events.push({
      label: reason,
      actorRole,
      ...(actorName ? { actorName } : {}),
      time: new Date(now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    });
    const record = log(actor, order.id, action, reason);
    for (const userId of new Set([order.buyerId, ...providerIds(order)].filter(Boolean)))
      notify(userId, order.id, reason, `event:${record.lastInsertRowid}:${userId}`);
  };
  const notify = (userId, orderId, label, id) => {
    const record = database
      .prepare('INSERT OR IGNORE INTO notifications VALUES (?,?,?,?,?,NULL)')
      .run(id, userId, orderId, label, now());
    if (record.changes) database.prepare('INSERT INTO notification_jobs(id) VALUES (?)').run(id);
    return record;
  };
  const participant = (order, user) => {
    requireThat(
      user.id === order.buyerId || isProvider(order, user.id) || user.role === 'admin',
      '订单不存在或无权查看。',
      404
    );
    return user.id === order.buyerId ? 'buyer' : isProvider(order, user.id) ? 'provider' : 'admin';
  };
  const busy = (id, except = '') =>
    database
      .prepare(
        "SELECT id FROM orders WHERE id<>? AND (buyer_id=? OR id IN (SELECT order_id FROM order_providers WHERE user_id=? AND live=1)) AND status IN ('ready','active','finishing','confirming','aftercare') LIMIT 1"
      )
      .get(except, id, id);
  const profile = (userId) => {
    const row = database.prepare('SELECT * FROM provider_profiles WHERE user_id=?').get(userId);
    return row
      ? {
          ...JSON.parse(row.payload),
          suspended: !!row.suspended,
          reason: row.reason,
          state: row.suspended
            ? 'suspended'
            : busy(userId)
              ? 'serving'
              : JSON.parse(row.payload).available
                ? 'available'
                : 'idle',
        }
      : null;
  };
  const squads = createPaidSquads(database, { profile, busy, log, now });
  const pause = (order) => {
    order.elapsed = serviceSeconds(order, now());
    order.runningSince = null;
  };
  const invitation = (orderId) =>
    database
      .prepare("SELECT * FROM dispatch_offers WHERE order_id=? AND status='pending'")
      .get(orderId);
  const reserved = (userId) =>
    database
      .prepare(
        "SELECT * FROM dispatch_offers WHERE (user_id=? OR partner_id=?) AND status='pending'"
      )
      .get(userId, userId);
  const eligibleSingle = (order, userId) => {
    const p = profile(userId);
    return (
      order.status === 'matching' &&
      order.payment.status === 'paid' &&
      order.buyerId !== userId &&
      p?.available &&
      !p.suspended &&
      !busy(userId) &&
      !busy(order.buyerId, order.id) &&
      !order.excludedProviders.includes(userId) &&
      p.modes.includes(order.mode) &&
      p.stats[order.mode]?.gear >= order.snapshot.gear
    );
  };
  const eligible = (order, id) =>
    eligibleSingle(order, id) &&
    (providerCount(order) === 1 ||
      squads
        .pair(id)
        ?.every(
          (p) =>
            eligibleSingle(order, p.id) &&
            online(p.id) &&
            (!reserved(p.id) || reserved(p.id).order_id === order.id)
        ));
  const online = (userId) =>
    (database.prepare('SELECT seen_at FROM provider_presence WHERE user_id=?').get(userId)
      ?.seen_at ?? -Infinity) >
    now() - presenceMs;
  function closeOffer(offer, status, reason) {
    database
      .prepare("UPDATE dispatch_offers SET status=?,reason=? WHERE id=? AND status='pending'")
      .run(status, reason, offer.id);
    const order = load(offer.order_id);
    if (order.status === 'matching') {
      event(order, null, `dispatch_${status}`, reason);
      save(order);
    } else log(null, order.id, `dispatch_${status}`, reason);
  }
  function dispatch() {
    return transaction(() => {
      for (const offer of database
        .prepare("SELECT * FROM dispatch_offers WHERE status='pending'")
        .all()) {
        const order = load(offer.order_id);
        if (offer.expires_at <= now()) closeOffer(offer, 'expired', '接单邀请超时，继续匹配');
        else if (
          !online(offer.user_id) ||
          !eligible(order, offer.user_id) ||
          (providerCount(order) === 2 &&
            !squads.pair(offer.user_id)?.some((p) => p.id === offer.partner_id))
        )
          closeOffer(offer, 'invalidated', '接单条件或在线状态变化，撤回邀请');
      }
      // ponytail: one local worker scans at most 100 waiting orders; paginate/queue when real load requires it.
      const candidates = database
        .prepare(
          'SELECT p.user_id FROM provider_presence p WHERE p.seen_at>? ORDER BY coalesce((SELECT max(created_at) FROM dispatch_offers d WHERE d.user_id=p.user_id),0),p.user_id'
        )
        .all(now() - presenceMs);
      for (const row of database
        .prepare("SELECT id FROM orders WHERE status='matching' ORDER BY created_at,id LIMIT 100")
        .all()) {
        if (invitation(row.id)) continue;
        const order = load(row.id);
        const candidate = candidates
          .filter(
            (c) =>
              !reserved(c.user_id) &&
              eligible(order, c.user_id) &&
              !database
                .prepare(
                  "SELECT 1 FROM dispatch_offers WHERE order_id=? AND user_id=? AND status IN ('declined','expired','invalidated') LIMIT 1"
                )
                .get(order.id, c.user_id)
          )
          .sort((a, b) => {
            const x = matchFit(order, profile(a.user_id)),
              y = matchFit(order, profile(b.user_id));
            return (
              y.matchedTags.length - x.matchedTags.length ||
              Number(y.trialMatched) - Number(x.trialMatched)
            );
          })[0];
        if (!candidate) continue;
        const fit = matchFit(order, profile(candidate.user_id));
        database
          .prepare(
            'INSERT INTO dispatch_offers(id,order_id,user_id,status,created_at,expires_at,reason,partner_id) VALUES (?,?,?,?,?,?,?,?)'
          )
          .run(
            randomUUID(),
            order.id,
            candidate.user_id,
            'pending',
            now(),
            now() + offerMs,
            `在线且符合接单条件；匹配${fit.matchedTags.length}个需求标签${fit.trialMatched ? '；愿意试音符合偏好' : ''}`,
            providerCount(order) === 2
              ? squads.pair(candidate.user_id).find((p) => p.id !== candidate.user_id).id
              : null
          );
        notify(
          candidate.user_id,
          order.id,
          '收到接单邀请，请前往订单中心确认',
          `invite:${order.id}:${now()}:${candidate.user_id}`
        );
        event(order, null, 'dispatch_invited', '已向符合条件的在线服务者发送接单邀请');
        save(order);
      }
    });
  }
  function heartbeat(user) {
    transaction(() => {
      const p = profile(user.id);
      requireThat(p, '请先填写服务资料。');
      if (p.available && !p.suspended && !busy(user.id))
        database
          .prepare(
            'INSERT INTO provider_presence VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET seen_at=excluded.seen_at'
          )
          .run(user.id, now());
      else database.prepare('DELETE FROM provider_presence WHERE user_id=?').run(user.id);
    });
    dispatch();
    const offer = reserved(user.id);
    return {
      online: online(user.id),
      offerSeconds: offerMs / 1000,
      ...(offer ? { invitation: { orderId: offer.order_id, expiresAt: offer.expires_at } } : {}),
    };
  }
  const release = (order) => {
    const snapshot = structuredClone(order);
    pause(snapshot);
    snapshot.status = 'released';
    snapshot.readOnly = true;
    for (const id of providerIds(order))
      database
        .prepare('INSERT OR REPLACE INTO released_services VALUES (?,?,?)')
        .run(order.id, id, JSON.stringify(snapshot));
  };
  const advance = (order) => {
    if (order.status === 'active' && serviceSeconds(order, now()) >= order.duration) {
      pause(order);
      order.status = order.currentRound ? 'finishing' : 'confirming';
      event(
        order,
        null,
        'time_elapsed',
        order.currentRound ? '时长届满，完成当前对局后结束' : '时长届满，等待确认完成'
      );
      save(order);
    }
  };
  const enqueue = (order, action, amount, reason, key) =>
    database
      .prepare(
        'INSERT OR IGNORE INTO payment_jobs(id,order_id,action,amount,reason) VALUES (?,?,?,?,?)'
      )
      .run(key, order.id, action, amount, reason);
  function attention(order) {
    const since =
      order.cancelRequest?.at ??
      (order.case && order.case.stage !== 'closed'
        ? (order.case.changedAt ?? order.case.openedAt)
        : order.stageSince);
    const label = order.cancelRequest
      ? '未开始服务，协商取消待回应'
      : order.case?.stage === 'proposed'
        ? '售后方案待确认'
        : order.case && order.case.stage !== 'closed'
          ? '售后待核实'
          : {
              matching: '等待可用服务者',
              ready: '接单后尚未开始',
              finishing: '已到时长，尾局尚未结束',
              confirming: '服务完成待双方确认',
            }[order.status];
    return label && Number.isFinite(since) && now() - since >= attentionMs
      ? { label, since, reminderOnly: true }
      : null;
  }
  function maintain() {
    transaction(() => {
      const active = new Set();
      for (const row of database
        .prepare(
          "SELECT id FROM orders WHERE status IN ('matching','ready','active','finishing','confirming','aftercare') OR (status='completed' AND json_extract(payload,'$.case.stage') IN ('human','appeal','proposed')) ORDER BY created_at LIMIT 500"
        )
        .all()) {
        const order = load(row.id);
        advance(order);
        const flag = attention(order);
        if (!flag) continue;
        const alertId = 'attention:' + order.id;
        active.add(alertId);
        operations.alert(alertId, 'attention', order.id, 'ORDER_WAITING');
        for (const userId of new Set([order.buyerId, ...providerIds(order)].filter(Boolean)))
          notify(
            userId,
            order.id,
            `${flag.label}；请查看订单处理，不会超时自动认责或结算`,
            `attention:${order.id}:${flag.since}:${flag.label}:${userId}`
          );
      }
      for (const row of database
        .prepare("SELECT id FROM operation_alerts WHERE kind='attention' AND resolved_at IS NULL")
        .all())
        if (!active.has(row.id)) operations.resolve(row.id);
    });
  }
  function inbox(user) {
    return {
      notifications: database
        .prepare(
          "SELECT n.id,n.order_id AS orderId,n.label,n.created_at AS createdAt,n.read_at AS readAt,CASE WHEN o.buyer_id=? THEN 'buyer' ELSE 'provider' END AS role FROM notifications n JOIN orders o ON o.id=n.order_id WHERE n.user_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT 200"
        )
        .all(user.id, user.id),
      unread: database
        .prepare('SELECT count(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL')
        .get(user.id).n,
    };
  }
  function unread(user) {
    return {
      unread: database
        .prepare('SELECT count(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL')
        .get(user.id).n,
    };
  }
  function markRead(user, id) {
    const r = database
      .prepare('UPDATE notifications SET read_at=coalesce(read_at,?) WHERE id=? AND user_id=?')
      .run(now(), id, user.id);
    requireThat(r.changes === 1, '消息不存在或无权访问。', 404);
    return { read: true };
  }
  let draining = null,
    notifying = null;
  function drainPayments() {
    if (draining) return draining;
    draining = (async () => {
      const jobs = database
        .prepare(
          "SELECT * FROM payment_jobs WHERE status='pending' AND next_at<=? ORDER BY next_at,rowid LIMIT 5"
        )
        .all(now());
      for (const job of jobs) {
        // Persist the attempt BEFORE I/O. A crash must resume by querying the original request ID.
        database
          .prepare('UPDATE payment_jobs SET attempts=attempts+1,updated_at=?,next_at=? WHERE id=?')
          .run(now(), now() + providerTimeoutMs + retryDelay(job.attempts + 1), job.id);
        try {
          const original = load(job.order_id);
          const validJob = (order) =>
            Number.isSafeInteger(job.amount) &&
            job.amount > 0 &&
            (job.action === 'pay'
              ? order.status === 'pending' &&
                order.payment.status === 'processing' &&
                job.amount === order.price
              : job.action === 'refund' &&
                order.payment.status === 'refund_pending' &&
                typeof order.payment.receiptId === 'string' &&
                Number.isSafeInteger(order.payment.refunded) &&
                order.payment.refunded >= 0 &&
                job.amount <= order.price - order.payment.refunded);
          if (!validJob(original))
            throw Object.assign(Error('PAYMENT_STATE_CONFLICT'), {
              code: 'PAYMENT_STATE_CONFLICT',
            });
          const receipt = await boundedCall(async (signal) => {
            let previous = null;
            if (job.attempts > 0) {
              const lookup =
                job.action === 'pay' ? providers.payment.findPayment : providers.payment.findRefund;
              if (typeof lookup !== 'function')
                throw Object.assign(Error('LOOKUP_UNAVAILABLE'), { code: 'LOOKUP_UNAVAILABLE' });
              previous = await lookup.call(providers.payment, job.id, { signal });
              // null is an authoritative NOT_FOUND, not a network failure or an unknown outcome.
              if (previous === undefined)
                throw Object.assign(Error('LOOKUP_UNAVAILABLE'), { code: 'LOOKUP_UNAVAILABLE' });
            }
            return (
              previous ??
              (job.action === 'pay'
                ? providers.payment.createPayment({
                    reference: original.id,
                    amountCents: job.amount,
                    requestId: job.id,
                    signal,
                  })
                : providers.payment.refund({
                    paymentId: original.payment.receiptId,
                    amountCents: job.amount,
                    requestId: job.id,
                    reason: job.reason,
                    signal,
                  }))
            );
          }, providerTimeoutMs);
          if (
            !receipt ||
            receipt.simulated !== true ||
            receipt.status !== (job.action === 'pay' ? 'succeeded' : 'refunded') ||
            typeof receipt.id !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.id) ||
            !Number.isSafeInteger(receipt.amountCents) ||
            receipt.amountCents !== job.amount ||
            (job.action === 'pay'
              ? receipt.reference !== original.id || receipt.currency !== 'CNY'
              : receipt.paymentId !== original.payment.receiptId)
          )
            throw Object.assign(Error('INVALID_RECEIPT'), { code: 'INVALID_RECEIPT' });
          transaction(() => {
            const currentJob = database
              .prepare('SELECT status FROM payment_jobs WHERE id=?')
              .get(job.id);
            if (currentJob.status !== 'pending') return;
            const order = load(job.order_id);
            if (!validJob(order))
              throw Object.assign(Error('PAYMENT_STATE_CONFLICT'), {
                code: 'PAYMENT_STATE_CONFLICT',
              });
            if (
              database
                .prepare('SELECT 1 FROM payment_receipts WHERE provider=? AND receipt_id=?')
                .get('local', receipt.id) ||
              database
                .prepare(
                  "SELECT 1 FROM orders WHERE json_extract(payload,'$.payment.receiptId')=? LIMIT 1"
                )
                .get(receipt.id)
            )
              throw Object.assign(Error('RECEIPT_REUSED'), { code: 'RECEIPT_REUSED' });
            paymentJournal.record(job, receipt);
            if (job.action === 'pay') {
              order.payment = {
                status: 'paid',
                simulated: true,
                receiptId: receipt.id,
                refunded: 0,
              };
              order.status = 'matching';
            } else {
              requireThat(order.payment.refunded + job.amount <= order.price, '本单退款额度不足。');
              order.payment.refunded += job.amount;
              order.payment.status =
                order.payment.refunded === order.price ? 'refunded' : 'partially_refunded';
            }
            event(
              order,
              null,
              job.action,
              job.action === 'pay'
                ? '模拟支付成功，等待接单（无真实扣款）'
                : `模拟退款完成 ${(job.amount / 100).toFixed(2)}元（无真实资金）`
            );
            save(order);
            database
              .prepare(
                "UPDATE payment_jobs SET status='done',last_error='',updated_at=?,next_at=0 WHERE id=?"
              )
              .run(now(), job.id);
            operations.resolve('payment:' + job.id);
          });
        } catch (error) {
          const code = safeErrorCode(error);
          const blocked =
            job.attempts + 1 - job.retry_base >= 5 ||
            [
              'INVALID_RECEIPT',
              'IDEMPOTENCY_CONFLICT',
              'REFUND_EXCEEDS_PAYMENT',
              'INVALID_AMOUNT',
              'MOCK_NOT_ALLOWED',
              'LOOKUP_UNAVAILABLE',
              'PAYMENT_STATE_CONFLICT',
              'RECEIPT_REUSED',
            ].includes(code);
          database
            .prepare(
              'UPDATE payment_jobs SET status=?,last_error=?,updated_at=?,next_at=? WHERE id=?'
            )
            .run(
              blocked ? 'blocked' : 'pending',
              code,
              now(),
              now() + retryDelay(job.attempts + 1 - job.retry_base),
              job.id
            );
          operations.alert('payment:' + job.id, 'payment', job.order_id, code);
        }
      }
    })().finally(() => {
      draining = null;
    });
    return draining;
  }
  function drainNotifications() {
    if (notifying) return notifying;
    notifying = (async () => {
      for (const job of database
        .prepare(
          "SELECT j.*,n.user_id,n.order_id FROM notification_jobs j JOIN notifications n ON n.id=j.id WHERE j.status='pending' AND j.next_at<=? ORDER BY j.next_at,j.rowid LIMIT 5"
        )
        .all(now())) {
        database
          .prepare(
            'UPDATE notification_jobs SET attempts=attempts+1,updated_at=?,next_at=? WHERE id=?'
          )
          .run(now(), now() + providerTimeoutMs + retryDelay(job.attempts + 1), job.id);
        try {
          const receipt = await boundedCall(
            (signal) =>
              providers.notification.send({
                userId: job.user_id,
                topic: 'order_update',
                requestId: job.id,
                signal,
              }),
            providerTimeoutMs
          );
          // Current adapter only records an intent; it must never claim external delivery.
          if (
            receipt?.simulated !== true ||
            receipt.delivered !== false ||
            receipt.status !== 'recorded'
          )
            throw Object.assign(Error('INVALID_RECEIPT'), { code: 'INVALID_RECEIPT' });
          database
            .prepare(
              "UPDATE notification_jobs SET status='done',last_error='',updated_at=?,next_at=0 WHERE id=?"
            )
            .run(now(), job.id);
          operations.resolve('notification:' + job.id);
        } catch (error) {
          const code = safeErrorCode(error),
            blocked = job.attempts + 1 - job.retry_base >= 5 || code === 'INVALID_RECEIPT';
          database
            .prepare(
              'UPDATE notification_jobs SET status=?,last_error=?,updated_at=?,next_at=? WHERE id=?'
            )
            .run(
              blocked ? 'blocked' : 'pending',
              code,
              now(),
              now() + retryDelay(job.attempts + 1 - job.retry_base),
              job.id
            );
          operations.alert('notification:' + job.id, 'notification', job.order_id, code);
        }
      }
    })().finally(() => {
      notifying = null;
    });
    return notifying;
  }
  function settle(order, actor) {
    const proposal = order.case.proposal;
    if (proposal.outcome === 'refund') {
      const amount = Math.round((order.price * proposal.percent) / 100);
      requireThat(
        amount > 0 &&
          order.payment.refunded + amount <= order.price &&
          order.payment.status !== 'refund_pending',
        '本单退款额度不足或退款处理中。'
      );
      order.payment.status = 'refund_pending';
      order.status = 'completed';
      enqueue(order, 'refund', amount, 'CASE_RESOLUTION', `refund:${order.case.id}`);
    } else if (proposal.outcome === 'replace') {
      release(order);
      order.excludedProviders.push(...providerIds(order));
      order.providerId = null;
      order.provider = null;
      order.providers = [];
      order.squadId = null;
      order.status = 'matching';
      order.start = { buyer: false, provider: false };
      order.lowKdAccepted = false;
      order.currentRound = false;
    } else {
      order.status = order.case.previousStatus;
      if (order.status === 'active') order.runningSince = now();
      if (proposal.outcome === 'adjustTime') {
        order.elapsed = Math.max(
          0,
          Math.min(order.duration, order.elapsed + proposal.deltaSeconds)
        );
        order.status =
          order.elapsed < order.duration
            ? 'active'
            : order.currentRound
              ? 'finishing'
              : 'confirming';
        order.runningSince = order.status === 'active' ? now() : null;
      }
    }
    order.case.closedAt = now();
    order.case.stage = 'closed';
    event(order, actor, 'case_settled', `售后处理完成：${proposal.reason}`);
  }
  function presentOrder(order, user) {
    const view = {
      ...order,
      newPaymentAllowed: paidOrdersEnabled,
      snapshot: { ...order.snapshot, image: productArt(order.mode) },
      payment: { ...order.payment },
    };
    if (isProvider(order, user.id) && providerCount(order) === 2) {
      view.start = { ...order.start, provider: providerConfirmed(order, order.start, user.id) };
      view.complete = {
        ...order.complete,
        provider: providerConfirmed(order, order.complete, user.id),
      };
      if (order.case?.proposal)
        view.case = {
          ...order.case,
          proposal: {
            ...order.case.proposal,
            accepted: {
              ...order.case.proposal.accepted,
              provider: providerConfirmed(order, order.case.proposal.accepted, user.id),
            },
          },
        };
    }
    view.viewerId = user.id;
    if (user.id !== order.buyerId && user.role !== 'admin') delete view.payment.receiptId;
    return order.readOnly ? view : { ...view, aftercareGuide: aftercareGuide(order, user, now()) };
  }
  function readOrder(id, user) {
    return transaction(() => {
      const order = load(id);
      if (user.id !== order.buyerId && !isProvider(order, user.id) && user.role !== 'admin') {
        const released = database
          .prepare('SELECT payload FROM released_services WHERE order_id=? AND user_id=?')
          .get(id, user.id);
        requireThat(released, '订单不存在或无权查看。', 404);
        return presentOrder(JSON.parse(released.payload), user);
      }
      participant(order, user);
      advance(order);
      return presentOrder(order, user);
    });
  }
  function mutate(user, scope, body, operation) {
    const requestId = text(body.requestId, 8, 128);
    const fingerprint = createHash('sha256').update(JSON.stringify({ scope, body })).digest('hex');
    return transaction(() => {
      const previous = database
        .prepare(
          'SELECT fingerprint,result FROM business_requests WHERE user_id=? AND request_id=?'
        )
        .get(user.id, requestId);
      if (previous) {
        requireThat(previous.fingerprint === fingerprint, '重复请求参数不一致。');
        return JSON.parse(previous.result);
      }
      const result = operation();
      // Replayed order commands already re-read the authorized current order below.
      // Keep its ID, not another full copy of private chat/evidence and history.
      const replay = result.order ? { order: { id: result.order.id } } : result;
      database
        .prepare('INSERT INTO business_requests VALUES (?,?,?,?)')
        .run(user.id, requestId, fingerprint, JSON.stringify(replay));
      return result;
    });
  }
  async function command(user, scope, body) {
    // HTTP callers use typed scopes. Preserve explicit legacy internal/test calls,
    // while preventing order IDs from being interpreted as administrator scopes.
    if (scope && typeof scope === 'object') {
      requireThat(
        typeof scope.action === 'string' && /^[A-Za-z]+$/.test(scope.action),
        '操作无效。',
        400
      );
      if (scope.type === 'admin') scope = 'admin:' + scope.action;
      else {
        requireThat(
          scope.type === 'order' && /^DF[A-Za-z0-9]{20}$/.test(scope.id),
          '订单不存在或无权查看。',
          404
        );
        scope = scope.id + ':' + scope.action;
      }
    }
    requireThat(
      typeof scope === 'string' &&
        (['preferences', 'profile', 'create', 'squadCreate', 'squadJoin', 'squadLeave'].includes(
          scope
        ) ||
          /^admin:[A-Za-z]+$/.test(scope) ||
          /^DF[A-Za-z0-9]{20}:[A-Za-z]+$/.test(scope)),
      '操作无效。',
      400
    );
    // Stop new commitments before replay, dispatch or mutation; accepted jobs still drain.
    requireThat(
      paidOrdersEnabled || (scope !== 'create' && !scope.endsWith(':pay')),
      '付费服务暂未开放，可先使用免费组队；已有订单仍可查看和处理。',
      403
    );
    dispatch();
    const result = mutate(user, scope, body, () => {
      if (scope.startsWith('squad'))
        return squads.command(user, scope.slice(5).toLowerCase(), body);
      if (scope === 'preferences') {
        const p = matchingFields(body, preferences(user.id));
        database
          .prepare(
            'INSERT INTO user_preferences VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload'
          )
          .run(user.id, JSON.stringify(p));
        log(user.id, user.id, 'preferences_saved', '消费者更新默认匹配偏好');
        return { preferences: p };
      }
      if (scope === 'profile') {
        requireThat(body.adult === true, '接单需声明年满18周岁。', 400);
        const existing = profile(user.id);
        requireThat(!busy(user.id), '已有服务订单，请完成后再修改接单资料。');
        requireThat(
          Array.isArray(body.modes) &&
            body.modes.length > 0 &&
            body.modes.length <= products().length,
          '请选择可服务模式。',
          400
        );
        const modes = [...new Set(body.modes)];
        const stats = {};
        for (const mode of modes) {
          const product = products().find((p) => p.id === mode && p.status === 'available');
          const item = body.stats?.[mode];
          requireThat(
            product &&
              Number.isFinite(item?.kd) &&
              item.kd >= 0 &&
              item.kd <= 100 &&
              Number.isInteger(item?.gear) &&
              item.gear >= product.gear &&
              item.gear <= 100,
            'KD 或装备填写不符合所选模式要求。',
            400
          );
          stats[mode] = { kd: item.kd, gear: item.gear };
        }
        requireThat(
          body.trialAvailable === undefined || typeof body.trialAvailable === 'boolean',
          '试音选项格式无效。',
          400
        );
        const payload = {
          gameId: text(body.gameId, 1, 64),
          introduction: text(body.introduction, 1, 160),
          modes,
          stats,
          tags: tags(body.tags ?? existing?.tags ?? []),
          trialAvailable: body.trialAvailable ?? existing?.trialAvailable ?? false,
          adult: true,
          available: existing?.suspended ? false : body.available === true,
        };
        database
          .prepare(
            'INSERT INTO provider_profiles(user_id,payload) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload'
          )
          .run(user.id, JSON.stringify(payload));
        log(user.id, user.id, 'profile_saved', '服务者自报资料保存，无首次审核');
        return { profile: profile(user.id) };
      }
      if (scope === 'create') {
        const product = products().find((p) => p.id === body.mode && p.status === 'available');
        requireThat(product, '服务已下架或不存在。', 400);
        requireThat(body.rulesAccepted === true, '请阅读并同意点单须知。', 400);
        const seats = body.providerCount ?? 1;
        requireThat(Number.isInteger(seats) && [1, 2].includes(seats), '请选择1位或2位陪玩。', 400);
        const needs = matchingFields(body, preferences(user.id));
        const count = database
          .prepare("SELECT COUNT(*) n FROM orders WHERE buyer_id=? AND status='pending'")
          .get(user.id).n;
        requireThat(count < 10, '待支付订单过多，请先处理已有订单。');
        const order = {
          ...needs,
          matchingVersion: 'tags-v1',
          id: `DF${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          buyerId: user.id,
          providerId: null,
          customer: user.name,
          mode: product.id,
          snapshot: product,
          providerCount: seats,
          unitPrice: product.price,
          price: product.price * seats,
          providers: [],
          duration: product.minutes * 60,
          status: 'pending',
          stageSince: now(),
          version: 0,
          elapsed: 0,
          runningSince: null,
          date: new Date(now()).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }),
          createdAt: now(),
          provider: null,
          start: { buyer: false, provider: false },
          complete: { buyer: false, provider: false },
          lowKdAccepted: false,
          excludedProviders: [],
          firstSwapUsed: false,
          rounds: [],
          currentRound: false,
          case: null,
          cases: [],
          review: null,
          messages: [],
          events: [],
          preference:
            typeof body.preference === 'string' && body.preference.trim()
              ? text(body.preference, 1, 160)
              : '正常语音沟通，配合团队节奏。',
          payment: { status: 'unpaid', simulated: true, refunded: 0 },
        };
        event(order, user.id, 'created', '订单创建，商品与规则版本已保存');
        database
          .prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?)')
          .run(order.id, user.id, null, order.status, JSON.stringify(order), 0, now());
        return { order };
      }
      if (scope.startsWith('admin:')) {
        requireThat(user.role === 'admin', '需要管理员权限。', 403);
        const action = scope.slice(6);
        const reason = text(body.reason, 10, 300);
        if (action === 'retry') {
          requireThat(['payment', 'notification'].includes(body.kind), '任务类型无效。', 400);
          const table = body.kind === 'payment' ? 'payment_jobs' : 'notification_jobs';
          const job = database
            .prepare('SELECT * FROM ' + table + ' WHERE id=?')
            .get(text(body.id, 1, 200));
          requireThat(job?.status === 'blocked', '仅允许恢复已暂停的任务。');
          const orderId =
            body.kind === 'payment'
              ? job.order_id
              : database.prepare('SELECT order_id FROM notifications WHERE id=?').get(job.id)
                  .order_id;
          const order = load(orderId);
          requireThat(
            user.id !== order.buyerId &&
              !isProvider(order, user.id) &&
              !database
                .prepare('SELECT 1 FROM released_services WHERE order_id=? AND user_id=?')
                .get(orderId, user.id),
            '不能恢复自己参与订单的异常任务。',
            403
          );
          database
            .prepare(
              'UPDATE ' +
                table +
                " SET status='pending',next_at=?,retry_base=attempts,updated_at=? WHERE id=?"
            )
            .run(now(), now(), job.id);
          log(user.id, orderId, 'task_retry', reason + ' [' + body.kind + ':' + job.id + ']');
          return { retried: true, taskId: job.id };
        }
        if (action === 'product') {
          const product = products().find((p) => p.id === body.id);
          requireThat(
            product &&
              ['available', 'offline'].includes(body.status) &&
              Number.isInteger(body.price) &&
              body.price > 0 &&
              body.price <= 100000,
            '商品参数无效。',
            400
          );
          product.price = body.price;
          product.status = body.status;
          database
            .prepare('UPDATE products SET payload=? WHERE id=?')
            .run(JSON.stringify(product), product.id);
          log(user.id, product.id, 'product_updated', reason);
          return { product };
        }
        if (action === 'suspend') {
          requireThat(
            profile(body.userId) && typeof body.suspended === 'boolean' && body.userId !== user.id,
            '服务者或参数无效。',
            400
          );
          database
            .prepare('UPDATE provider_profiles SET suspended=?,reason=? WHERE user_id=?')
            .run(Number(body.suspended), reason, body.userId);
          log(
            user.id,
            body.userId,
            body.suspended ? 'provider_suspended' : 'provider_restored',
            reason
          );
          return { profile: profile(body.userId) };
        }
        throw new BusinessError('不支持的管理操作。', 400);
      }
      const id = scope.split(':')[0],
        action = scope.slice(id.length + 1);
      const order = load(id);
      let role;
      if (action === 'declineOffer') {
        const offer = invitation(id);
        requireThat(
          offer &&
            [offer.user_id, offer.partner_id].includes(user.id) &&
            body.offerId === offer.id &&
            offer.expires_at > now(),
          '邀请已失效，请刷新接单列表。'
        );
        closeOffer(offer, 'declined', '服务者跳过本次邀请，继续匹配');
        return { declined: true };
      }
      if (action === 'accept') {
        requireThat(
          order.buyerId !== user.id && order.status === 'matching',
          '不能接自己的订单或已被接走的订单。'
        );
        const p = profile(user.id);
        requireThat(eligible(order, user.id), '目前不符合此订单的接单条件。');
        const offer = invitation(id),
          held = reserved(user.id);
        requireThat(!held || held.order_id === id, '请先接受或跳过已有邀请。');
        if (offer || body.offerId) {
          requireThat(
            offer &&
              [offer.user_id, offer.partner_id].includes(user.id) &&
              offer.id === body.offerId &&
              offer.expires_at > now() &&
              online(user.id),
            '邀请已失效或不属于你，请刷新后重试。'
          );
          database
            .prepare(
              "UPDATE dispatch_offers SET status='accepted',reason='服务者明确接受邀请' WHERE id=? AND status='pending'"
            )
            .run(offer.id);
        }
        role = 'provider';
        order.providerId = user.id;
        order.provider = {
          id: user.id,
          name: user.name,
          gameId: p.gameId,
          tags: p.tags || [],
          trialAvailable: !!p.trialAvailable,
          ...p.stats[order.mode],
        };
        order.providers =
          providerCount(order) === 2
            ? squads.pair(user.id).map((member) => {
                const item = profile(member.id);
                return {
                  id: member.id,
                  name: member.name,
                  gameId: item.gameId,
                  tags: item.tags || [],
                  trialAvailable: !!item.trialAvailable,
                  ...item.stats[order.mode],
                };
              })
            : [order.provider];
        if (providerCount(order) === 2) order.squadId = squads.view(user.id).id;
        order.start = { buyer: false, provider: false, providers: {} };
        order.complete = { buyer: false, provider: false, providers: {} };
        order.status = 'ready';
        event(order, user.id, action, '服务者接单，等待全体参与者确认开始');
      } else {
        role = participant(order, user);
        advance(order);
        requireThat(
          Number.isInteger(body.version) && body.version === order.version,
          '订单已更新，请刷新后重试。'
        );
        const buyer = () => requireThat(role === 'buyer', '此操作仅消费者可用。', 403);
        const provider = () => requireThat(role === 'provider', '此操作仅服务者可用。', 403);
        switch (action) {
          case 'pay':
            buyer();
            requireThat(
              order.status === 'pending' && order.payment.status === 'unpaid',
              '订单不可支付。'
            );
            order.payment.status = 'processing';
            enqueue(order, 'pay', order.price, 'MOCK_CHECKOUT', `pay:${id}`);
            break;
          case 'cancel':
            buyer();
            requireThat(
              ['pending', 'matching'].includes(order.status) &&
                order.elapsed === 0 &&
                ['paid', 'unpaid'].includes(order.payment.status),
              '当前订单不能直接取消，请发起售后。'
            );
            order.status = 'cancelled';
            if (order.firstSwapUsed) order.cancelRuleVersion = '2026-10-01-preview';
            if (order.payment.status === 'paid') {
              order.payment.status = 'refund_pending';
              enqueue(
                order,
                'refund',
                order.price,
                order.firstSwapUsed ? 'REPLACEMENT_WAIT_CANCELLED' : 'BUYER_CANCELLED',
                `cancel:${id}`
              );
            }
            break;
          case 'requestCancel':
            requireThat(
              ['buyer', 'provider'].includes(role) &&
                order.status === 'ready' &&
                order.elapsed === 0 &&
                !order.firstSwapUsed &&
                !order.cancelRequest &&
                (!order.case || order.case.stage === 'closed'),
              '仅未开始的初次服务可协商取消；其他情况请提交售后。'
            );
            order.cancelRequest = {
              by: user.id,
              reason: text(body.reason, 10, 300),
              at: now(),
              accepted: [user.id],
            };
            break;
          case 'respondCancel':
            requireThat(
              ['buyer', 'provider'].includes(role) &&
                order.status === 'ready' &&
                order.cancelRequest &&
                order.cancelRequest.by !== user.id &&
                typeof body.agreed === 'boolean',
              '暂无可回应的取消申请。'
            );
            if (body.agreed) {
              order.cancelRequest.accepted ||= [order.cancelRequest.by];
              requireThat(!order.cancelRequest.accepted.includes(user.id), '你已同意取消。');
              order.cancelRequest.accepted.push(user.id);
              if (
                [order.buyerId, ...providerIds(order)].every((id) =>
                  order.cancelRequest.accepted.includes(id)
                )
              ) {
                order.cancelRequest.result = 'accepted';
                order.status = 'cancelled';
                order.payment.status = 'refund_pending';
                enqueue(order, 'refund', order.price, 'MUTUAL_UNSTARTED_CANCEL', `cancel:${id}`);
              }
            } else {
              order.cancelHistory = [
                ...(order.cancelHistory || []),
                {
                  ...order.cancelRequest,
                  result: 'declined',
                  reasonReply: text(body.reason, 10, 300),
                },
              ];
              order.cancelRequest = null;
            }
            break;
          case 'remind':
            requireThat(
              ['buyer', 'provider'].includes(role) &&
                ['ready', 'finishing', 'confirming', 'aftercare'].includes(order.status) &&
                now() - (order.lastRemindedAt ?? -Infinity) >= 5 * 60_000,
              '当前不可提醒，或距离上次提醒不足5分钟。'
            );
            order.lastRemindedAt = now();
            break;
          case 'start':
            requireThat(
              ['buyer', 'provider'].includes(role) &&
                order.status === 'ready' &&
                !order.cancelRequest &&
                !(role === 'provider'
                  ? providerConfirmed(order, order.start, user.id)
                  : order.start.buyer),
              '当前不可确认开始；有取消申请时请先回应。'
            );
            if (role === 'buyer' && lowKd(order)) {
              requireThat(body.acceptLowKd === true, '须明确同意已披露的低 KD，或免费更换。');
              order.lowKdAccepted = true;
            }
            if (role === 'provider' && providerCount(order) === 2) {
              (order.start.providers ||= {})[user.id] = true;
              order.start.provider = allProvidersConfirmed(order, order.start);
            } else order.start[role] = true;
            if (order.start.buyer && order.start.provider) {
              requireThat(!lowKd(order) || order.lowKdAccepted, '低 KD 尚未取得知情同意。');
              order.status = 'active';
              order.runningSince = now();
            }
            break;
          case 'declineKd':
            buyer();
            requireThat(order.status === 'ready' && lowKd(order), '不适用低 KD 更换。');
            release(order);
            order.excludedProviders.push(...providerIds(order));
            order.providerId = null;
            order.provider = null;
            order.providers = [];
            order.squadId = null;
            order.status = 'matching';
            order.start = { buyer: false, provider: false };
            order.lowKdAccepted = false;
            break;
          case 'beginRound':
            requireThat(
              ['buyer', 'provider'].includes(role) &&
                order.status === 'active' &&
                !order.currentRound,
              '当前不能开始新对局。'
            );
            order.currentRound = true;
            break;
          case 'endRound':
            requireThat(
              ['buyer', 'provider'].includes(role) &&
                ['active', 'finishing'].includes(order.status) &&
                order.currentRound &&
                ['success', 'failed'].includes(body.result),
              '请先登记对局开始，再提交有效结果。'
            );
            order.rounds.push({
              result: body.result,
              reportedBy: user.id,
              reportedRole: role,
              reportedAt: now(),
              normal: false,
            });
            order.currentRound = false;
            if (order.status === 'finishing') order.status = 'confirming';
            break;
          case 'confirmRound':
            {
              const round = order.rounds[body.index];
              requireThat(
                ['buyer', 'provider'].includes(role) &&
                  ['active', 'finishing', 'confirming'].includes(order.status) &&
                  round &&
                  !round.normal &&
                  body.agreed === true,
                '请由另一方核对有效的对局记录，不可重复确认。'
              );
              if (providerCount(order) === 2) {
                round.confirmedIds ||= [round.reportedBy];
                requireThat(!round.confirmedIds.includes(user.id), '不可自行或重复确认该局记录。');
                round.confirmedIds.push(user.id);
                round.normal = [order.buyerId, ...providerIds(order)].every((id) =>
                  round.confirmedIds.includes(id)
                );
              } else {
                requireThat(
                  role !== (round.reportedRole || 'provider'),
                  '请由另一方确认该局记录，不可自行确认。'
                );
                round.normal = true;
              }
              round.confirmedBy = user.id;
            }
            break;
          case 'firstSwap':
            buyer();
            requireThat(aftercareChecks(order, now()).firstSwap, '不符合首局免费换人条件。');
            release(order);
            order.excludedProviders.push(...providerIds(order));
            pause(order);
            order.elapsed = 0;
            order.providerId = null;
            order.provider = null;
            order.providers = [];
            order.squadId = null;
            order.status = 'matching';
            order.firstSwapUsed = true;
            order.rounds = [];
            order.start = { buyer: false, provider: false };
            order.lowKdAccepted = false;
            break;
          case 'finish':
            requireThat(
              ['buyer', 'provider'].includes(role) &&
                order.status === 'confirming' &&
                !order.currentRound &&
                order.rounds.every((r) => r.normal) &&
                !(role === 'provider'
                  ? providerConfirmed(order, order.complete, user.id)
                  : order.complete.buyer),
              '请完成服务时长、当前对局与结果核对后再确认；不重复确认。'
            );
            if (role === 'provider' && providerCount(order) === 2) {
              (order.complete.providers ||= {})[user.id] = true;
              order.complete.provider = allProvidersConfirmed(order, order.complete);
            } else order.complete[role] = true;
            if (order.complete.buyer && order.complete.provider) order.status = 'completed';
            break;
          case 'review':
            buyer();
            requireThat(
              order.status === 'completed' &&
                !order.review &&
                (!order.case || order.case.stage === 'closed') &&
                ['attitude', 'communication', 'experience'].every(
                  (key) => Number.isInteger(body[key]) && body[key] >= 1 && body[key] <= 5
                ),
              '订单未完成、评价已提交或评分无效。'
            );
            order.review = {
              attitude: body.attitude,
              communication: body.communication,
              experience: body.experience,
              text: body.text ? text(body.text, 1, 300) : '',
            };
            break;
          case 'message':
            requireThat(
              ['buyer', 'provider'].includes(role) &&
                order.providerId &&
                order.messages.length < 500,
              '当前不能发送订单消息。'
            );
            order.messages.push({
              role,
              actorId: user.id,
              actorName: user.name,
              text: text(body.text, 1, 300),
              time: new Date(now()).toISOString(),
            });
            break;
          case 'request': {
            requireThat(
              ['buyer', 'provider'].includes(role) &&
                ['ready', 'active', 'finishing', 'confirming', 'completed'].includes(
                  order.status
                ) &&
                (!order.case || order.case.stage === 'closed') &&
                caseKinds.includes(body.kind),
              '此订单已有处理中售后，或状态不支持。'
            );
            requireThat(
              role === 'buyer' || ['time', 'complaint'].includes(body.kind),
              '服务者仅可提交时长异议或投诉。',
              403
            );
            if (body.kind === 'zero')
              requireThat(
                aftercareChecks(order, now()).zero,
                '零撤离申请需完成一小时且全部对局经双方确认未撤离。'
              );
            requireThat(
              !['refund_pending', 'refunded', 'partially_refunded'].includes(order.payment.status),
              '本单已退款或处理中，不重复叠加保障。'
            );
            if (order.case) order.cases.push(order.case);
            if (order.cancelRequest) {
              order.cancelHistory = [
                ...(order.cancelHistory || []),
                { ...order.cancelRequest, result: 'aftercare' },
              ];
              order.cancelRequest = null;
            }
            const context = {};
            if (body.occurredWhen) context.occurredWhen = text(body.occurredWhen, 1, 120);
            if (body.expectation) {
              requireThat(
                ['refund', 'replace', 'adjustTime', 'explanation'].includes(body.expectation),
                '处理诉求无效。',
                400
              );
              context.expectation = body.expectation;
            }
            const previousStatus = order.status;
            pause(order);
            order.case = {
              id: randomUUID(),
              kind: body.kind,
              stage: 'human',
              previousStatus,
              description: text(body.description, 10, 500),
              evidence: body.evidence ? [text(body.evidence, 1, 1000)] : [],
              notes: [],
              openedBy: user.id,
              openedAt: now(),
              context,
              metricsVersion: 1,
              humanActions: 0,
              materialRequests: [],
              percent:
                body.kind === 'serious'
                  ? 100
                  : body.kind === 'zero'
                    ? 50
                    : body.kind === 'service'
                      ? order.elapsed < 1800
                        ? 100
                        : 50
                      : 0,
              proposal: null,
            };
            if (previousStatus !== 'completed') order.status = 'aftercare';
            break;
          }
          case 'supplement':
            requireThat(
              ['buyer', 'provider'].includes(role) &&
                order.case &&
                ['human', 'appeal'].includes(order.case.stage) &&
                order.case.notes.length < 50,
              '方案确认期间请先提出异议，再补交材料；已处理售后只供查看。'
            );
            order.case.notes.push({
              role,
              actorId: user.id,
              actorName: user.name,
              text: text(body.description, 10, 500),
              time: now(),
            });
            if (body.evidence) order.case.evidence.push(text(body.evidence, 1, 1000));
            if (body.answeredMaterialRequestId) {
              const request = (order.case.materialRequests || []).find(
                (r) =>
                  r.id === body.answeredMaterialRequestId &&
                  r.forRole === role &&
                  r.respondedAt == null
              );
              requireThat(request, '补证要求已更新或无权回应。');
              request.respondedAt = now();
            }
            break;
          case 'requestMaterials':
          case 'proposeCase': {
            requireThat(user.role === 'admin', '仅管理员可核实并提出售后方案。', 403);
            requireThat(
              user.id !== order.buyerId &&
                !isProvider(order, user.id) &&
                !database
                  .prepare('SELECT 1 FROM released_services WHERE order_id=? AND user_id=?')
                  .get(order.id, user.id),
              '管理员不得处理自己参与的订单，请由其他管理员核实。',
              403
            );
            requireThat(
              order.case &&
                ['human', 'appeal'].includes(order.case.stage) &&
                (action === 'requestMaterials' ||
                  ['refund', 'resume', 'replace', 'adjustTime'].includes(body.outcome)),
              '当前无法提交处理方案。'
            );
            if (action === 'requestMaterials') {
              requireThat(
                ['buyer', 'provider'].includes(body.forRole) &&
                  (order.case.materialRequests || []).length < 20,
                '补证对象无效或要求过多。',
                400
              );
              const description = text(body.reason, 10, 300);
              order.case.materialRequests ||= [];
              order.case.materialRequests.push({
                id: randomUUID(),
                forRole: body.forRole,
                description,
                at: now(),
                by: user.id,
              });
              order.case.firstReviewedAt ??= now();
              order.case.humanActions = (order.case.humanActions || 0) + 1;
              break;
            }
            requireThat(
              body.outcome !== 'refund' || order.case.percent > 0,
              '此申请无确定退款比例，请补充核实依据。'
            );
            requireThat(
              body.outcome !== 'replace' ||
                ['ready', 'active', 'finishing'].includes(order.case.previousStatus),
              '服务已结束，不适用更换。'
            );
            const reason = text(body.reason, 10, 300);
            if (body.outcome === 'adjustTime')
              requireThat(
                order.case.kind === 'time' &&
                  ['active', 'finishing', 'confirming'].includes(order.case.previousStatus) &&
                  Number.isInteger(body.deltaSeconds) &&
                  Math.abs(body.deltaSeconds) <= 3600,
                '校时仅用于未完成服务的时长异议，且在一小时范围内。'
              );
            order.case.firstReviewedAt ??= now();
            order.case.humanActions = (order.case.humanActions || 0) + 1;
            order.case.proposal = {
              outcome: body.outcome,
              reason,
              percent: order.case.percent,
              deltaSeconds: body.outcome === 'adjustTime' ? body.deltaSeconds : 0,
              accepted: { buyer: false, provider: false },
            };
            if (body.final === true) {
              requireThat(order.case.stage === 'appeal', '最终人工处理需先进入申诉。');
              settle(order, user.id);
            } else order.case.stage = 'proposed';
            break;
          }
          case 'acceptCase':
            requireThat(
              ['buyer', 'provider'].includes(role) &&
                order.case?.stage === 'proposed' &&
                !(role === 'provider'
                  ? providerConfirmed(order, order.case.proposal.accepted, user.id)
                  : order.case.proposal.accepted.buyer),
              '暂无待确认处理方案，或你已接受。'
            );
            if (role === 'provider' && providerCount(order) === 2) {
              (order.case.proposal.accepted.providers ||= {})[user.id] = true;
              order.case.proposal.accepted.provider = allProvidersConfirmed(
                order,
                order.case.proposal.accepted
              );
            } else order.case.proposal.accepted[role] = true;
            if (order.case.proposal.accepted.buyer && order.case.proposal.accepted.provider)
              settle(order, user.id);
            break;
          case 'appealCase':
            requireThat(
              ['buyer', 'provider'].includes(role) && order.case?.stage === 'proposed',
              '暂无可申诉方案。'
            );
            order.case.stage = 'appeal';
            order.case.notes.push({
              role,
              actorId: user.id,
              actorName: user.name,
              text: text(body.description, 10, 500),
              time: now(),
            });
            break;
          default:
            throw new BusinessError('不支持的订单操作。', 400);
        }
        event(
          order,
          user.id,
          action,
          {
            requestCancel: '发起未开始服务的协商取消',
            respondCancel: body.agreed
              ? order.status === 'cancelled'
                ? '全部参与者同意取消未开始服务，模拟退款'
                : '同意取消，等待其他参与者确认'
              : '取消申请未达成一致，可继续沟通或售后',
            remind: '已发送站内处理提醒',
            pay: '发起模拟支付',
            cancel: '取消订单',
            start: '确认开始服务',
            beginRound: '登记对局开始',
            endRound: '参与者提交对局结果，待另一方确认',
            confirmRound: '另一方确认对局记录',
            firstSwap: '首局免费换人，完整时长重计',
            finish: '确认服务完成',
            request: '提交售后，等待人工核实',
            review: '提交评价',
            message: '发送订单消息',
            declineKd: '低 KD 免费更换',
            supplement: '补充售后材料',
            requestMaterials: '人工提出补充材料要求',
            proposeCase: '人工核实并提出售后方案',
            acceptCase: '接受售后方案',
            appealCase: '提出异议，转人工复核',
          }[action]
        );
      }
      save(order);
      return { order };
    });
    await drainPayments();
    dispatch();
    return result.order ? { order: readOrder(result.order.id, user) } : result;
  }
  function list(user, role = 'buyer') {
    return transaction(() => {
      const rows =
        role === 'provider'
          ? database
              .prepare(
                'SELECT id FROM orders WHERE id IN (SELECT order_id FROM order_providers WHERE user_id=?) ORDER BY created_at DESC LIMIT 200'
              )
              .all(user.id)
          : database
              .prepare('SELECT id FROM orders WHERE buyer_id=? ORDER BY created_at DESC LIMIT 200')
              .all(user.id);
      const result = rows.map((row) => {
        const order = load(row.id);
        advance(order);
        return presentOrder(order, user);
      });
      if (role === 'provider')
        result.push(
          ...database
            .prepare('SELECT payload FROM released_services WHERE user_id=? LIMIT 200')
            .all(user.id)
            .map((row) => presentOrder(JSON.parse(row.payload), user))
        );
      return result;
    });
  }
  function queue(user) {
    dispatch();
    const p = profile(user.id);
    if (!p?.available || p.suspended || busy(user.id)) return [];
    const held = reserved(user.id);
    return database
      .prepare(
        "SELECT payload,version FROM orders WHERE status='matching' AND buyer_id<>? ORDER BY created_at LIMIT 100"
      )
      .all(user.id)
      .map((row) => ({ ...JSON.parse(row.payload), version: row.version }))
      .filter(
        (order) =>
          eligible(order, user.id) &&
          (!held || held.order_id === order.id) &&
          (!invitation(order.id) ||
            [invitation(order.id).user_id, invitation(order.id).partner_id].includes(user.id))
      )
      .map((order) => {
        const offer = invitation(order.id);
        return {
          id: order.id,
          mode: order.mode,
          snapshot: { ...order.snapshot, image: productArt(order.mode) },
          providerCount: providerCount(order),
          unitPrice: order.unitPrice || order.snapshot.price,
          price: order.price,
          duration: order.duration,
          date: order.date,
          status: order.status,
          version: order.version,
          provider: null,
          customer: '消费者',
          elapsed: order.elapsed,
          runningSince: null,
          events: [],
          messages: [],
          rounds: [],
          start: { buyer: false, provider: false },
          complete: { buyer: false, provider: false },
          payment: { simulated: true },
          preference: '',
          desiredTags: order.desiredTags || [],
          matchNote: order.matchNote || '',
          preferTrial: !!order.preferTrial,
          match: matchFit(order, p),
          excludedProviders: [],
          firstSwapUsed: order.firstSwapUsed,
          ...(offer ? { offer: { id: offer.id, expiresAt: offer.expires_at } } : {}),
        };
      });
  }
  function adminData(user) {
    requireThat(user.role === 'admin', '需要管理员权限。', 403);
    return {
      operations: operations.snapshot(),
      aftercareMetrics: aftercareMetricsFromDatabase(database, now()),
      attention: database
        .prepare(
          "SELECT id FROM orders WHERE status IN ('matching','ready','active','finishing','confirming','aftercare') OR (status='completed' AND json_extract(payload,'$.case.stage') IN ('human','appeal','proposed')) ORDER BY created_at LIMIT 500"
        )
        .all()
        .map((row) => load(row.id))
        .map((o) => ({ id: o.id, status: o.status, flag: attention(o) }))
        .filter((o) => o.flag),
      cases: database
        .prepare(
          "SELECT id FROM orders WHERE json_extract(payload,'$.case.stage') IN ('human','appeal','proposed') ORDER BY created_at DESC LIMIT 500"
        )
        .all()
        .map((row) => load(row.id)),
      profiles: database
        .prepare('SELECT user_id FROM provider_profiles ORDER BY user_id LIMIT 500')
        .all()
        .map((row) => ({ userId: row.user_id, ...profile(row.user_id) })),
      products: products(),
      audit: database.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 100').all(),
    };
  }
  function recordEvidence(user, orderId, caseId, operation) {
    return transaction(() => {
      const order = load(orderId),
        role = participant(order, user);
      requireThat(
        ['buyer', 'provider'].includes(role) &&
          order.case?.id === caseId &&
          ['human', 'appeal'].includes(order.case.stage),
        '方案确认期间请先提出异议，再补交材料；已处理售后只供查看。'
      );
      const result = operation();
      if (result.created) {
        event(order, user.id, 'evidence_uploaded', '已补充售后附件，等待核实');
        save(order);
      }
      return { ...result.file, orderVersion: order.version };
    });
  }
  return {
    squads,
    products,
    profile,
    preferences,
    command,
    list,
    queue,
    readOrder,
    adminData,
    drainPayments,
    drainNotifications,
    waitForIdle: () => Promise.all([draining, notifying]),
    operations,
    recordEvidence,
    dispatch,
    heartbeat,
    maintain,
    inbox,
    unread,
    markRead,
    attention,
  };
}
