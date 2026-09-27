// Page response correlation is not approval authority. This snapshot describes
// exactly what one extension-generated queue identity asks the user to approve.
const approvalTypes = ['connect', 'sendTransaction', 'signAndSendBlock', 'signMessage'];
const validApproval = request => Boolean(request && request.version === 1 &&
  typeof request.id === 'string' && request.id.length > 0 && approvalTypes.includes(request.type) &&
  typeof request.origin === 'string' && request.origin.length > 0 &&
  Number.isInteger(request.tabId) && Number.isInteger(request.frameId) &&
  typeof request.documentId === 'string' && request.documentId.length > 0 &&
  (typeof request.responseId === 'string' || (typeof request.responseId === 'number' && Number.isFinite(request.responseId))));
const snapshotOf = request => validApproval(request) ? JSON.stringify([
  request.version, request.id, request.type, request.params, request.origin,
  request.tabId, request.frameId, request.documentId, request.responseId,
  request.title, request.favicon, request.createdAt,
]) : null;
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
const approvalEnded = () => new Error('This approval was already answered or changed. Review a new request.');
export { validApproval, snapshotOf, identityOf, matchesApproval, freezeApproval, approvalEnded, copy };
