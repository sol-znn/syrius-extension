// Sites may learn the node's host after consent, never credentials or private
// endpoint components. Keep the original URL for the wallet's own connection.
const publicNodeUrl = value => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname) return null;
    return `${url.protocol}//${url.host}`;
  } catch (error) {
    return null;
  }
};

export default publicNodeUrl;
