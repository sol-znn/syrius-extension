import React from 'react';
import { useSelector } from 'react-redux';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import Dashboard from '../../pages/dashboard/dashboard/dashboard';
import Tokens from '../../pages/tokens/tokens';
import Delegate from '../../pages/delegate/delegate';
import Plasma from '../../pages/plasma/plasma';
import Stake from '../../pages/staking/stake/stake';
import Send from '../../pages/send-receive/send/send';
import Receive from '../../pages/send-receive/receive/receive';

import MenuHeader from '../../pages/menu/menu-header/menu-header';
import MenuTabs from '../../pages/menu/menu-tabs/menu-tabs';
import JournalNotice from '../../components/journal-notice/journal-notice';

import Settings from '../../pages/settings/settings/settings';
import ChangeNode from '../../pages/settings/change-node/change-node';
import ExportMnemonic from '../../pages/settings/export-mnemonic/export-mnemonic';
import ChangeAddress from '../../pages/settings/change-address/change-address';
import ChangePassword from '../../pages/settings/change-password/change-password';
import ConnectedSites from '../../pages/settings/connected-sites/connected-sites';
import SignMessage from '../../pages/settings/sign-message/sign-message';
import ResetWallet from '../../pages/settings/reset-wallet/reset-wallet';

// Which screens are somewhere you go into, rather than somewhere you are. Those
// get a back button and no bottom bar — a tab bar on a sub-screen invites you to
// leave without finishing what you opened it for.
const subScreens = {
  '/tabs/dashboard/send': 'Send',
  '/tabs/dashboard/receive': 'Receive',
  '/tabs/change-address': 'Addresses',
  '/tabs/settings': 'Settings',
  '/tabs/settings/change-node': 'Node',
  '/tabs/settings/export-mnemonic': 'Backup phrase',
  '/tabs/settings/change-password': 'Password',
  '/tabs/settings/connected-sites': 'Connected sites',
  '/tabs/settings/sign-message': 'Sign message',
  '/tabs/settings/reset-wallet': 'Remove wallet',
};

const TabsLayout = () => {
  const location = useLocation();
  const subScreenTitle = subScreens[location.pathname];
  const address = useSelector((state) => state.wallet.address);
  // A row appearing, settling or failing is each a reason to look again now
  // rather than at the next poll.
  const inFlight = useSelector((state) => state.pendingTransactions.items.map((item) => item.status).join());

  return (
    <div className="tabs-layout">
      <MenuHeader backButton={Boolean(subScreenTitle)} title={subScreenTitle || ''} />

      <main className="menu-layout">
        {/* Here rather than on the dashboard: a block whose outcome is unknown
            holds up sending from every screen, and it is settled from
            whichever one happens to be open. */}
        <JournalNotice address={address} refreshKey={inFlight} />
        <Routes location={location}>
          <Route index element={<Navigate to="/tabs/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="dashboard/send" element={<Send />} />
          <Route path="dashboard/receive" element={<Receive />} />

          <Route path="tokens" element={<Tokens />} />
          <Route path="delegate" element={<Delegate />} />
          <Route path="plasma" element={<Plasma />} />
          <Route path="stake" element={<Stake />} />

          <Route path="change-address" element={<ChangeAddress />} />
          <Route path="settings" element={<Settings />} />
          <Route path="settings/change-node" element={<ChangeNode />} />
          <Route path="settings/export-mnemonic" element={<ExportMnemonic />} />
          <Route path="settings/change-password" element={<ChangePassword />} />
          <Route path="settings/connected-sites" element={<ConnectedSites />} />
          <Route path="settings/sign-message" element={<SignMessage />} />
          <Route path="settings/reset-wallet" element={<ResetWallet />} />
        </Routes>
      </main>

      {!subScreenTitle && <MenuTabs />}
    </div>
  );
};

export default TabsLayout;
