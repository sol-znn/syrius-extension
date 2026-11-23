// Every error this wallet shows a person, by number.
//
// A number is shown beside its text ("Wrong password. (E200)") so that a
// report names one thing: the same wording in two places is one entry, and two
// entries never share a number. Numbers are never reused; a retired entry
// keeps its line with the text it had.
//
// The hundreds say where it comes from:
//   1xx general, storage, the extension's own plumbing
//   2xx the wallet: session, lock, password, removal, settings
//   3xx the Zenon node and Zenon blocks
//   4xx pillars, Accelerator-Z, tokens, sporks
//   5xx to 7xx are left free: the EVM branch numbers its errors there
//   8xx sites and approvals
//
// Text in braces is filled in by `fail(id, {…})` (./errors.js), which also
// cuts whatever is put there to one short line. `{reason}` is what a node
// said: it is shown when it is a short plain sentence, and otherwise the text
// ends before it and the reason goes to the console. It is always the last
// thing in its entry.
//
// Checked in utils/error-catalog-test.js: every throw in `src` is one of
// these, and nothing here can carry a stack, JSON or a hex dump to the screen.

const catalog = {
  // General
  100: 'Something went wrong. Try again.',
  101: 'Could not copy to the clipboard.',
  102: 'Could not save settings. Try again.',
  103: 'No response from the extension background',
  104: 'The extension background did not answer {method}',
  105: 'The requesting document has left',
  106: 'CoinGecko responded {status}',
  107: 'no momentum',
  108: 'The node connection was lost.',
  // What a form refused, in the form's own words.
  110: '{text}',
  // Updating an unpacked install (services/update)
  120: 'That folder is not this extension. Pick the one it was loaded from.',
  121: 'That folder is not this extension any more. Choose it again.',
  122: 'The {version} release could not be downloaded.',
  123: 'The download does not match its published checksum. Nothing was written.',
  124: 'The download is not this extension. Nothing was written.',
  125: 'The download is version {found}, not a newer {version}. Nothing was written.',
  126: 'No version to update to.',
  127: 'Downloading the release needs access to GitHub.',
  128: 'Writing the update needs access to the folder.',
  129: 'Not a usable release archive: {detail}',
  // The app's stand-in for the extension API (platform/mobileShim.js)
  130: 'Not available in the app.',
  131: 'No response from the wallet background',
  132: 'No pillar is named {name}.',
  133: 'Give the contact a name.',
  134: 'That QR code holds no Zenon address.',
  135: 'Fingerprints or Face ID changed on this phone. Unlock with the password and turn it on again in Settings.',
  136: 'Installing the QR scanner. Try again in a moment.',
  137: 'Generating plasma failed. Try again.',

  // The wallet
  200: 'Wrong password.',
  201: 'The wallet session ended. Unlock it again.',
  202: 'Could not confirm the wallet session. Other wallet windows may still be unlocked. Try again or close the browser.',
  203: 'The wallet or account changed. Unlock and review a new request.',
  204: 'Could not lock all wallet windows. Try again or close the browser.',
  205: 'Could not save the selected address. Try again.',
  206: 'The wallet changed before it could be locked. Try again.',
  207: 'Choose a supported lock duration.',
  208: 'A mode is on or off.',
  209: 'Choose a theme.',
  213: 'The wallet or its saved data changed. Try removing it again.',
  214: 'Wallet metadata could not be read safely. No wallet was removed.',
  215: 'The selected wallet changed. Try again.',
  216: 'The wallet removal was canceled or the selected wallet changed.',
  217: 'Could not disconnect the sites using this wallet. Try again.',
  218: 'Choose a wallet first.',
  219: 'Could not save the new address. Try again.',
  220: 'This wallet has no recovery phrase stored.',
  221: 'Could not read or restore the wallet session. Other wallet windows may still be unlocked. Try again or close the browser.',
  222: 'Encrypted wallet data could not be created safely. No wallet was saved.',
  223: 'Saved wallet data could not be read safely. No wallet was saved.',
  224: 'The selected account changed. Refresh the wallet and try again.',
  225: 'Saved wallet data could not be read safely. Your saved data has not been changed. Retry or close and reopen the browser.',

  // The Zenon node and Zenon blocks
  300: 'The node refused this: {reason}',
  302: 'Not enough plasma. Fuse QSR or wait for the proof of work to finish.',
  303: 'Not enough balance for this transaction.',
  304: 'That address is not a valid Zenon address.',
  305: 'Cannot reach the node. Check the node URL in settings.',
  306: 'The node did not answer in time.',
  307: 'The signing account changed.',
  308: 'The transaction may have been submitted. Its outcome is unknown. Check the original account before retrying.',
  309: 'Not enough balance for this transfer',
  310: 'The account or token changed. Review this transfer again.',
  311: 'That is not a valid Zenon address',
  312: 'Enter a whole number from 1 to 9007199254740991.',
  313: 'The node returned duplicate token identities',
  314: 'The node returned conflicting token identities',
  315: 'The node returned invalid token decimals',
  316: 'The amount must be a nonnegative integer of base units',
  317: 'Enter a positive token amount',
  318: 'Enter a positive integer number of base units',
  319: '{done} of {total} fuses were cancelled. The rest were not: try them again.',
  320: 'Select a fuse to cancel.',
  321: 'Another transaction from this account landed first. Nothing was sent. Check the account, then send again.',
  322: 'This wallet\'s transaction records could not be read. Nothing was sent.',
  323: 'An earlier transaction from this account has an unknown outcome. The wallet is checking it. Nothing new was signed.',
  324: 'This account has {count} transactions on record that are not settled yet. Wait for them to confirm.',
  325: 'Another transaction from this account is still being sent. Try again in a moment.',
  326: 'This account\'s turn to send passed to another window. Nothing was sent.',
  327: 'The transaction was sent but the node did not answer. The wallet will check its outcome. Do not send it again.',
  328: 'The node did not identify its network.',

  // Pillars, Accelerator-Z, tokens, sporks
  400: 'Choose Yes, No or Abstain.',
  401: 'Unknown call {contract}.{method}',
  402: '{method} takes {count} values',
  403: 'Nothing to update.',
  404: '{name} is taken.',
  405: 'The stored project list cannot be brought up to date: {reason}',
  406: 'The node is not on the chain the project list came from: {reason}',
  410: 'A custom id needs fused plasma. Fuse QSR to this address, or issue without one.',
  411: 'This block cannot be searched. Issue without a custom id.',
  412: 'Search canceled.',
  413: 'The search failed.',
  414: 'Another block from this address landed during the search. Search again.',
  415: 'The signed block would not give the id found.',
  430: 'That message is too long. Shorten it.',
  431: 'No address received anything in the last 7 days.',
  432: 'Enter an amount of ZNN or QSR.',
  433: 'Only part of the zap was sent: the {sent} left, the {failed} did not.',

  // Sites and approvals
  800: 'This approval expired. Ask the site for a new request.',
  801: 'Approval expired during finalization.',
  802: 'The connection permission could not be saved.',
  803: 'Connected-site revocations are unavailable. Retry disconnecting.',
  804: 'The connection was not accepted before its approval expired.',
  805: 'This response ID is already pending in this document.',
  806: 'Unsupported or noncanonical contract arguments',
  807: 'Approval expired after processing began. Verify the outcome before retrying.',
  808: 'This request must be submitted again.',
  809: 'This approval expired, was answered or changed. Review a new request.',
  810: 'Wallet request exceeds the supported JSON or metadata limits.',
  811: 'The wallet has too many requests. Wait and retry.',
  812: 'This page request is no longer active. Ask the site to request it again.',
  813: 'The submitted transaction outcome is unknown. Verify it before retrying.',
  814: 'Approval expired or was canceled. Verify any submitted result before retrying.',
  815: 'Earlier wallet work is still stopping. Wait a few seconds and retry.',
  816: 'The wallet node is not connected.',
  817: 'Approval proof of work was canceled.',
  818: 'Approval proof of work failed.',
  819: 'Invalid proof-of-work worker response.',
  820: 'This approval is no longer current. Review a new request.',
  821: 'Could not disconnect this account. Try again.',
  822: 'Could not disconnect all accounts. Try again.',
};

export default catalog;
