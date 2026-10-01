// The wallet selection as the worker and the approval screen see it: which
// wallet import and account the shared session is on, and its generation.
// Shared by pages and the worker; never imports the SDK or secrets.
//
// It is a view of the session lease (sessionLease.js), not a record of its
// own: `selectionId` there is the generation here, and a binding is
// `{id: selectionId, ownerId, scope}`. Everything runs under the lease's lock,
// in the order session -> permissions -> pending requests. Never take it from a
// worker check that a key operation holding it is waiting on.
import lease from './sessionLease';
import { sameScope, sameWallet, scopeKey, validScope } from './walletScope';

const { sessionKey, publicStateKey, changed: ended } = lease;
const current = (stored) => stored[sessionKey];
const live = (record) => lease.live(record);
const matches = (record, binding, owner = false) => live(record) && Boolean(binding) &&
  record.selectionId === binding.id && sameScope(record.scope, binding.scope) &&
  (!owner || record.mode !== 'local' || record.ownerId === binding.ownerId);
const assert = (record, binding, owner = false) => { if (!matches(record, binding, owner)) throw ended(); };
const publicValue = (stored, expectedId) => lease.publicValue(stored, expectedId);

const selection = {
  sessionKey, publicStateKey, validScope, sameWallet, sameScope, scopeKey, read: lease.read,
  transaction: lease.transaction, current, live, matches, assert, publicValue, ended,
};
export default selection;
