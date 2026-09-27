// SDK-free coordination shared by extension documents and the MV3 worker.
// A policy revision invalidates callbacks captured before the setting changed.
const sessionKey = 'znn.unlock';
const publicStateKey = 'znn.publicState';
const run = (operation) => navigator.locks.request('znn.sessionPolicy', operation);
const token = (record) => record ? { id: record.id, revision: record.revision } : null;
const matches = (record, expected) => record === null ? expected === null :
  Boolean(expected && record.id && record.id === expected.id && record.revision === expected.revision);
const timed = (record) => Boolean(record?.version === 1 && record.mode === 'timed' &&
  record.entropy && record.expiresAt > Date.now());
const live = (record, ownerId) => timed(record) || Boolean(record?.version === 1 &&
  record.mode === 'local' && record.ownerId === ownerId && ownerId &&
  (!record.privateUntil || record.privateUntil > Date.now()));
const ended = () => ({ version: 1, id: crypto.randomUUID(), revision: crypto.randomUUID(), mode: 'ended' });
const read = async () => (await chrome.storage.session.get(sessionKey))[sessionKey] || null;
// Clear the old public snapshot in the same storage commit as each revision.
const write = async (record, publicState = null) => {
  await chrome.storage.session.set({ [sessionKey]: record, [publicStateKey]: publicState });
  return record;
};
const publicValue = async (record) => {
  if (!timed(record)) return null;
  const value = (await chrome.storage.session.get(publicStateKey))[publicStateKey];
  return value && matches(record, value.token) ? value : null;
};
const clear = (expected) => run(async () => {
  const current = await read();
  if (!matches(current, expected)) return null;
  return write(ended());
});
const sessionState = { sessionKey, publicStateKey, run, token, matches, timed, live, ended, read, write, publicValue, clear };
export default sessionState;
