'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const babel = require('@babel/core');
const { journalStubs } = require('./fixtures/journal-stub');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Exercise the installed browser SDK with isolated storage, no node connection.
global.window = { crypto: require('node:crypto').webcrypto };
const memory = new Map();
global.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) };
global.chrome = { windows: { getCurrent: async () => ({ id: 1 }) } };
const sdk = require('znn-ts-sdk');
const { ethers } = require('ethers');
const root = path.join(__dirname, '..');
const loader = (override = () => undefined) => {
  const cache = new Map();
  const load = (file) => {
    const filename = path.resolve(root, file);
    if (filename.endsWith('.json')) return require(filename); // e.g. contract-call schemas
    if (cache.has(filename)) return cache.get(filename);
    const mod = { exports: {} };
    cache.set(filename, mod.exports);
    const { code } = babel.transformFileSync(filename, {
      presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'],
      babelrc: false, configFile: false,
    });
    const resolve = (name) => {
      const replacement = override(name);
      if (replacement !== undefined) return replacement;
      // The journal has its own suite; see fixtures/journal-stub.js.
      const journaled = journalStubs(name); if (journaled !== undefined) return journaled;
      if (name.startsWith('.')) {
        const target = path.resolve(path.dirname(filename), name);
        return load(path.extname(target) ? target : `${target}.js`);
      }
      return require(name);
    };
    new Function('module', 'exports', 'require', code)(mod, mod.exports, resolve);
    cache.set(filename, mod.exports);
    return mod.exports;
  };
  return load;
};
const load = loader();
const { withBaseTokens, fetchBalances } = load('src/services/wallet/account.js');
const { znnZts, qsrZts, normalizeBaseUnits, authorizationMetadata, parseTransferAmount, prepareTransfer } = load('src/services/wallet/tokenMetadata.js');
const { parseAmount } = load('src/services/utils/format.js');
const TokenAmount = load('src/components/token-amount/token-amount.js').default;
const custom = new sdk.Primitives.TokenStandard(Buffer.alloc(10, 7)).toString();
const recipient = 'z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f';
const enough = ethers.BigNumber.from('100000000000000000000');
const entry = (zts, decimals, symbol = 'FORGED') => ({ balance: enough, token: { tokenStandard: zts, decimals, symbol, name: 'Forged name', verified: true } });

// Render the actual Send/approval component, controlling only browser hooks and
// side effects. The real policy, amount component, and SDK constructors execute.
const view = ({ file, states, account }) => {
  let cursor = 0;
  let refCursor = 0;
  let modal;
  const refs = [];
  const sent = [];
  const errors = [];
  const rules = {};
  const effects = [];
  const mockReact = { ...React,
    useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useRef: initial => { const i = refCursor++; return refs[i] ??= { current: initial }; },
    // Recorded, not run: a test runs the one it means (see prepare below).
    useMemo: fn => fn(), useEffect: (fn, deps) => { effects.push({ fn, deps }); }, useCallback: fn => fn,
    useContext: () => ({ openModal: value => { modal = value; } }),
  };
  const Component = loader(name => {
    if (name === 'react') return mockReact;
    if (name === 'react-router-dom') return { useNavigate: () => () => {}, useLocation: () => ({}) };
    if (name === 'react-redux') return { useSelector: fn => fn({ wallet: { address: account.address, isUnlocked: true }, connectionParameters: { chainIdentifier: 1, nodeUrl: 'wss://example.invalid' } }) };
    if (name === 'react-hook-form') return { useForm: () => ({ register: (name, options) => { rules[name] = options; return { name }; }, handleSubmit: fn => fn, formState: { errors: {} }, reset: () => {}, setValue: () => {}, trigger: () => {} }) };
    if (name.endsWith('/hooks/useAccount')) return () => account;
    if (name.endsWith('/hooks/useBackgroundSender')) return () => ({ sendInBackground: template => sent.push(template) });
    // A prepared block approval (#4) is signed as prepared: record that block.
    if (name.endsWith('/hooks/useBlockSender')) return () => ({ send: async (template, options = {}) => {
      const signed = template ?? options.prepared.block; sent.push(signed); return signed; }, isSending: false, isGeneratingPlasma: false });
    if (name.endsWith('/hooks/modal/modalContext')) return { ModalContext: {} };
    // Requests reach the approval screen bound to a wallet account (#11); the
    // stand-in vault is on that same selection.
    if (name === './vault' || name.endsWith('/wallet/vault')) return { getBinding: () => fixtureBinding, getKeyPair: () => fixtureKey,
      whileBound: async (_, operation) => operation(), isUnlocked: () => true, getWalletName: () => 'fixture' };
    if (name.endsWith('/wallet/signMessage')) return {};
    // The approval screen claims a request before signing (single-use request
    // identities); the stand-in worker grants the claim and accepts the result.
    if (name.endsWith('/utils/messaging')) return { sendInternal: async (type, params) => {
      // A well-formed next request: an invalid one is now a reported error (#11).
      if (type === 'approvals.next') return { version: 4, id: 'next', type: 'connect', params: {}, origin: 'https://example.invalid',
        tabId: 1, frameId: 0, documentId: 'doc', responseId: 1, title: '', favicon: '', createdAt: Date.now(),
        expiresAt: Date.now() + 600000, admitted: null, waitForUnlock: false, binding: fixtureBinding,
        ...require('./fixtures/document-binding-stub').documentFields() };
      if (type === 'approvals.claim') return { ...params.identity, claimId: 'fixture-claim' };
      if (type === 'approvals.checkClaim' || type === 'approvals.resolve') return true;
      return null;
    } };
    if (name.endsWith('/utils/notify')) return { notify: { error: err => errors.push(err), success: () => {} } };
    if (name.includes('/components/modals/') || name.includes('/components/custom-dropdown/')) return () => null;
    return undefined;
  })(file).default;
  // Runs the approval screen's block preparation for the rendered request.
  const prepare = async () => {
    const effect = effects.filter(item => item.deps?.length === 4 && item.deps[0] === states[0]).at(-1);
    effect.fn(); for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve));
  };
  return { render: () => { cursor = 0; refCursor = 0; effects.length = 0; return Component(); }, prepare, sent, errors, rules, modal: () => modal };
};
// The bound account's key, and a node whose account has no blocks yet.
const fixtureKey = { getAddress: async () => sdk.Primitives.Address.parse('z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f'), getPublicKey: async () => Buffer.alloc(32, 7) };
sdk.Zenon.getSingleton().ledger.getFrontierBlock = async () => null;
sdk.Zenon.getSingleton().ledger.getFrontierMomentum = async () => ({ height: 1, hash: sdk.Primitives.Hash.parse('00'.repeat(32)) });
const fixtureBinding = Object.freeze({ id: 'fixture-selection', ownerId: 'owner', scope: Object.freeze({
  walletName: 'fixture', walletId: 'z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f', address: 'z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f', index: 0 }) });
const elements = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(elements) : [tree, ...elements(tree.props?.children)];
const sendFile = 'src/pages/send-receive/send/send.js';
const approvalFile = 'src/layouts/siteIntegrationLayout/siteIntegrationLayout.js';

(async () => {
  for (const decimals of [0, 10, 30, '10', undefined]) {
    const rpc = { [znnZts]: entry(custom, decimals), [qsrZts]: entry(znnZts, decimals) };
    const { balanceMap } = await fetchBalances({ ledger: { getAccountInfoByAddress: async () => ({ balanceInfoMap: rpc }) } }, {});
    for (const [zts, symbol] of [[znnZts, 'ZNN'], [qsrZts, 'QSR']]) {
      assert.equal(balanceMap[zts].token.decimals, 8);
      assert.equal(balanceMap[zts].token.symbol, symbol);
      assert.equal(balanceMap[zts].token.tokenStandard, zts);
      assert.equal(balanceMap[zts].balance, enough);
      assert(Object.isFrozen(balanceMap[zts].token));
    }
    const destination = sdk.Primitives.Address.parse(recipient);
    const send = sdk.Primitives.AccountBlockTemplate.send(destination, sdk.Primitives.TokenStandard.parse(znnZts), parseAmount('1.00000001', balanceMap[znnZts].token.decimals));
    const stake = sdk.Zenon.getSingleton().embedded.stake.stake(2592000, parseAmount('1', balanceMap[znnZts].token.decimals));
    const fuse = await sdk.Zenon.getSingleton().embedded.plasma.fuse(destination, parseAmount('10.12345678', balanceMap[qsrZts].token.decimals));
    assert.equal(send.amount.toString(), '100000001');
    assert.equal(stake.amount.toString(), '100000000');
    assert.equal(fuse.amount.toString(), '1012345678');
    rpc[znnZts].token.decimals = 1;
    assert.equal(balanceMap[znnZts].token.decimals, 8);
  }
  assert.equal(withBaseTokens({})[znnZts].balance, 0);
  assert.equal(withBaseTokens({ [znnZts.toUpperCase()]: entry(custom, 30) })[znnZts].token.decimals, 8);
  assert.throws(() => withBaseTokens({ [custom]: entry(znnZts, 8) }));
  assert.throws(() => withBaseTokens({ invalid: entry(custom, 8) }));
  assert.throws(() => withBaseTokens({ [custom]: entry(custom, 8), [custom.toUpperCase()]: entry(custom, 8) }));
  assert.throws(() => withBaseTokens({ [custom]: entry(custom, JSON.parse('{"type":"BigNumber","hex":"0x08","toString":"invalid"}')) }), /invalid token decimals/);
  assert.equal(withBaseTokens({ [custom]: entry(custom, '8') })[custom].token.decimals, 8);
  assert.equal(authorizationMetadata(custom).isNative, false);
  for (const input of ['1.1', '1.0', '1e3', '-1', '.', '']) assert.equal(parseTransferAmount(input, custom), null);
  const exact = '9007199254740993';
  assert.equal(parseTransferAmount(exact, custom).toString(), exact);
  const snapshot = prepareTransfer({ tokenStandard: custom, amount: exact, recipient, owner: recipient, balance: enough });
  assert(Object.isFrozen(snapshot));
  assert.equal(snapshot.amount, exact);
  assert.throws(() => { snapshot.amount = '1'; }, TypeError);

  for (const [zts, amount, expected] of [[znnZts, '1.00000001', '100000001'], [custom, exact, exact]]) {
    const rpc = { [zts]: entry(zts, 30, 'ZNN') };
    const account = { address: recipient, ...await fetchBalances({ ledger: { getAccountInfoByAddress: async () => ({ balanceInfoMap: rpc }) } }, {}) };
    const page = view({ file: sendFile, states: [zts, amount, recipient], account });
    elements(page.render()).find(el => el.type === 'form').props.onSubmit();
    const modal = page.modal();
    const html = renderToStaticMarkup(modal.props.children);
    assert(html.includes(zts));
    assert(html.includes(expected));
    if (zts === custom) assert(html.includes('base units') && html.includes('Unverified'));
    else assert(html.includes('1.00000001 ZNN'));
    rpc[zts].token.decimals = 0;
    rpc[zts].token.tokenStandard = qsrZts;
    page.render();
    modal.props.onSuccess();
    assert.equal(page.sent.length, 1);
    assert.equal(page.sent[0].amount.toString(), expected);
    assert.equal(page.sent[0].tokenStandard.toString(), zts);
    assert.equal(page.sent[0].toAddress.toString(), recipient);
    assert.equal(page.errors.length, 0);
  }
  const account = { address: recipient, balanceMap: withBaseTokens({ [custom]: entry(custom, 10) }), balances: [] };
  const invalid = view({ file: sendFile, states: [custom, '1.2', recipient], account });
  elements(invalid.render()).find(el => el.type === 'form').props.onSubmit();
  assert.equal(invalid.modal(), undefined);
  assert.equal(invalid.sent.length, 0);
  const switched = view({ file: sendFile, states: [custom, '1', recipient], account });
  elements(switched.render()).find(el => el.type === 'form').props.onSubmit();
  const modal = switched.modal();
  account.address = 'different account';
  switched.render();
  modal.props.onSuccess();
  assert.equal(switched.sent.length, 0);

  for (const type of ['sendTransaction', 'signAndSendBlock']) {
    for (const zts of [znnZts, custom]) {
      for (const destination of [recipient, 'z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp']) {
        const amount = zts === custom ? exact : '100000001';
        // A complete block template, as a site sends one, with the amount and
        // token under test; `to` serves the plain-transfer request shape.
        const block = sdk.Primitives.AccountBlockTemplate.send(sdk.Primitives.Address.parse(destination), sdk.Primitives.TokenStandard.parse(zts), ethers.BigNumber.from(1)).toJson();
        const request = { id: 'fixture', expiresAt: Date.now() + 600000, binding: fixtureBinding, type, origin: 'https://example.invalid', params: { ...block, amount, tokenStandard: zts, to: destination, toAddress: destination } };
        // Deliberately supply hostile metadata directly, bypassing normalization:
        // amount rendering must enforce its own trust boundary too.
        const page = view({ file: approvalFile, states: [request, null, false, false], account: { address: recipient, balanceMap: { [zts]: entry(zts, 30, 'FORGED') } } });
        if (type === 'signAndSendBlock') { page.render(); await page.prepare(); }
        const html = renderToStaticMarkup(page.render());
        assert(html.includes(zts));
        assert(html.includes(amount));
        assert(!html.includes('FORGED'));
        assert(html.includes(zts === custom ? 'base units' : '1.00000001 ZNN'));
      }
    }
  }
  // The SDK accepts hex and BigNumberish quantities. The display and the
  // actual signing handlers must normalize each to the same integer units.
  for (const type of ['sendTransaction', 'signAndSendBlock']) {
    for (const amount of ['0x05f5e100', '0100000000', 100000000, ethers.BigNumber.from(100000000), { type: 'BigNumber', hex: '0x05f5e100' }]) {
      assert.equal(normalizeBaseUnits(amount), '100000000');
      const params = { ...sdk.Primitives.AccountBlockTemplate.send(sdk.Primitives.Address.parse(recipient), sdk.Primitives.TokenStandard.parse(znnZts), ethers.BigNumber.from(1)).toJson(), to: recipient, amount };
      const request = { id: 'encoded', expiresAt: Date.now() + 600000, binding: fixtureBinding, type, params };
      const page = view({ file: approvalFile, states: [request, null, false, false], account: { address: recipient, balanceMap: withBaseTokens({ [znnZts]: entry(znnZts, 30) }) } });
      if (type === 'signAndSendBlock') { page.render(); await page.prepare(); }
      const tree = page.render();
      assert(renderToStaticMarkup(tree).includes('1.0 ZNN'));
      const button = elements(tree).find(el => el.type === 'button' && el.props.children !== 'Reject');
      assert.equal(button.props.disabled, false);
      await button.props.onClick();
      assert.equal(page.sent.length, 1);
      assert.equal(page.sent[0].amount.toString(), '100000000');
      assert.equal(page.errors.length, 0);
    }
    for (const amount of ['-1', '-0x01', '1.1', '1e8', '', null, undefined, Number.MAX_SAFE_INTEGER + 1, { toString: 'invalid' }]) {
      assert.throws(() => normalizeBaseUnits(amount));
      const request = { id: 'invalid', expiresAt: Date.now() + 600000, binding: fixtureBinding, type, params: { to: recipient, tokenStandard: znnZts, amount } };
      const page = view({ file: approvalFile, states: [request, null, false, false], account: { address: recipient, balanceMap: withBaseTokens({ [znnZts]: entry(znnZts, 8) }) } });
      if (type === 'signAndSendBlock') { page.render(); await page.prepare(); }
      const tree = page.render();
      const button = elements(tree).find(el => el.type === 'button' && el.props.children !== 'Reject');
      assert.equal(button.props.disabled, true);
      await button.props.onClick(); // final handler also refuses a bypassed UI
      assert.equal(page.sent.length, 0);
      // An arbitrary block that cannot be prepared is refused at preparation,
      // visibly, and a bypassed click has nothing to sign.
      if (type === 'signAndSendBlock') assert.match(renderToStaticMarkup(tree), /Unable to prepare this block/);
      else assert.equal(page.errors.length, 1);
    }
  }
  assert(renderToStaticMarkup(React.createElement(TokenAmount, { amount: { toString: 'invalid' }, tokenStandard: 'invalid' })).includes('Invalid amount'));
  console.log('token metadata: canonical SDK units, integer custom sends, immutable confirmations, identity validation and both dApp displays passed');
})().catch(err => { console.error(String(err)); console.error(err.stack?.split('\n').slice(0,5).join('\n')); process.exitCode = 1; });
