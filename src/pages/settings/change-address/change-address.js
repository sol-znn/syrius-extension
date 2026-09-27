import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import ChangeAddressItem from '../../../components/change-address-item/change-address-item';
import { storeMaxAddressIndex, storeSelectedAddress } from '../../../services/redux/walletSlice';
import { getLabels, setLabel, setAddressInfo } from '../../../services/utils/storage';
import { notify } from '../../../services/utils/notify';
import { announceAddress } from '../../../services/wallet/announce';
import { invalidateAccountCache } from '../../../services/hooks/useAccount';
import session from '../../../services/wallet/session';
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
    const activity = session.capture();
    try {
      if (!activity || activity.walletName !== walletName) throw new Error('Unlock this wallet again.');
      const token = await session.select(activity, index, maxAddressIndex, (selectedAddress) => {
        dispatch(storeSelectedAddress({ index, address: selectedAddress }));
        invalidateAccountCache();
      });
      await announceAddress(token);
      notify.success('Address changed', { toastId: 'address-changed' });
    } catch (error) { notify.error(error); }
  };

  const addAddress = () => {
    const next = maxAddressIndex + 1;
    setAddressInfo(walletName, { selectedAddressIndex, maxAddressIndex: next });
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
