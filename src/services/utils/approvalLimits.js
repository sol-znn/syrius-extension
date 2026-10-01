// Admission policy shared by the isolated relay and worker. The browser has
// already decoded a message when these checks run; this bounds wallet work,
// not all browser-process traffic or allocation.
const limits = Object.freeze({ bytes: 128 * 1024, depth: 32, nodes: 20000,
  pending: 16, perOrigin: 2, activeHandlers: 32, ttl: 30 * 60 * 1000,
  globalAttention: 5000, originAttention: 30000, history: 64 });
const invalid = () => Object.assign(new Error('Wallet request exceeds the supported JSON or metadata limits.'), { code: -32602 });
const busy = () => Object.assign(new Error('The wallet has too many requests. Wait and retry.'), { code: -32005 });
const validResponseId = id => (typeof id === 'string' && id.length > 0 && id.length <= 128) ||
  (typeof id === 'number' && Number.isFinite(id));

// Count JSON UTF-8 bytes without recursively walking/stringifying unbounded
// input. The stack and every string, key and collection are themselves bounded.
const boundedJson = value => {
  const stack = [{ value, depth: 0 }], seen = new WeakSet();
  let bytes = 0, nodes = 0;
  const charge = n => { bytes += n; if (bytes > limits.bytes) throw invalid(); };
  const string = text => {
    if (text.length > limits.bytes) throw invalid();
    charge(2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) charge(2);
      else if (c < 32) charge(6);
      else if (c < 128) charge(1);
      else if (c < 2048) charge(2);
      else if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { charge(4); i++; }
      else if (c >= 0xd800 && c <= 0xdfff) charge(6);
      else charge(3);
    }
  };
  while (stack.length) {
    const { value: item, depth } = stack.pop();
    if (++nodes > limits.nodes || depth > limits.depth) throw invalid();
    if (item === null) charge(4);
    else if (typeof item === 'string') string(item);
    else if (typeof item === 'boolean') charge(item ? 4 : 5);
    else if (typeof item === 'number' && Number.isFinite(item)) charge(JSON.stringify(item).length);
    else if (item && typeof item === 'object') {
      if (seen.has(item)) throw invalid();
      seen.add(item);
      if (Array.isArray(item)) {
        if (item.length + nodes + stack.length > limits.nodes) throw invalid();
        charge(2 + Math.max(0, item.length - 1));
        for (let i = 0; i < item.length; i++) stack.push({ value: item[i], depth: depth + 1 });
      } else {
        if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw invalid();
        charge(2); let fields = 0;
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          fields++;
          if (nodes + stack.length + 1 > limits.nodes) throw invalid();
          const property = Object.getOwnPropertyDescriptor(item, key);
          if (!property || !Object.hasOwn(property, 'value')) throw invalid();
          string(key); charge(fields === 1 ? 1 : 2);
          stack.push({ value: property.value, depth: depth + 1 });
        }
      }
    } else throw invalid();
  }
  return bytes;
};
const validateEnvelope = request => {
  if (!validResponseId(request.id) || typeof request.method !== 'string' || request.method.length > 64) throw invalid();
  boundedJson({ id: request.id, method: request.method, params: request.params ?? null });
};
export { limits, invalid, busy, boundedJson, validateEnvelope, validResponseId };
