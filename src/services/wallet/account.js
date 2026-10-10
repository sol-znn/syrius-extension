import { Enums, Primitives } from 'znn-ts-sdk';
import { toDecimals } from '../utils/format';
import { nativeTokens, normalizeTokenStandard, znnZts, qsrZts } from './tokenMetadata';
import sendJournaled from './publisher';

// Reading an account, once, in a shape the screens can use.
//
// The balance map that comes back from the node only contains tokens the
// account actually holds, so a fresh wallet has no ZNN entry and every screen
// that indexed `balanceInfoMap['zts1znn…']` threw on it. They each worked
// around that by merging in a hard-coded pair of zero balances, in slightly
// different ways, and then only ever showed those two — which is why the wallet
// could hold a ZTS token and never mention it.

// ZNN and QSR lead, because they are the two the rest of the wallet is about.
// After that the largest holdings first, then alphabetically so the order is
// stable between refreshes.
const rank = (entry) => {
  const zts = entry.token?.tokenStandard?.toString();
  if (zts === znnZts) return 0;
  if (zts === qsrZts) return 1;
  return 2;
};

const sortBalances = (balances) =>
  [...balances].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) {
      return byRank;
    }
    const balanceA = a.balance?.toString?.() || '0';
    const balanceB = b.balance?.toString?.() || '0';
    if (balanceA.length !== balanceB.length) {
      return balanceB.length - balanceA.length;
    }
    if (balanceA !== balanceB) {
      return balanceB > balanceA ? 1 : -1;
    }
    return (a.token?.symbol || '').localeCompare(b.token?.symbol || '');
  });

// The two base tokens are always present, at zero if need be, so that the send
// screen and the dashboard have something to render before the first response
// and after an empty one.
const withBaseTokens = (balanceInfoMap) => {
  const balances = {};
  for (const [key, entry] of Object.entries(balanceInfoMap || {})) {
    const zts = normalizeTokenStandard(key);
    if (Object.prototype.hasOwnProperty.call(balances, zts)) {
      throw new Error('The node returned duplicate token identities');
    }
    const native = nativeTokens[zts];
    if (!native && normalizeTokenStandard(entry?.token?.tokenStandard) !== zts) {
      throw new Error('The node returned conflicting token identities');
    }
    if (!native && entry.token.decimals != null &&
        !['string', 'number'].includes(typeof entry.token.decimals)) {
      throw new Error('The node returned invalid token decimals');
    }
    balances[zts] = {
      balance: entry?.balance ?? 0,
      // Copy descriptive custom metadata; none of it authorizes a transfer.
      token: Object.freeze(native ? { ...native } : {
        tokenStandard: zts,
        symbol: typeof entry.token.symbol === 'string' ? entry.token.symbol : '',
        name: typeof entry.token.name === 'string' ? entry.token.name : '',
        decimals: toDecimals(entry.token.decimals),
      }),
    };
  }
  for (const [zts, token] of Object.entries(nativeTokens)) {
    balances[zts] ??= { balance: 0, token };
  }
  return balances;
};

const fetchBalances = async (zenon, addressObject) => {
  const accountInfo = await zenon.ledger.getAccountInfoByAddress(addressObject);
  const balanceMap = withBaseTokens(accountInfo?.balanceInfoMap);

  return {
    balanceMap,
    balances: sortBalances(Object.values(balanceMap)),
    blockCount: accountInfo?.blockCount || 0,
  };
};

//
// Receiving
//
const memoryPoolPageSize = 50;

// A block is only credited to an account once the account receives it, so a
// wallet that never does shows a balance that is missing everything sent to it.
//
// The old version looped until the node reported nothing pending, with a
// fifteen-minute timeout that rejected a promise which had usually already
// resolved. It ran unannounced on every dashboard mount, and since receiving
// costs plasma it could sit there generating proof of work for minutes on an
// account with a long backlog, with the screen frozen behind a spinner.
//
// This one is bounded, reports what it is doing, and can be turned off in
// settings.
//
// What one pending block is doing right now.
//
// Receiving costs plasma, and an account with no fused QSR has to generate
// proof of work for the receive block before it can be published — seconds of
// it, per block. The node only asks for that when the account cannot pay for
// the block out of fused plasma, so `generatingPlasma` is reported exactly when
// it is really happening and never otherwise.
const receivePhase = {
  started: 'started',
  generatingPlasma: 'generating-plasma',
  done: 'done',
};

const receivePendingBlocks = async (
  zenon,
  keyPair,
  addressObject,
  { onProgress, onBlock, maxBlocks = 25, signal } = {}
) => {
  let received = 0;

  while (received < maxBlocks) {
    if (signal?.aborted) {
      break;
    }
    const pending = await zenon.ledger.getUnreceivedBlocksByAddress(
      addressObject,
      0,
      memoryPoolPageSize
    );
    const list = pending?.list || [];

    if (!list.length) {
      break;
    }

    for (const block of list) {
      if (received >= maxBlocks || signal?.aborted) {
        break;
      }
      const template = Primitives.AccountBlockTemplate.receive(block.hash);

      onBlock?.(block, receivePhase.started);
      try {
        await sendJournaled(zenon, template, keyPair, { path: 'receive', onPow: (status) => {
          // `PowStatus.generating` is 0, so this has to compare rather than
          // test for truth — the obvious `if (status)` reads it as "done".
          if (status === Enums.PowStatus.generating) {
            onBlock?.(block, receivePhase.generatingPlasma);
          }
        } });
      } finally {
        // In `finally`, so a block that fails to publish cannot leave a row
        // pulsing on the dashboard forever.
        onBlock?.(block, receivePhase.done);
      }
      received += 1;
      onProgress?.(received, Math.min(pending.count ?? list.length, maxBlocks));
    }
  }

  return received;
};

const countPendingBlocks = async (zenon, addressObject) => {
  const pending = await zenon.ledger.getUnreceivedBlocksByAddress(addressObject, 0, 1);
  return pending?.count || 0;
};

export {
  znnZts,
  qsrZts,
  sortBalances,
  withBaseTokens,
  fetchBalances,
  receivePendingBlocks,
  countPendingBlocks,
  receivePhase,
};
