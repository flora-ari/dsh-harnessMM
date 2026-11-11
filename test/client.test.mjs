import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The client half is a ModuleLoader module, not a package import: it reaches
 * React and the host primitives through the loader's require. This harness
 * supplies both stubs, captures the factory, and drives apply() against a fake
 * client context — no browser, no renderer.
 */

let captured;
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => { captured = definition },
  },
};

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};

const loaded = { require: (specifier) => (specifier === 'react' ? reactStub : {}) };
await import('../client.js');

test('the client module registers under the package id', () => {
  assert.ok(captured, 'window.__ModuleLoader__.load must be called');
  assert.equal(captured.id, 'dsh-harnessmm');
  assert.equal(typeof captured.factory, 'function');
});

function loadPlugin() {
  return captured.factory((specifier) => loaded.require(specifier));
}

test('the client half declares the Cordis client shape', () => {
  const plugin = loadPlugin();
  assert.equal(plugin.name, 'harnessmm');
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms']);
  assert.equal(typeof plugin.apply, 'function');
});

function fakeContext() {
  const registered = [];
  const writes = [];
  const form = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', writable: true, value: { policy: { enabled: true } } }),
    mutate: async (ops) => { writes.push(ops); return true },
  };
  const ctx = {
    effect: (factory) => { factory(); return () => {} },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      },
    },
    configForms: { get: (entryId) => ({ entryId, ...form }) },
  };
  return { ctx, registered, writes };
}

test('apply registers one Settings section row named HarnessMM', () => {
  const { ctx, registered } = fakeContext();
  loadPlugin().apply(ctx);
  assert.equal(registered.length, 1);
  const { options, component } = registered[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'harnessmm');
  assert.equal(typeof options.order, 'number');
  assert.equal(options.locale, 'harnessmm');
  assert.equal(options.label(), 'nav');
  assert.equal(typeof component, 'function');
});

test('the section injects the harnessmm config form', () => {
  const { ctx, registered } = fakeContext();
  loadPlugin().apply(ctx);
  const injected = registered[0].options.inject();
  assert.ok(injected.form, 'the form face must be injected');
  assert.equal(injected.form.entryId, 'harnessmm');
});

test('the switch writes policy.enabled through the shared form', async () => {
  const { ctx, registered, writes } = fakeContext();
  const plugin = loadPlugin();
  plugin.apply(ctx);
  const { form } = registered[0].options.inject();
  const accepted = await plugin.__internals.writePath(form, plugin.__internals.POLICY_PATH, false);
  assert.equal(accepted, true);
  assert.deepEqual(writes, [[{ op: 'set', path: ['policy', 'enabled'], value: false }]]);
});

test('both dictionaries carry the navigation label and the inline prompts', () => {
  const { en, zh } = loadPlugin().__internals;
  for (const dictionary of [en, zh]) {
    assert.equal(dictionary.nav, 'HarnessMM');
    assert.equal(typeof dictionary.enable, 'string');
    assert.equal(typeof dictionary.onHint, 'string');
  }
});
