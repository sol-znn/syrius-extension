import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import ChangeAddressItem from '../../../components/change-address-item/change-address-item';
import { storeMaxAddressIndex, storeSelectedAddress } from '../../../services/redux/walletSlice';
import { getLabels, setLabel, setAddressInfo } from '../../../services/utils/storage';
import { notify } from '../../../services/utils/notify';
import { announceAddress } from '../../../services/wallet/announce';
import { invalidateAccountCache } from '../../../services/hooks/useAccount';
import vault from '../../../services/wallet/vault';

// Choosing which derived address the wallet is using.
//
// It used to re-open the keystore — an Argon2id run — every time it rendered
// the list or added an address, and it wrote the whole `addressInfo` blob back
// to localStorage from three different places with slightly different contents.
// Deriving now goes through the already-open keystore, and the write goes
// through one function that validates what it stores.

const ChangeAddress = () => {
  const dispatch = useDispatch();
  const { walletName, selectedAddressIndex, maxAddressIndex } = useSelector(
    (state) => state.wallet
  );

  const [addresses, setAddresses] = useState([]);
  const [labels, setLabelsState] = useState(() => getLabels());
  const [isLoading, setIsLoading] = useState(true);

  const deriveAddresses = useCallback(async (count) => {
    setIsLoading(true);
    try {
      setAddresses(await vault.getAddresses(count));
    } catch (err) {
      notify.error(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    deriveAddresses(maxAddressIndex);
  }, [deriveAddresses, maxAddressIndex]);

  const select = async (index) => {
    const address = addresses[index];

    if (!address) {
      return;
    }
    try {
      // A new selection generation: consent, public state and approvals bound
      // to the previous account stop applying. The saved selection is written
      // first, inside the same session transaction; if that fails nothing moves.
      const changed = await vault.selectAddress(index, maxAddressIndex);
      dispatch(storeSelectedAddress({ index, address: changed.address }));

      // The cached balances belong to the address being left behind.
      invalidateAccountCache();
      await announceAddress();

      // Switching addresses repeatedly while this toast is still up reuses it
      // rather than stacking one per click, the same as `notify.copied`.
      notify.success('Address changed', { toastId: 'address-changed' });
    } catch (error) {
      notify.error(error);
    }
  };

  const addAddress = () => {
    const next = maxAddressIndex + 1;
    if (!setAddressInfo(walletName, { selectedAddressIndex, maxAddressIndex: next })) {
      notify.error('Could not save the new address. Try again.');
      return;
    }
    dispatch(storeMaxAddressIndex(next));
  };

  const rename = (address, label) => {
    setLabel(address, label);
    setLabelsState(getLabels());
  };

  return (
    <div className="page">
      <div className="address-list">
        {addresses.map((address, index) => (
          <ChangeAddressItem
            key={address}
            address={address}
            index={index}
            label={labels[address]}
            isSelected={selectedAddressIndex === index}
            onSelect={select}
            onRename={rename}
          />
        ))}

        {isLoading && !addresses.length && <p className="empty-note">Deriving addresses…</p>}
      </div>

      <button
        type="button"
        className="button secondary w-100 mt-2"
        onClick={addAddress}
        disabled={isLoading}
      >
        Add address
      </button>
    </div>
  );
};

export default ChangeAddress;
