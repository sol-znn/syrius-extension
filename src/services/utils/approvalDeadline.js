// Stop waiting at the approval deadline. The captured claim/key/publication
// guards still reject any late continuation; an RPC or publication that has
// already started cannot be recalled by settling this promise.
const withApprovalDeadline = (promise, expiresAt) => {
  if (!Number.isFinite(expiresAt)) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Approval expired after processing began. Verify the outcome before retrying.')),
        Math.max(0, expiresAt - Date.now()));
    }),
  ]).finally(() => clearTimeout(timer));
};
export default withApprovalDeadline;
