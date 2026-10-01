import { validRequest } from './documentBinding';

// Page response correlation is not approval authority. This snapshot describes
// exactly what one extension-generated queue identity asks the user to approve.
const approvalTypes = ['connect', 'sendTransaction', 'signAndSendBlock', 'signMessage'];
// Version 4: an absolute deadline (queue limits), the selection the request was
// admitted under and is bound to (wallet scoping), and the live document that
// asked -- native document, relay activation, private request token and
// navigation generation (document binding) -- all in the snapshot.
const validApproval = request => Boolean(request && request.version === 4 && Number.isFinite(request.expiresAt) && Number.isFinite(request.createdAt) &&
  validRequest(request) &&
  typeof request.id === 'string' && request.id.length > 0 && approvalTypes.includes(request.type) &&
  typeof request.origin === 'string' && request.origin.length > 0 &&
  Number.isInteger(request.tabId) && Number.isInteger(request.frameId) &&
  typeof request.documentId === 'string' && request.documentId.length > 0 &&
  (typeof request.responseId === 'string' || (typeof request.responseId === 'number' && Number.isFinite(request.responseId))));
// Object keys are serialized in sorted order. chrome.storage returns every
// object with its keys sorted, so a snapshot taken of a record before it was
// written (the worker's, at admission) and one taken of the same record read
// back (the popup's, and every later check) must not depend on key order.
// Without this, any request whose params had two or more keys out of order --
// every sendTransaction and signAndSendBlock -- failed to present, and could
// not be rejected either, because its own identity no longer matched it.
const canonical = value => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value);
const snapshotOf = request => validApproval(request) ? JSON.stringify(canonical([
  request.version, request.id, request.type, request.params, request.origin,
  request.tabId, request.frameId, request.documentId, request.responseId,
  request.title, request.favicon, request.createdAt, request.expiresAt,
  request.admitted, request.waitForUnlock, request.binding,
  request.activation, request.requestToken, request.navigationTab, request.navigationFrame,
])) : null;
const identityOf = request => ({ id: request?.id, snapshot: snapshotOf(request) });
const matchesApproval = (request, identity) => Boolean(validApproval(request) &&
  identity?.id === request.id && typeof identity.snapshot === 'string' && identity.snapshot === snapshotOf(request));
const copy = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const freezeApproval = request => {
  const snapshot = copy(request);
  if (!validApproval(snapshot)) throw new Error('This request must be submitted again.');
  return freeze(snapshot);
};
const approvalEnded = () => new Error('This approval expired, was answered or changed. Review a new request.');
export { validApproval, snapshotOf, identityOf, matchesApproval, freezeApproval, approvalEnded, copy };
