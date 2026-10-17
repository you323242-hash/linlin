// Advisory only: accepting a privacy request never depends on these counts.
// No identity, money, order, or moderation state is changed here.
export function inspectClosureDependencies(db, userId) {
  const involved = `o.buyer_id=? OR o.provider_id=?
    OR EXISTS (SELECT 1 FROM order_providers p WHERE p.order_id=o.id AND p.user_id=?)
    OR EXISTS (SELECT 1 FROM released_services r WHERE r.order_id=o.id AND r.user_id=?)`;
  const orders=db.prepare(`SELECT count(*) AS paidOrders,
    coalesce(sum(o.status NOT IN ('completed','cancelled')),0) AS openOrders,
    coalesce(sum(json_extract(o.payload,'$.case.stage') IS NOT NULL
      AND json_extract(o.payload,'$.case.stage')<>'closed'),0) AS openCases,
    coalesce(sum(json_extract(o.payload,'$.payment.status')='refund_pending'
      OR EXISTS (SELECT 1 FROM payment_jobs j WHERE j.order_id=o.id AND j.status<>'done')),0) AS pendingPayments
    FROM orders o WHERE ${involved}`).get(userId,userId,userId,userId);
  const one=sql=>db.prepare(sql).get(userId,userId).n;
  const openTeams=one(`SELECT count(DISTINCT r.id) n FROM team_rooms r
    LEFT JOIN team_members m ON m.room_id=r.id AND m.user_id=? AND m.state IN ('requested','confirmed')
    WHERE r.status='open' AND (r.owner_id=? OR m.user_id IS NOT NULL)`);
  const pendingReports=one("SELECT count(*) n FROM team_reports WHERE status='pending' AND (actor_id=? OR target_id=?)");
  const pendingAppeals=db.prepare("SELECT count(*) n FROM team_appeals WHERE status='pending' AND user_id=?").get(userId).n;
  const ownCount=(table,column)=>db.prepare(`SELECT count(*) n FROM ${table} WHERE ${column}=?`).get(userId).n;
  const role=db.prepare('SELECT role FROM user WHERE id=?').get(userId)?.role;
  return {
    advisoryOnly:true,
    executionAvailable:false,
    counts:{openOrders:orders.openOrders,openCases:orders.openCases,pendingPayments:orders.pendingPayments,openTeams,pendingReports,pendingAppeals},
    footprint:{paidOrders:orders.paidOrders,hostedTeams:ownCount('team_rooms','owner_id'),joinedTeams:ownCount('team_members','user_id'),
      teamMessages:ownCount('team_messages','user_id'),personaPosts:ownCount('persona_posts','user_id'),
      evidenceUploads:ownCount('evidence_files','uploader_id'),privacyRequests:db.prepare('SELECT count(*) n FROM site_feedback WHERE user_id=? AND privacy_kind IS NOT NULL').get(userId).n},
    adminReview:role==='admin'
  };
}
