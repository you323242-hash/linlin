import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PRODUCTS, availableProducts, getProduct, priceText, toggleAvailability } from '../dist/catalog.mjs';

assert.equal(priceText(getProduct('secret').price), '10.88');
assert.equal(priceText(getProduct('topsecret').price), '20.88');
assert.equal(getProduct('missing'), null, 'Unknown routes must not silently select a paid product.');
const withdrawn = PRODUCTS.map(product => ({ ...product, status: product.id === 'secret' ? 'offline' : 'available' }));
assert.deepEqual(availableProducts(withdrawn).map(product => product.id), ['topsecret']);
assert.equal(getProduct('secret', withdrawn), null, 'Withdrawn services cannot remain selectable.');
assert.equal(toggleAvailability('idle', []).state, 'idle');
assert.ok(toggleAvailability('idle', ['invalid']).error);
assert.equal(toggleAvailability('idle', ['secret']).state, 'available');
assert.equal(toggleAvailability('available', ['secret']).state, 'idle');
assert.equal(toggleAvailability('suspended', ['secret']).state, 'suspended', 'Availability must not clear a suspension.');
assert.equal(toggleAvailability('serving', ['secret']).state, 'serving', 'A serving preview cannot enable another slot.');

const dist = path.resolve(import.meta.dirname, '../dist');
for (const name of ['index.html', 'account.html', 'service.html', 'orders.html', 'rules.html', 'teams.html', 'admin.html']) {
  const html = fs.readFileSync(path.join(dist, name), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, `${name}: duplicate document ids`);
  for (const [, href] of html.matchAll(/(?:href|src)="(\.\/[^"?#]+)(?:[?#][^"]*)?"/g)) {
    assert.ok(fs.existsSync(path.resolve(dist, href)), `${name}: missing local resource ${href}`);
  }
  for (const [, target, fragment] of html.matchAll(/<a\b[^>]*href="(\.\/[^"#]*|)\#([^"\s]+)"/g)) {
    const documentPath = target ? path.resolve(dist, target.split('?')[0]) : path.join(dist,name);
    if (!documentPath.endsWith('.html')) continue;
    const linked = fs.readFileSync(documentPath,'utf8');
    assert.ok(linked.includes('id="'+decodeURIComponent(fragment)+'"'), name+': missing anchor '+target+'#'+fragment);
  }
  if (name !== 'rules.html') {
    assert.match(html, /type="module" src="\.\/main\.js\?v=\d+"/);
    assert.match(html, /id="document-dialog"/);
  }
}
const common = fs.readFileSync(path.join(dist, 'main.js'), 'utf8');
assert.doesNotMatch(common, /完成资料审核后/);
const markup = (common + fs.readFileSync(path.join(dist, 'auth-ui.js'), 'utf8')).replaceAll('\\"', '"');
assert.ok(markup.includes('data-login-method="wechat"'));
assert.ok(markup.includes('data-login-method="qq"'));
assert.ok(!/id="registration-consent"[^>]*checked/.test(markup), 'Reading terms must not imply agreement.');
const rules = fs.readFileSync(path.join(dist, 'rules.html'), 'utf8');
assert.match(rules, /注册后即可接单/);
assert.match(rules, /暂停接单仅限制接受新订单/);
assert.match(rules, /人工复核入口/);
console.log('PASS: prices, availability states, unavailable products, local links, consent and rule consistency.');

