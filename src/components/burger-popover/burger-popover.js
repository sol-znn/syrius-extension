import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';

import { notify } from '../../services/utils/notify';
import lockWallet from '../../services/wallet/lock';
import { resetWalletState } from '../../services/redux/walletSlice';
import { resetPendingTransactions } from '../../services/redux/pendingTransactionsSlice';
import { invalidateAccountCache } from '../../services/hooks/useAccount';

// The menu behind the header button.
//
// It had a "Help&Support" row that was wired to nothing at all — it looked like
// a control, and pressing it did nothing, which is worse than not being there.
// It also had an "Add wallet" that cleared the background's cached password and
// walked off to the create-wallet flow without locking anything, leaving the
// previous wallet's keys in memory.

const Item = ({ onClick, icon, children }) => (
  <button type="button" className="burger-popover-item" onClick={onClick}>
    {icon}
    <span className="ml-2 white-space-nowrap">{children}</span>
  </button>
);

const BurgerPopover = ({ onNavigate = () => {} }) => {
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const go = (path) => {
    onNavigate();
    navigate(path);
  };

  const leave = async (destination) => {
    onNavigate();
    let locked = false;
    try { await lockWallet(); locked = true; }
    catch (error) { notify.error(error); }
    invalidateAccountCache();
    dispatch(resetWalletState());
    dispatch(resetPendingTransactions());
    navigate(locked ? destination : '/password', { replace: true });
  };
  const lock = () => leave('/password');

  return (
    <div className="burger-popover-container" role="menu">
      <Item
        onClick={() => go('/tabs/change-address')}
        icon={
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              className="isColorable"
              d="M4.7 6.5h9.2l-1.1.9a.7.7 0 0 0 .9 1.1l2.8-2.1a.7.7 0 0 0 0-1.1l-2.7-2.1a.7.7 0 1 0-.9 1.1l1.1.9H4.7a.7.7 0 0 0 0 1.4Zm11.3 5h-9.2l1.1-.9a.7.7 0 1 0-.9-1.1l-2.8 2.1a.7.7 0 0 0 0 1.1l2.7 2.1a.7.7 0 1 0 .9-1.1l-1.1-.9H16a.7.7 0 0 0 0-1.4Z"
              fill="currentColor"
            />
          </svg>
        }
      >
        Change address
      </Item>

      <Item
        onClick={() => go('/tabs/settings/connected-sites')}
        icon={
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              className="isColorable"
              d="M8.2 11.8a3.4 3.4 0 0 0 5.1.4l2.1-2.1a3.4 3.4 0 1 0-4.8-4.8l-1.2 1.2M11.8 8.2a3.4 3.4 0 0 0-5.1-.4l-2.1 2.1a3.4 3.4 0 1 0 4.8 4.8l1.2-1.2"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        }
      >
        Connected sites
      </Item>

      <Item
        onClick={() => go('/tabs/settings')}
        icon={
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              className="isColorable"
              d="M7.08 2.07a1.25 1.25 0 0 0 1.84 0l.6-.66a1.2 1.2 0 0 1 2.16.89l-.05.89a1.25 1.25 0 0 0 1.3 1.3l.89-.05a1.2 1.2 0 0 1 .88 2.16l-.66.6a1.25 1.25 0 0 0 0 1.83l.66.6a1.2 1.2 0 0 1-.88 2.16l-.89-.05a1.25 1.25 0 0 0-1.3 1.3l.05.89a1.2 1.2 0 0 1-2.16.88l-.6-.66a1.25 1.25 0 0 0-1.84 0l-.59.66a1.2 1.2 0 0 1-2.16-.88l.04-.89a1.25 1.25 0 0 0-1.3-1.3l-.88.05a1.2 1.2 0 0 1-.89-2.16l.66-.6a1.25 1.25 0 0 0 0-1.83l-.66-.6a1.2 1.2 0 0 1 .89-2.16l.88.05a1.25 1.25 0 0 0 1.3-1.3l-.04-.89a1.2 1.2 0 0 1 2.16-.89l.59.66Z"
              fill="currentColor"
            />
            <path d="M8 10.95a2.84 2.84 0 1 0 0-5.68 2.84 2.84 0 0 0 0 5.68Z" fill="#1B1B1B" />
          </svg>
        }
      >
        Settings
      </Item>

      <Item
        onClick={() => leave('/auth/onboarding')}
        icon={
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path
              className="isColorable"
              d="M9 2.5v13M2.5 9h13"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          </svg>
        }
      >
        Add wallet
      </Item>

      <Item
        onClick={lock}
        icon={
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path
              className="isColorable"
              fillRule="evenodd"
              clipRule="evenodd"
              d="M1.89 8.43c0-1.05.94-1.9 2.09-1.9h9.77c1.15 0 2.09.85 2.09 1.9v6.29c0 1.05-.94 1.89-2.09 1.89H3.98c-1.15 0-2.09-.84-2.09-1.89V8.43Zm7.96 1.62a1.4 1.4 0 1 0-1.68 2.2v1.44a.7.7 0 0 0 1.4 0v-1.44a1.4 1.4 0 0 0 .28-2.2Z"
              fill="currentColor"
            />
            <path
              className="isColorable"
              d="M8.86 1.5c-1.54 0-2.87.58-3.7 1.51-.83.94-1.18 2.16-1.18 3.47v1.95h2.09V6.48c0-1 .27-1.78.72-2.29.45-.5 1.05-.8 2.07-.8 1.02 0 1.62.28 2.07.78.45.5.72 1.3.72 2.3v.69h2.09v-.69c0-1.31-.37-2.54-1.2-3.48-.83-.94-2.14-1.5-3.68-1.5Z"
              fill="currentColor"
            />
          </svg>
        }
      >
        Lock wallet
      </Item>
    </div>
  );
};

export default BurgerPopover;
