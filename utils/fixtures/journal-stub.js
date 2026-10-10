'use strict';

// The transaction journal, taken out of the way for fixtures that are about
// something else.
//
// The real one (src/services/wallet/journal.js) needs Web Crypto, Web Locks, a
// localStorage and a node that names its network; utils/transaction-journal-test.js
// gives it those and is where it is tested. The suites that load a sender for
// its consent, identity or queue behaviour get this instead: every turn is
// granted at once, nothing is recorded, and the publication is passed straight
// through, so what they count (signatures, publications, errors) is unchanged.
const entry = () => ({
  network: 'fixture-network',
  start: async () => 'fixture-record',
  settle: async (outcome) => { await outcome; },
  publish: async (block, send) => send(),
  release: async () => {},
});
const journal = {
  state: { publishing: 'publishing', accepted: 'accepted', observed: 'observed', rejected: 'rejected', superseded: 'superseded' },
  begin: async () => entry(),
  run: async (zenon, address, options, operation) => operation(entry()),
  reconcile: async () => ({ network: 'fixture-network', unknown: [], records: [] }),
  discard: async () => null,
  reset: async () => {},
  storageKey: async () => 'syrius.journal.fixture',
  maxRecordsPerAccount: 100,
};
// The pinned SDK's one-call send, which the fixtures already replace.
const publisher = (zenon, template, keyPair, { onPow } = {}) => zenon.send(template, keyPair, onPow);

const journalStubs = (id) => {
  if (id === './journal' || id.endsWith('/wallet/journal')) return { __esModule: true, default: journal, journalState: journal.state };
  if (id === './publisher' || id.endsWith('/wallet/publisher')) return { __esModule: true, default: publisher };
  return undefined;
};

module.exports = { journalStubs };
