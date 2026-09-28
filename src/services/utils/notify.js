import { toast } from 'react-toastify';
import { readableError } from './errors';

// Every toast in this wallet used to carry its own nine-line options object,
// and they had drifted: some closed after a second, some after five, some
// showed a progress bar, some paused on hover. Toasts are the wallet's only
// feedback channel for "it worked" and "it did not", so they are one thing now.

const base = {
  position: 'bottom-center',
  hideProgressBar: true,
  closeOnClick: true,
  pauseOnHover: true,
  draggable: false,
  newestOnTop: true,
  theme: 'dark',
};

// A success still gets its own shape — a green bar that fills across its top
// edge, and a small close button — but sits where every other toast does:
// bottom-center, with a gap above the edge of the popup. See
// `.toast-successbar` in Popup.scss.
const successBase = {
  ...base,
  autoClose: 2000,
  hideProgressBar: false,
  closeButton: true,
  className: 'toast-successbar',
};

// `vault.js` throws this whenever something asks for the key material and the
// wallet has none — which, once a person has locked it on purpose, is not a
// failure at all. A background operation that was already in flight (an
// auto-receive generating proof of work, a send still waiting on the node)
// can lose that race and hit this exact guard a moment after the lock screen
// has already replaced everything else, and there is nothing to tell anyone
// about: the wallet is locked because they just locked it.
const isExpectedLockError = (message) => /wallet is locked/i.test(message);

const notify = {
  success: (message, options = {}) =>
    toast(message, { ...successBase, type: 'success', ...options }),

  // Failures stay up longer than confirmations: one is read on the way past,
  // the other has to be acted on.
  error: (error, options = {}) => {
    const message = readableError(error);

    if (error?.code === 'WALLET_LOCKED' || isExpectedLockError(message)) {
      return null;
    }
    return toast(message, { ...base, type: 'error', autoClose: 5000, ...options });
  },

  info: (message, options = {}) =>
    toast(message, { ...base, type: 'info', autoClose: 3000, ...options }),

  // Acknowledgement of something the user just did to the clipboard. Shares
  // the success bar, and is still deliberately not stacking — copying an
  // address twice should not queue two.
  copied: (what = 'Copied') =>
    toast(what, { ...successBase, type: 'success', toastId: 'clipboard' }),

  // Whatever was on screen a moment ago belonged to the unlocked wallet — an
  // "Address changed" success bar, say. Locking should not leave it sitting
  // over the password screen for a person who no longer has a wallet open to
  // read it about.
  dismissAll: () => toast.dismiss(),
};

// Clipboard access can be refused, and every call site had its own try/catch
// that logged and then said nothing to the person who pressed the button.
const copyToClipboard = async (text, label = 'Copied') => {
  try {
    await navigator.clipboard.writeText(text);
    notify.copied(label);
    return true;
  } catch (err) {
    notify.error('Could not copy to the clipboard.');
    return false;
  }
};

export { notify, copyToClipboard };
export default notify;
