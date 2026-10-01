// What a site's consent and an approval are bound to: one wallet import and
// one of its accounts. Shared by pages and the worker; SDK-free.
//
// The exact stored name separates duplicate imports of the same seed. The
// wallet's first address (`walletId`) stops a replacement seed that reuses a
// name from inheriting the old wallet's consent.
const validScope = (scope) => Boolean(scope && typeof scope.walletId === 'string' && scope.walletId &&
  typeof scope.walletName === 'string' && scope.walletName && typeof scope.address === 'string' && scope.address &&
  Number.isSafeInteger(scope.index) && scope.index >= 0);
const sameWallet = (a, b) => validScope(a) && validScope(b) && a.walletId === b.walletId && a.walletName === b.walletName;
const sameScope = (a, b) => sameWallet(a, b) && a.address === b.address && a.index === b.index;
const scopeKey = (scope) => (validScope(scope) ? JSON.stringify([scope.walletName, scope.walletId, scope.address, scope.index]) : null);

export { validScope, sameWallet, sameScope, scopeKey };
