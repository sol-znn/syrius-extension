'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const babel = require('@babel/core');
const React = require('react');
const { createFormControl } = require('react-hook-form');

const writes = [];
const errors = [];
const store = { entropy: 'fixture entropy', mnemonic: 'one two' };
let correctCurrentPassword = true;
const sdk = {
  KeyStore: class {
    fromEntropy(entropy) { return { ...store, entropy }; }
    fromMnemonic() { return store; }
  },
  KeyStoreManager: class {
    async saveKeyStore(...args) { writes.push(args); return 'saved'; }
    async getNewKeystore() { return store; }
  },
};

const load = (file, resolve) => {
  const { code } = babel.transformFileSync(path.join(__dirname, '..', file), {
    presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'],
    babelrc: false,
    configFile: false,
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, resolve);
  return mod.exports;
};
const policy = load('src/services/wallet/password.js', (name) => {
  assert.equal(name, 'znn-ts-sdk');
  return sdk;
});
const weak = ['abc123', 'abcDEF', 'ABC123', 'A1!abcd', 'Abc12345', 'abcd123!', 'ABCD123!', 'Abcdefg!', 'Ab1!'];
const strong = ['Abcd123!', 'A longer 123! password', 'Abcd123! '];

// Execute real form components with controlled hook state; the actual installed
// React Hook Form validates their registered rules (including result types).
const page = (file, initial) => {
  let cursor = 0;
  const states = [...initial];
  const form = createFormControl();
  form.subscribe({ formState: { values: true }, callback: () => {} });
  const Component = load(file, (name) => {
    if (name === 'react') return { ...React, useState: (value) => {
      const index = cursor++;
      if (!(index in states)) states[index] = value;
      return [states[index], (next) => { states[index] = next; }];
    }, useMemo: (fn) => fn() };
    if (name === 'react-hook-form') return { useForm: () => ({ ...form, formState: { errors: {} }, handleSubmit: (fn) => fn }) };
    if (name === 'react-router-dom') return { useNavigate: () => () => {} };
    if (name === 'react-redux') return { useDispatch: () => () => {}, useSelector: () => 'test-wallet' };
    if (name === 'znn-ts-sdk') return sdk;
    if (name.endsWith('/wallet/password')) return policy;
    // Password change commits through vault.changePassword, which applies the
    // same policy module at the encrypted-wallet write (asserted against the
    // real vault in live-vault-test). This stand-in keeps that order: prove
    // the current password, apply the policy, then write.
    if (name.endsWith('/wallet/vault')) return {
      verifyPassword: async () => correctCurrentPassword, getEntropy: () => store.entropy,
      capture: () => ({}), isCurrent: () => true,
      changePassword: async (current, next) => {
        if (!correctCurrentPassword) return false;
        const validation = policy.validateWalletPassword(next);
        if (validation !== true) throw new Error(validation);
        writes.push([{ ...store }, next, 'test-wallet']);
        return true;
      },
    };
    if (name.endsWith('/wallet/session')) return { touch: async () => {} };
    if (name.endsWith('/wallet/bootstrap')) return { completeUnlock: async () => {} };
    if (name.endsWith('/utils/notify')) return { notify: { success: () => {}, error: (err) => errors.push(err) } };
    if (name.endsWith('/utils/utils')) return { loadStorageWalletNames: () => [], sanitizeWalletName: (s) => s, arrayShuffle: (s) => s };
    return () => null;
  }).default;
  const render = () => { cursor = 0; return Component(); };
  return { render, form, states };
};
const elements = (tree) => {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return [tree, ...elements(tree.props?.children)];
};
const pages = [
  ['src/pages/get-started/get-started.js', [0, 'test-wallet', '', ''], 'passwordField'],
  ['src/pages/import-recovery/recovery.js', [1, 'one two', 'test-wallet', '', ''], 'passwordField'],
  ['src/pages/settings/change-password/change-password.js', ['old', '', '', false], 'newPasswordField'],
];

(async () => {
  for (const [file, initial, field] of pages) {
    const view = page(file, initial);
    view.render();
    for (const password of weak) {
      view.form.setValue(field, password);
      assert.equal(await view.form.trigger(field), false, `${file} accepted a weak password`);
      assert.equal(view.form.getFieldState(field).error.message, policy.passwordCriteria);
    }
    for (const password of strong) {
      view.form.setValue(field, password);
      assert.equal(await view.form.trigger(field), true, `${file} rejected a strong password`);
    }
  }
  for (const password of [...weak, null, undefined, 12345678, { toString: () => 'Abcd123!' }]) {
    await assert.rejects(policy.saveWalletWithPassword(store, password, 'test-wallet'), { message: policy.passwordCriteria });
  }
  assert.equal(writes.length, 0, 'invalid input reached the SDK writer');
  for (const password of strong) {
    assert.equal(await policy.saveWalletWithPassword(store, password, 'test-wallet'), 'saved');
    assert.deepEqual(writes.at(-1), [store, password, 'test-wallet']);
  }
  writes.length = 0;

  // Bypass form validation and invoke every production persistence callback.
  // This also covers creation's separate final confirmation button.
  for (const password of ['abc123', 'Abcd123!']) {
    const create = page(pages[0][0], [2, 'test-wallet', password, password, store, 'one two', [], ['one', 'two']]);
    await elements(create.render()).find((el) => el.type === 'button' && el.props.onClick).props.onClick();
    const recover = page(pages[1][0], [1, 'one two', 'test-wallet', password, password]);
    await elements(recover.render()).find((el) => el.type === 'form').props.onSubmit();
    const change = page(pages[2][0], ['legacy-weak', password, password, false]);
    await elements(change.render()).find((el) => el.type === 'form').props.onSubmit();
    assert.equal(writes.length, password === 'abc123' ? 0 : 3);
  }
  assert.equal(errors.length, 3);
  assert(writes.every(([saved, password, name]) => saved.entropy === store.entropy && password === 'Abcd123!' && name === 'test-wallet'));
  correctCurrentPassword = false;
  const denied = page(pages[2][0], ['wrong', 'Abcd123!', 'Abcd123!', false]);
  await elements(denied.render()).find((el) => el.type === 'form').props.onSubmit();
  assert.equal(writes.length, 3, 'wrong current password reached the writer');

  const change = page(pages[2][0], ['old', 'Abcd123!', 'Abcd123!', false]);
  const inputs = elements(change.render()).filter((el) => el.type === 'input');
  for (const input of inputs) {
    input.props.onChange({ target: { value: 'abc123' } });
    assert.equal(change.form.getValues(input.props.name), 'abc123', 'form state did not follow typing');
  }
  assert.equal(await change.form.trigger('newPasswordField'), false);
  console.log('password policy: form rules, bypassed submits, weak-password rejection, exact forwarding and current-password proof passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
