// View preference only. Server-side participation and permissions remain authoritative.
export function readIdentityView(userId, requested) {
  if (['buyer','provider'].includes(requested)) return requested;
  try { return userId && localStorage.getItem('delta-view:'+userId)==='provider' ? 'provider' : 'buyer'; }
  catch { return 'buyer'; }
}
export function saveIdentityView(userId, role) {
  if (!userId || !['buyer','provider'].includes(role)) return;
  try { localStorage.setItem('delta-view:'+userId,role); } catch { /* Navigation still works with storage disabled. */ }
}

