import test from 'node:test';
import assert from 'node:assert/strict';
import { mountProjectLetter, projectLetter } from '../dist/project-letter.mjs';

test('介绍信无需登录即可展示，保留关闭后的跨页状态和手动入口', () => {
  const originalDocument = globalThis.document, originalStorage = globalThis.sessionStorage;
  const saved = new Map();
  let busy = false, opens = 0, trigger, closeListener;
  globalThis.sessionStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  globalThis.document = {
    querySelector: selector => selector === 'footer nav' ? { prepend: button => { trigger = button; } } : busy,
    createElement: () => ({ addEventListener: (event, fn) => { if (event === 'click') triggerClick = fn; } }),
    addEventListener: (event, fn) => { closeListener = fn; },
    removeEventListener: () => { closeListener = null; },
  };
  let triggerClick;
  const show = (title, html, focus) => {
    assert.equal(title, '致面试官的一封信'); assert.equal(html, projectLetter); if (focus) assert.equal(focus, trigger); opens++;
  };
  try {
    busy = true;
    mountProjectLetter(show); assert.equal(opens, 0);
    busy = false; closeListener(); assert.equal(opens, 1); assert.equal(closeListener, null);
    mountProjectLetter(show); assert.equal(opens, 1, '刷新或跨页不重复弹出');
    triggerClick(); assert.equal(opens, 2, '关闭后仍可从页脚打开');
    saved.clear(); mountProjectLetter(show); assert.equal(opens, 3, '新访问会话会自动弹出');
    globalThis.sessionStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
    assert.doesNotThrow(() => mountProjectLetter(show));
    assert.equal(opens, 4);
  } finally { globalThis.document = originalDocument; globalThis.sessionStorage = originalStorage; }
});
