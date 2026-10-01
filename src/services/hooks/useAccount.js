import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { Zenon } from 'znn-ts-sdk';
import { fetchBalances } from '../wallet/account';
import vault from '../wallet/vault';

// One place for "who am I and what do I hold".
//
// Six screens each had their own `getWalletInfo(pass, name)`: open the
// keystore, derive the key pair, await the address, fetch the account, and
// swallow whatever went wrong into a `console.error`. They differed in which
// parts they did and none of them showed the person an error. The keystore work
// now happens once at unlock, in `services/wallet/vault`, and this is the rest.
//
// The last good answer is kept across mounts so that switching tabs shows the
// balance immediately and refreshes behind it, rather than flashing zero.

const cache = { key: null, balances: [], balanceMap: {}, fetchedAt: 0 };

const useAccount = ({ balances: wantBalances = true, refreshMs = 0 } = {}) => {
  const { address, selectedAddressIndex } = useSelector((state) => state.wallet);
  const cacheKey = `${address}`;
  const isCacheWarm = cache.key === cacheKey;

  const [state, setState] = useState({
    balances: isCacheWarm ? cache.balances : [],
    balanceMap: isCacheWarm ? cache.balanceMap : {},
    isLoading: wantBalances && !isCacheWarm,
    error: null,
  });

  // Guards against setting state on an unmounted component and against a slow
  // response for an address the user has already navigated away from.
  const liveKey = useRef(cacheKey);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(
    async ({ quiet = false } = {}) => {
      if (!address || !vault.isUnlocked()) {
        return null;
      }
      liveKey.current = cacheKey;

      if (!quiet) {
        setState((previous) => ({ ...previous, isLoading: true, error: null }));
      }
      try {
        const lifetime = vault.capture();
        const addressObject = await vault.getAddressObject(selectedAddressIndex);
        const result = await fetchBalances(Zenon.getSingleton(), addressObject);

        if (!vault.isCurrent(lifetime)) return null;
        cache.key = cacheKey;
        cache.balances = result.balances;
        cache.balanceMap = result.balanceMap;
        cache.fetchedAt = Date.now();

        if (mounted.current && liveKey.current === cacheKey) {
          setState({
            balances: result.balances,
            balanceMap: result.balanceMap,
            isLoading: false,
            error: null,
          });
        }
        return result;
      } catch (err) {
        if (mounted.current && liveKey.current === cacheKey) {
          setState((previous) => ({ ...previous, isLoading: false, error: err }));
        }
        return null;
      }
    },
    [address, cacheKey, selectedAddressIndex]
  );

  useEffect(() => {
    if (!wantBalances) {
      return undefined;
    }
    // A warm cache for this address is shown straight away and refreshed
    // without a spinner.
    refresh({ quiet: isCacheWarm });

    if (!refreshMs) {
      return undefined;
    }
    const timer = setInterval(() => refresh({ quiet: true }), refreshMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, wantBalances, refreshMs]);

  return {
    address,
    selectedAddressIndex,
    balances: state.balances,
    balanceMap: state.balanceMap,
    isLoading: state.isLoading,
    error: state.error,
    refresh,
  };
};

// Lets a screen that has just sent something drop the cached balances so the
// next mount does not show a stale number.
const invalidateAccountCache = () => {
  cache.key = null;
  cache.balances = [];
  cache.balanceMap = {};
};

export { useAccount, invalidateAccountCache };
export default useAccount;
