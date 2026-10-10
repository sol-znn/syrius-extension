// Errors reach the UI from three places and none of them agree on a shape: the
// SDK throws strings, the websocket client throws `{code, message}` from the
// node, and anything else throws an Error. Every page used to end with its own
// copy of a `split("Error: ")` chain that took the last fragment, which turned
// a nested message into a fragment of itself and an object into "[object Object]".

// Node RPC messages that are accurate and useless. A person who just pressed
// Send needs to know what to do next, not which contract rejected the block.
const knownMessages = [
  {
    // go-zenon's refusals of a block whose place on the account chain is taken
    // or gone (verifier/errors.go, chain/account_pool.go). What happened is
    // that another block from this account got there first: a second device
    // on the same seed, usually. The wallet's own windows take turns.
    match: /prevHash exists but it has a cemented block|prevHeight is cemented|previous block is missing|plasma ratio is smaller|hash tie-break is worse/i,
    text: 'Another transaction from this account landed first. Nothing was sent. Check the account, then send again.',
  },
  {
    match: /not enough plasma|plasma.*insufficient/i,
    text: 'Not enough plasma. Fuse QSR or wait for the proof of work to finish.',
  },
  {
    match: /insufficient balance|not enough balance/i,
    text: 'Not enough balance for this transaction.',
  },
  {
    match: /invalid address|address.*invalid|checksum/i,
    text: 'That address is not a valid Zenon address.',
  },
  {
    match: /connection|websocket|socket|ECONNREFUSED|not connected/i,
    text: 'Cannot reach the node. Check the node URL in settings.',
  },
  {
    match: /error decrypting|invalid password|unable to decrypt/i,
    text: 'Wrong password.',
  },
  { match: /timeout/i, text: 'The node did not answer in time.' },
];

// Pulls the most specific string an unknown throwable is carrying.
const rawMessage = (error) => {
  if (error === null || error === undefined) {
    return '';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message || error.toString();
  }
  if (typeof error === 'object') {
    // The websocket client rejects with the node's JSON-RPC error object.
    if (error.message) {
      return typeof error.message === 'string' ? error.message : JSON.stringify(error.message);
    }
    if (error.error) {
      return rawMessage(error.error);
    }
    try {
      return JSON.stringify(error);
    } catch (err) {
      return '';
    }
  }
  return error.toString();
};

// Strips the layers of `Error: Error: ...` the SDK accumulates as it rethrows,
// without the old habit of keeping only the fragment after the last colon —
// that discarded the useful half of any message that contained one.
const stripErrorPrefixes = (text) => {
  let result = text.trim();
  let previous;

  do {
    previous = result;
    result = result.replace(/^(Uncaught\s+)?Error:\s*/i, '').trim();
  } while (result !== previous);

  return result;
};

// One line, sentence-shaped, safe to put in a toast.
const readableError = (error, fallback = 'Something went wrong.') => {
  const stripped = stripErrorPrefixes(rawMessage(error));

  if (!stripped) {
    return fallback;
  }
  const known = knownMessages.find((entry) => entry.match.test(stripped));
  if (known) {
    return known.text;
  }
  // Long node errors are usually a stack or a serialised block; keep the head.
  const firstLine = stripped.split('\n')[0].trim();
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
};

export { readableError, rawMessage };
