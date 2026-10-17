import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../dist/main.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
class Node {
  constructor() { this.dataset = {}; this.attrs = {}; this.events = {}; this.textContent = ''; }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; if (name === 'href') delete this.href; }
  querySelector() { return null; }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
  focus() {}
}
class Card extends Node {
  constructor() { super(); this.nodes = Object.fromEntries(['.mode-heading h2', '.mode-code', '.card-art', '.price strong', '.equipment strong', '.select-button'].map(key => [key, new Node()])); this.nodes['.select-button'].label = new Node(); this.nodes['.select-button'].querySelector = () => this.nodes['.select-button'].label; this.nodes['.select-button'].href = '/old-price'; }
  querySelector(key) { return this.nodes[key]; }
  cloneNode() { return new Card(); }
}
function setup() {
  let resolve, reject, calls = 0, authCalls = 0, mounted = 0, products = [];
  const pending = new Promise((a,b) => { resolve = a; reject = b; });
  const dialog = new Node(), title = new Node(), content = new Node(), rules = new Node(), account = new Node(), help = new Node(), close = new Node(), grid = new Node();
  account.dataset.panel = 'account'; help.dataset.panel = 'help'; grid.cards = [new Card(),new Card()];
  grid.querySelector = () => grid.cards[0];
  grid.querySelectorAll = selector => grid.cards.map(card => card.querySelector(selector === '.select-button' ? selector : '.price strong'));
  grid.replaceChildren = (...cards) => { grid.cards = cards; };
  const nodes = { '#preview-dialog': dialog, '#dialog-title': title, '#dialog-content': content, '#document-dialog': rules, '#document-title': new Node(), '#document-content': new Node(), '#document-full-link': new Node(), '.price-grid': grid };
  const document = { querySelector: selector => nodes[selector] || null, querySelectorAll: selector => selector === '[data-panel]' ? [account,help] : selector === '#close-dialog, #dismiss-dialog' ? [close] : [], addEventListener() {} };
  const context = { document, paidOrdersAvailable: () => true, refreshProducts: () => { calls++; return pending.then(value => { products = value; }); }, availableProducts: () => products, priceText: cents => (cents/100).toFixed(2), serviceHref: id => '/service.html?mode='+id, initializeAuth: () => { authCalls++; }, mountAuthPanel: () => { mounted++; }, accountTitle: () => '登录', accountPanel: () => '<form>登录</form>' };
  context.mountProjectLetter = () => {};
  vm.runInNewContext(source, context);
  return { dialog,title,content,account,help,close,grid, resolve,reject, calls: () => calls, authCalls: () => authCalls, mounted: () => mounted };
}
const product = { id:'secret', title:'机密行动', shortTitle:'机密',price:1234,gear:4,status:'available' };
test('商品延迟时账户和关闭可操作，认证立即初始化且价格入口关闭', async () => {
  const app = setup();
  assert.equal(app.calls(),1); assert.equal(app.authCalls(),1);
  await app.account.events.click(); assert.equal(app.dialog.open,true); assert.equal(app.mounted(),1);
  app.close.events.click(); assert.equal(app.dialog.open,false);
  for(const card of app.grid.cards) { assert.equal(card.querySelector('.select-button').href,undefined); assert.equal(card.querySelector('.select-button').attrs['aria-disabled'],'true'); assert.equal(card.querySelector('.price strong').textContent,'—'); }
  await app.help.events.click(); assert.match(app.content.innerHTML,/正在读取服务列表/);
  app.resolve([product]); await tick();
  assert.equal(app.grid.cards.length,1); assert.equal(app.grid.cards[0].querySelector('.price strong').innerHTML,'12<span class="decimal">.34</span>');
  assert.equal(app.grid.cards[0].querySelector('.select-button').href,'/service.html?mode=secret');
  assert.equal(app.grid.cards[0].querySelector('.select-button').attrs['aria-disabled'],undefined);
  await app.help.events.click(); assert.match(app.content.innerHTML,/12.34/); assert.doesNotMatch(app.content.innerHTML,/正在读取/);
});
test('目录失败清除卡片和旧价，不影响登录或帮助；刷新恢复取新价',async()=>{
  const app=setup(); app.reject(new Error('offline')); await tick();
  assert.equal(app.grid.cards.length,0); assert.match(app.grid.textContent,/无法读取/);
  await app.account.events.click(); assert.equal(app.dialog.open,true);
  await app.help.events.click(); assert.match(app.content.innerHTML,/暂时不可用/); assert.doesNotMatch(app.content.innerHTML,/10.88|20.88/);
  const next=setup(); next.resolve([product]); await tick(); assert.equal(next.grid.cards.length,1);
  await next.help.events.click(); assert.match(next.content.innerHTML,/12.34/);
});
test('业务页复用同一目录Promise，失败时阻止下单',async()=>{
  const text=readFileSync(new URL('../dist/business-ui.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(text,/refreshProducts/);
  const prefix=text.slice(0,text.indexOf("if (!catalogError && $('#account-workspace'))")).replace(/^import .*;\r?\n/gm,'');
  let resolve; const catalogReady=new Promise(done=>{resolve=done;}); const workspace={innerHTML:''};
  const document={querySelector:selector=>selector==='#service-workspace'?workspace:null};
  const task=vm.runInNewContext('(async()=>{'+prefix+'})()',{document,catalogReady,availableProducts:()=>[]});
  assert.equal(workspace.innerHTML,''); resolve(new Error('offline')); await task;
  assert.match(workspace.innerHTML,/服务资料暂时无法读取/); assert.doesNotMatch(workspace.innerHTML,/创建订单/);
  assert.match(readFileSync(new URL('../dist/service.html',import.meta.url),'utf8'),/id="preview-selection" disabled/);
});
