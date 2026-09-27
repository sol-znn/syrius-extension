import React, { useCallback, useEffect, useState } from 'react';

import { sendInternal } from '../../../services/utils/messaging';
import { notify } from '../../../services/utils/notify';

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

  const revoke = async (origin) => {
    try {
      await sendInternal('permissions.revoke', { origin });
      setSites((current) => current.filter((site) => site.origin !== origin));
      notify.success(`Disconnected ${hostOf(origin)}`);
    } catch (err) {
      notify.error(err);
      await load();
    }
  };

  const revokeAll = async () => {
    try {
      await sendInternal('permissions.revokeAll');
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
        <div key={site.origin} className="site-row">
          {site.favicon ? (
            <img className="site-favicon" alt="" src={site.favicon} width="20" height="20" />
          ) : (
            <div className="site-favicon site-favicon-blank" />
          )}

          <div className="site-row-text">
            <div className="site-host">{hostOf(site.origin)}</div>
            <div className="site-origin">{site.origin}</div>
            {site.revocationPending && <div className="site-origin" role="status">Access blocked. Retry disconnect.</div>}
          </div>

          <button
            type="button"
            className="thin-button secondary"
            onClick={() => revoke(site.origin)}
          >
            {site.revocationPending ? 'Retry disconnect' : 'Disconnect'}
          </button>
        </div>
      ))}

      {sites.length > 1 && (
        <button type="button" className="button danger-text w-100 mt-3" onClick={revokeAll}>
          Disconnect all
        </button>
      )}
    </div>
  );
};

export default ConnectedSites;
