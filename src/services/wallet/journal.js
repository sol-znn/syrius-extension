import { Zenon } from 'znn-ts-sdk';
import vault from './vault';

// The record of what this wallet has signed and sent, and whose turn it is.
//
// A send used to be one SDK call that read the account's frontier, mined,
// signed and published, and kept nothing. A reply lost after that left no way
// to tell "never sent" from "sent and accepted", and the only retry on offer
// signed a second block. Three callers did this with no knowledge of each
// other: the wallet's own sends, receives, and the approval window.
//
// So the signed block is written here before it is sent, and afterwards the
// wallet only ever looks that hash up or sends those same bytes again. The node
// treats an identical block as a no-op (go-zenon chain/account_pool.go), which
// is what makes the resend safe; a second signature is a second block.
//
// The same record carries one reservation per account and network, so the
// three callers take turns. The reservation is a stored revision, checked
// again at the moment of sending: the cross-window lock is held only for the
// local read-modify-write, never across proof of work or a node call.
//
// Records are AES-256-GCM under a key derived from the wallet's own seed, in
// the popup's localStorage. A locked wallet cannot read them, the service
// worker cannot reach them at all, and a password change does not touch them.

const state = Object.freeze({
  // Recorded, and sending has begun. Until the node answers this is also what
  // an unknown outcome looks like.
  publishing: 'publishing',
  // The node returned success. Not final: a pooled block can still be displaced.
  accepted: 'accepted',
  // The configured node reports this hash inside a momentum.
  observed: 'observed',
  // Nothing landed: the node refused it, or it was never sent.
  rejected: 'rejected',
  // A different block is confirmed at this height, so this one never can be.
  superseded: 'superseded',
});
const resolved = new Set([state.observed, state.rejected, state.superseded]);

const version = 1;
const storagePrefix = 'syrius.journal.';
const lockName = 'syrius.journal';
const maxRecordsPerAccount = 100;
const retentionMs = 24 * 60 * 60 * 1000;
const reservationMs = 60 * 1000;
const renewMs = 20 * 1000;
// A send may have to sit out one block's proof of work, which is minutes on a
// slow machine with no fused plasma.
const defaultWaitMs = 5 * 60 * 1000;
// How long a waiting send's place in the queue lasts without being renewed. It
// renews at every poll, so this only matters for a window that has gone away.
const waiterMs = 3 * 1000;
// The SDK's publish call has no timeout of its own, and a dropped connection
// can leave it pending for good. Past this the outcome is unknown, the turn is
// given back, and the record is what settles it.
const defaultReplyMs = 30 * 1000;
// Lookups, and the resend, when settling records: the same call with no
// timeout, and a wallet that cannot say what it is waiting for helps nobody.
const defaultRpcMs = 10 * 1000;
const pollMs = 400;

const fail = (code, message) => Object.assign(new Error(message), { code });
const unavailable = () => fail('JOURNAL_UNAVAILABLE',
  'This wallet\'s transaction records could not be read. Nothing was sent.');
const unresolvedError = () => fail('JOURNAL_UNRESOLVED',
  'An earlier transaction from this account has an unknown outcome. The wallet is checking it; nothing new was signed.');
const busyError = () => fail('JOURNAL_BUSY',
  'Another transaction from this account is still being sent. Try again in a moment.');
const fullError = () => fail('JOURNAL_FULL',
  `This account has ${maxRecordsPerAccount} transactions on record that are not settled yet. Wait for them to confirm.`);
const staleError = () => fail('JOURNAL_STALE',
  'This account\'s turn to send passed to another window. Nothing was sent.');
const unknownOutcome = () => fail('JOURNAL_UNKNOWN_OUTCOME',
  'The transaction was sent but the node did not answer. The wallet will check its outcome; do not send it again.');

const encoder = new TextEncoder(), decoder = new TextDecoder();
const toBase64 = (bytes) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
const fromBase64 = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomId = () => toHex(crypto.getRandomValues(new Uint8Array(12)));

// One derivation per unlock. The storage key is derived too, so the name the
// ciphertext is filed under says nothing about which wallet it belongs to, and
// two imports of one seed share one journal, as they share one account chain.
let cached = null;
const material = async () => {
  const scope = vault.capture();
  if (cached && cached.scope.id === scope.id && cached.scope.generation === scope.generation) return cached;
  const entropy = await vault.getEntropy();
  if (typeof entropy !== 'string' || !entropy) throw unavailable();
  const base = await crypto.subtle.importKey('raw', encoder.encode(entropy), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const derive = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('syrius.transaction-journal'), info: encoder.encode(info) });
  const key = await crypto.subtle.deriveKey(derive('records/v1'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const tag = new Uint8Array(await crypto.subtle.deriveBits(derive('storage-key/v1'), base, 128));
  if (!vault.isCurrent(scope)) throw unavailable();
  cached = Object.freeze({ scope, key, storageKey: storagePrefix + toHex(tag) });
  return cached;
};
vault.onLock(() => { cached = null; });

const empty = () => ({ version, records: [], reservations: {} });
const read = async ({ key, storageKey }) => {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) return empty();
  try {
    const stored = JSON.parse(raw);
    // A record written by a newer wallet is not ours to reinterpret.
    if (stored?.version !== version) throw unavailable();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(stored.iv) }, key, fromBase64(stored.data));
    const value = JSON.parse(decoder.decode(plain));
    if (value?.version !== version || !Array.isArray(value.records) ||
        !value.reservations || typeof value.reservations !== 'object') throw unavailable();
    return value;
  } catch (error) { throw unavailable(); }
};
const write = async ({ key, storageKey }, value) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value))));
  localStorage.setItem(storageKey, JSON.stringify({ version, iv: toBase64(iv), data: toBase64(data) }));
};
const prune = (value, now) => {
  value.records = value.records.filter((record) => !resolved.has(record.state) || now - record.updatedAt < retentionMs);
  for (const [account, reservation] of Object.entries(value.reservations)) {
    if (reservation.expiresAt <= now) {
      // Keep the revision: a returning stale owner must not match a fresh turn.
      value.reservations[account] = { revision: reservation.revision, owner: null, expiresAt: 0 };
    }
  }
};
// The lock covers local crypto and a localStorage write. Key material is
// derived before taking it: that goes through the session lease's own lock.
const transact = async (operation) => {
  const keys = await material();
  return navigator.locks.request(lockName, async () => {
    const value = await read(keys);
    const now = Date.now();
    prune(value, now);
    const result = operation(value, now);
    await write(keys, value);
    return result;
  });
};

// A chain identifier is not an identity: every go-zenon devnet is 69. The first
// momentum's hash is what two nodes on one network agree on. The node URL is
// deliberately left out, so changing endpoint on the same network keeps the
// records, and a different network leaves them parked.
const networks = new WeakMap();
const rpcOf = (zenon) => zenon?.ledger?.client;
const networkOf = async (zenon, rpcMs) => {
  const client = rpcOf(zenon)?._wsRpc2Client || rpcOf(zenon);
  if (!client) throw fail('JOURNAL_OFFLINE', 'The wallet node is not connected.');
  const chain = Zenon.getChainIdentifier();
  const known = networks.get(client);
  if (known?.chain === chain) return known.id;
  const response = await ask(zenon, 'ledger.getMomentumsByHeight', [1, 1], rpcMs);
  const hash = response?.list?.[0]?.hash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) throw fail('JOURNAL_OFFLINE', 'The node did not identify its network.');
  const id = `${chain}:${hash.toLowerCase()}`;
  networks.set(client, { chain, id });
  return id;
};
const ask = (zenon, method, params, ms = defaultRpcMs) => {
  let timer;
  const silence = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('The node did not answer.')), ms); });
  const call = Promise.resolve().then(() => rpcOf(zenon).sendRequest(method, params));
  call.catch(() => {}); silence.catch(() => {});
  return Promise.race([call, silence]).finally(() => clearTimeout(timer));
};
const accountKey = (network, address) => `${network}/${address}`;

// What the node itself said no to, as opposed to an answer that never came. A
// JSON-RPC error object carries a numeric code; a timeout or a dropped socket
// is an Error without one. `socket not ready` never left this machine.
const refusal = (error) => {
  if (error && typeof error.code === 'number' && typeof error.message === 'string') return error.message;
  if (error?.message === 'socket not ready') return 'The node connection was closed before sending.';
  return null;
};

const update = (id, from, changes) => transact((value, now) => {
  const record = value.records.find((item) => item.id === id);
  if (!record || !from.includes(record.state)) return null;
  Object.assign(record, changes, { updatedAt: now });
  return { ...record };
});

// Settles what can be settled for one account, by asking the node about the
// original hashes. It never signs. It resends only bytes already recorded.
const reconcile = async (zenon, address, { only, rpcMs } = {}) => {
  const network = await networkOf(zenon, rpcMs);
  const keys = await material();
  const pending = (await read(keys)).records
    .filter((record) => record.network === network && record.address === address && !resolved.has(record.state) &&
      (!only || only.includes(record.state)))
    // Parents first: a resent child is refused while its parent is missing.
    .sort((left, right) => left.height - right.height);
  for (const record of pending) {
    const from = [state.publishing, state.accepted];
    const listed = await ask(zenon, 'ledger.getAccountBlocksByHeight', [address, record.height, 1], rpcMs);
    const found = listed?.list?.[0] || null;
    if (found?.hash === record.hash) {
      const next = found.confirmationDetail ? state.observed : state.accepted;
      if (next !== record.state) await update(record.id, from, { state: next });
      continue;
    }
    if (found) {
      // Another block holds the height. Confirmed, that is final; pooled, it
      // may yet be displaced or confirmed, and the answer is to wait.
      if (found.confirmationDetail) await update(record.id, from, { state: state.superseded, note: found.hash });
      continue;
    }
    try {
      await ask(zenon, 'ledger.publishRawTransaction', [record.block], rpcMs);
      await update(record.id, from, { state: state.accepted });
    } catch (error) {
      const reason = refusal(error);
      if (reason === null) continue;
      await update(record.id, from, { state: state.rejected, note: reason });
    }
  }
  const after = (await read(keys)).records.filter((record) => record.network === network && record.address === address);
  return {
    network,
    unknown: after.filter((record) => record.state === state.publishing).map(({ block, ...rest }) => rest),
    records: after.map(({ block, ...rest }) => rest),
  };
};

// One turn for one block. `publish` records the signed block and sends it;
// `release` hands the turn on, whatever happened.
const begin = async (zenon, address, { path = 'send', waitMs = defaultWaitMs, replyMs = defaultReplyMs, rpcMs } = {}) => {
  const network = await networkOf(zenon, rpcMs);
  const account = accountKey(network, address);
  const owner = randomId();
  const deadline = Date.now() + waitMs;
  let revision, checked = false;
  for (;;) {
    const turn = await transact((value, now) => {
      const mine = value.records.filter((record) => record.network === network && record.address === address);
      if (mine.some((record) => record.state === state.publishing)) return { unknown: true };
      if (mine.length >= maxRecordsPerAccount) throw fullError();
      const held = value.reservations[account];
      // Something the person asked for goes ahead of a receive. A receive loop
      // asks for its next turn the instant it gives one back, and would
      // otherwise keep a send waiting behind every block still to be received.
      value.waiters = value.waiters || {};
      const ahead = (value.waiters[account] || []).filter((waiter) => waiter.until > now && waiter.owner !== owner);
      const wait = () => {
        if (path !== 'receive') ahead.push({ owner, until: now + waiterMs });
        value.waiters[account] = ahead;
        return { busy: true };
      };
      // A turn exists to send one block. Once that block is on record and its
      // outcome is known, the turn is spent, whether or not the window that
      // took it lived to say so: a popup closed mid-send would otherwise hold
      // the account until its reservation ran out.
      const spent = Boolean(held?.record) &&
        !value.records.some((record) => record.id === held.record && record.state === state.publishing);
      if (held?.owner && held.expiresAt > now && !spent) return wait();
      if (path === 'receive' && ahead.length) return wait();
      if (ahead.length) value.waiters[account] = ahead; else delete value.waiters[account];
      value.reservations[account] = { owner, revision: (held?.revision || 0) + 1, expiresAt: now + reservationMs };
      return { revision: value.reservations[account].revision };
    });
    if (turn.revision) { revision = turn.revision; break; }
    if (turn.unknown) {
      // Ask the node once before refusing: most of these settle at a glance.
      if (checked) throw unresolvedError();
      checked = true;
      await reconcile(zenon, address, { only: [state.publishing], rpcMs });
      continue;
    }
    if (Date.now() >= deadline) throw busyError();
    await sleep(pollMs);
  }

  const holds = (value, now) => {
    const held = value.reservations[account];
    return Boolean(held && held.owner === owner && held.revision === revision && held.expiresAt > now);
  };
  // Proof of work can outlast one reservation period on a slow machine.
  const renewal = setInterval(() => {
    transact((value, now) => { if (holds(value, now)) value.reservations[account].expiresAt = now + reservationMs; }).catch(() => {});
  }, renewMs);
  let id = null, released = false;

  // The durable step: after this returns the block may be sent, and not before.
  // A window whose turn expired while it mined loses here, with nothing sent.
  const start = async (block) => {
    const json = block.toJson();
    const hash = block.hash?.toString();
    if (typeof hash !== 'string' || !hash || block.address?.toString() !== address) throw staleError();
    id = await transact((value, now) => {
      if (!holds(value, now) || value.reservations[account].record) throw staleError();
      const record = { id: randomId(), network, address, path, state: state.publishing, hash,
        height: Number(block.height), block: JSON.parse(JSON.stringify(json)), createdAt: now, updatedAt: now };
      value.records.push(record);
      value.reservations[account].record = record.id;
      return record.id;
    });
    return id;
  };
  // `outcome` is the publication promise, or the error that stopped it being
  // made. Resolves for an accepted block; throws the node's refusal as it came,
  // or an unknown-outcome error when no answer arrived.
  const settle = async (outcome, { sent = true } = {}) => {
    if (!id) throw staleError();
    let timer;
    const silence = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('The node did not answer.')), replyMs); });
    // Whichever loses the race is still answered for.
    Promise.resolve(outcome).catch(() => {}); silence.catch(() => {});
    try {
      await Promise.race([outcome, silence]);
    } catch (error) {
      clearTimeout(timer);
      const reason = sent ? refusal(error) : (error?.message || 'Not sent.');
      if (reason !== null) {
        await update(id, [state.publishing], { state: state.rejected, note: reason }).catch(() => {});
        throw error;
      }
      throw unknownOutcome();
    }
    clearTimeout(timer);
    await update(id, [state.publishing], { state: state.accepted }).catch(() => {});
  };
  const publish = async (block, send) => {
    await start(block);
    let outcome;
    try { outcome = Promise.resolve(send()); } catch (error) { outcome = Promise.reject(error); }
    return settle(outcome);
  };
  const release = async () => {
    if (released) return;
    released = true;
    clearInterval(renewal);
    await transact((value) => {
      const held = value.reservations[account];
      if (held?.owner === owner && held.revision === revision) value.reservations[account] = { revision, owner: null, expiresAt: 0 };
    }).catch(() => {});
  };
  return { network, start, settle, publish, release };
};

const run = async (zenon, address, options, operation) => {
  const entry = await begin(zenon, address, options);
  try { return await operation(entry); } finally { await entry.release(); }
};

// The person's own decision to stop waiting on a block whose outcome the node
// cannot settle. It may still land; the screen that calls this says so.
const discard = (id) => update(id, [state.publishing], { state: state.rejected, note: 'Discarded by the user. It may still be confirmed.' });

// For wallet removal, which deletes the file after the vault is sealed.
const storageKey = async () => (await material()).storageKey;
// The way out of records that cannot be decrypted or are from a newer wallet.
const reset = async () => {
  const { storageKey: key } = await material();
  await navigator.locks.request(lockName, async () => localStorage.removeItem(key));
};

const journal = { state, begin, run, reconcile, discard, reset, storageKey, maxRecordsPerAccount, retentionMs, defaultWaitMs };
export default journal;
export { state as journalState };
