import React, { useCallback, useEffect, useState } from 'react';

import { sendInternal } from '../../../services/utils/messaging';
import selection from '../../../services/wallet/selection';
import { notify } from '../../../services/utils/notify';
import { fail } from '../../../services/utils/errors';

// Which sites can see this wallet.
//
// There was nothing like this, because there was nothing to list: a site's
// permission lasted exactly as long as the popup answering it, so every call
// asked again and no grant was ever recorded. Now that connecting is
// remembered, it has to be visible and revocable — a permission a person cannot
// find is a permission they cannot withdraw.

const hostOf = (origin) => {
  try {
    return new URL(origin).host;
  } catch (err) {
    return origin;
  }
};

const ConnectedSites = () => {
  const [sites, setSites] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // An unreadable list is shown as such, with a retry — never as "no sites",
  // which would read as nothing left to withdraw.
  const load = useCallback(async () => {
    try {
      setSites((await sendInternal('permissions.list')) || []);
      setLoadError(false);
    } catch (err) {
      setLoadError(true);
      notify.error(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = async ({ origin, scope }) => {
    try {
      if (!(await sendInternal('permissions.revoke', { origin, scope }))) throw fail(821);
      setSites((current) => current.filter((site) => site.origin !== origin || !selection.sameScope(site.scope, scope)));
      notify.success(`Disconnected ${hostOf(origin)}`);
    } catch (err) {
      notify.error(err);
      // A disconnect that did not complete stays listed, marked, for a retry.
      await load();
    }
  };

  const revokeAll = async () => {
    try {
      if (!(await sendInternal('permissions.revokeAll'))) throw fail(822);
      setSites([]);
      notify.success('Disconnected every site');
    } catch (err) {
      notify.error(err);
      await load();
    }
  };

  if (isLoading) {
    return (
      <div className="page">
        <p className="empty-note">Loading…</p>
      </div>
    );
  }

  return (
    <div className="page">
      {loadError && (
        <p className="empty-note" role="alert">
          Unable to load connected sites.
          <button type="button" className="thin-button secondary" onClick={load}>Retry</button>
        </p>
      )}
      {!loadError && !sites.length && (
        <p className="empty-note">
          No sites are connected. A site can read your address only after you approve it.
        </p>
      )}

      {sites.map((site) => (
        <div key={JSON.stringify([site.origin, selection.scopeKey(site.scope)])} className="site-row">
          <div className="site-favicon site-favicon-blank" aria-hidden="true" />

          <div className="site-row-text">
            <div className="site-host">{hostOf(site.origin)}</div>
            <div className="site-origin">{site.origin}</div>
            <div>{site.scope.walletName} · Account {site.scope.index + 1}</div>
            <div className="word-break-all">{site.scope.address}</div>
            {site.revocationPending && <div className="site-origin" role="status">Access blocked. Retry disconnect.</div>}
          </div>

          <button
            type="button"
            className="thin-button secondary"
            onClick={() => revoke(site)}
          >
            {site.revocationPending ? 'Retry disconnect' : 'Disconnect'}
          </button>
        </div>
      ))}

      {sites.length > 1 && (
        <button type="button" className="button danger-text w-100 mt-3" onClick={revokeAll}>
          Disconnect all wallets and accounts
        </button>
      )}
    </div>
  );
};

export default ConnectedSites;
