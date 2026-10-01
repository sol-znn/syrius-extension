import React, { useEffect, useRef, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';

import AuthLayout from '../authLayout/authLayout';
import TabsLayout from '../tabsLayout/tabsLayout';
import SiteIntegrationLayout from '../siteIntegrationLayout/siteIntegrationLayout';
import DashboardPassword from '../../pages/dashboard/dashboard-password/dashboard-password';
import InitialNodeSelection from '../../pages/settings/change-node/initial-node-selection';
import Splash from '../../components/splash/splash';

import { completeUnlock } from '../../services/wallet/bootstrap';
import session from '../../services/wallet/session';
import vault from '../../services/wallet/vault';
import { resetWalletState } from '../../services/redux/walletSlice';
import { resetPendingTransactions } from '../../services/redux/pendingTransactionsSlice';
import { invalidateAccountCache } from '../../services/hooks/useAccount';
import { notify } from '../../services/utils/notify';
import { loadStorageWalletNames } from '../../services/utils/utils';
import { getCurrentNodeUrl } from '../../services/utils/storage';
import { isDevWalletBuild, prepareDevWallet } from '../../services/utils/devWallet';

// The routes that mean something specific was asked for, rather than "open the
// wallet". A dApp approval is opened as `popup.html#/site-integration`, and
// that has to survive the unlock: sending somebody to the password screen and
// then dropping them on the dashboard loses the request they were opened for.
const deepLinkRoutes = ['/site-integration'];

const MainLayout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch();
  const [isBooting, setIsBooting] = useState(true);
  const [bootError, setBootError] = useState(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const pendingRevocation = useRef(null);

  // Captured once, before any redirect of ours can overwrite it.
  const requestedRoute = useRef(location.pathname);

  // Local expiry and another extension window's lock also clear visible secrets
  // and copied UI state. This cleanup must never clear a newer shared lease.
  useEffect(() => vault.onLock(({ leaseId, error } = {}) => {
    invalidateAccountCache();
    dispatch(resetPendingTransactions());
    dispatch(resetWalletState());
    notify.dismissAll();
    if (['WALLET_SESSION_UNAVAILABLE', 'WALLET_LOCK_FAILED'].includes(error?.code)) {
      // Local secrets have been purged, but shared revocation is unconfirmed —
      // storage failed under a key operation, or an explicit lock could not
      // commit.
      // Retain its identity for the same conditional recovery used at startup.
      pendingRevocation.current = leaseId;
      setBootError(error.message);
      setIsBooting(false);
      return;
    }
    navigate('/password', { replace: true, state: {
      returnTo: requestedRoute.current === '/site-integration' ? '/site-integration' : null,
    } });
  }), [dispatch, navigate]);

  // A way in for the dev harness that does not mean clicking through the whole
  // wallet to reach the screen being worked on. `utils/dev-harness.js` also
  // tests for this function to tell a harness build from an ordinary one.
  // Compiled out of every build that does not set SYRIUS_DEV_WALLET.
  useEffect(() => {
    if (!isDevWalletBuild) {
      return undefined;
    }
    window.__syriusDevNavigate = (path) => navigate(path);

    return () => {
      delete window.__syriusDevNavigate;
    };
  }, [navigate]);

  // The popup used to open on three seconds of Lottie animation. It played
  // before anything was read from storage, so the wallet was not merely
  // decorated for three seconds — it was unusable for three seconds, every
  // single time, including when it had been opened to approve something.
  useEffect(() => {
    let cancelled = false;

    const revokeFailedRestore = async () => {
      const expected = pendingRevocation.current;
      if (!expected) return;
      await session.clear(expected);
      vault.lock(typeof expected === 'object' ? expected.id : expected);
      if (!cancelled && pendingRevocation.current === expected) {
        pendingRevocation.current = null;
        setIsBooting(true);
        setBootError(null);
      }
    };

    const boot = async () => {
      // Retry the failed identity before attempting another restore. A newer
      // shared lease is preserved by the conditional clear.
      await revokeFailedRestore();
      if (cancelled) return;
      // Creates the harness' wallet and points it at a node, before anything
      // asks whether this profile has a wallet at all. Compiled out of every
      // build that is not driven by the dev harness.
      if (isDevWalletBuild) {
        await prepareDevWallet();
      }

      const wallets = loadStorageWalletNames();
      const initialPathname = requestedRoute.current;
      const isWithin = (route) =>
        initialPathname === route || initialPathname.startsWith(`${route}/`);
      const deepLink = deepLinkRoutes.includes(initialPathname)
        ? initialPathname
        : null;
      const navigateIfNeeded = (to, options = {}) => {
        if (!cancelled && initialPathname !== to) {
          navigate(to, { replace: true, ...options });
        }
      };

      if (!wallets.length) {
        // Keep an already-open auth screen where it is. A fresh popup goes
        // straight to the canonical onboarding route instead of replacing
        // `/auth` and then replacing it again from the nested router.
        if (!isWithin('/auth')) {
          navigateIfNeeded('/auth/onboarding');
        }
        return;
      }

      if (!getCurrentNodeUrl()) {
        navigateIfNeeded('/initial-node-selection');
        return;
      }

      // An unexpired session means the keystore never has to be decrypted
      // again: the entropy is already there, so this is a few milliseconds
      // rather than a key derivation function chosen to be slow.
      const unlock = await session.load();
      if (cancelled) return;

      if (unlock && wallets.includes(unlock.walletName)) {
        try {
          await completeUnlock({
            walletName: unlock.walletName,
            sessionRecord: unlock,
            dispatch,
          });
          if (!cancelled) {
            const destination = deepLink || (
              isWithin('/tabs') ? initialPathname : '/tabs/dashboard'
            );
            navigateIfNeeded(destination);
          }
          return;
        } catch (err) {
          // Retry owns the new startup. A late node/restore completion must
          // not replace its recovery identity or screen state.
          if (cancelled) return;
          // Do not show a successful locked state if shared cleanup fails.
          // The startup error view keeps this identity for an explicit retry.
          // Scoped to the revision that was read: if its owner has since
          // switched to On close, the record is theirs and stays.
          pendingRevocation.current = { id: unlock.id, revision: unlock.revision };
          await revokeFailedRestore();
        }
      }

      navigateIfNeeded('/password', { state: { returnTo: deepLink } });
    };

    boot().catch((error) => {
      if (!cancelled) {
        setBootError(error?.code === 'WALLET_LOCK_FAILED' ? error.message :
          'Could not read or restore the wallet session. Other wallet windows may still be unlocked. Try again or close the browser.');
      }
    }).finally(() => {
      if (!cancelled) {
        setIsBooting(false);
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootAttempt]);

  if (isBooting) {
    return <Splash />;
  }

  if (bootError) {
    return (
      <div className="page" role="alert">
        <h2>Wallet session needs attention</h2>
        <p>{bootError}</p>
        <button type="button" className="button primary" onClick={() => {
          setIsBooting(true);
          setBootError(null);
          setBootAttempt((attempt) => attempt + 1);
        }}>Retry</button>
      </div>
    );
  }

  return (
    <div className="main-layout">
      <Routes>
        {/* The async startup redirect briefly leaves a normal popup at /. */}
        <Route index element={<Splash />} />
        <Route path="auth/*" element={<AuthLayout />} />
        <Route path="password" element={<DashboardPassword />} />
        <Route path="initial-node-selection" element={<InitialNodeSelection />} />
        <Route path="tabs/*" element={<TabsLayout />} />
        <Route path="site-integration" element={<SiteIntegrationLayout />} />
      </Routes>
    </div>
  );
};

export default MainLayout;
