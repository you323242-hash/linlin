// Current UI uses local scripts/styles; no inline script, eval or third-party frames.
export function protectResponse(res, config) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), microphone=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  // Initial staging rollout: one day, no subdomain/preload commitment.
  if (config.environment === 'staging') res.setHeader('Strict-Transport-Security', 'max-age=86400');
}
export const isJSON = req => /^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '');
