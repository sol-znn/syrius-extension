// document.open reuses the Document but removes Window/DOM event listeners.
// A private observer survives that reset. Check its queued records at every
// provider/relay entry point too, before allowing an old request to be used.
const observeDocumentLifetime = ({ onHide, onShow, onReset, install }) => {
  const listen = window.addEventListener.bind(window);
  let root = document.documentElement;
  let observer;
  const attach = () => {
    listen('pagehide', hide, true);
    listen('pageshow', show, true);
    install();
  };
  const check = (records = observer.takeRecords()) => {
    const current = document.documentElement;
    // A removed root counts even if the page reinserts that same node before
    // this microtask; ordinary changes inside the root do not end requests.
    const removed = records.some(record => record.target === document &&
      Array.from(record.removedNodes).some(node => node.nodeType === 1));
    const reset = removed || current !== root;
    root = current;
    if (reset) { attach(); onReset(); }
  };
  const hide = () => { check(); onHide(); };
  const show = event => { check(); onShow(event); };
  observer = new MutationObserver(check);
  observer.observe(document, { childList: true });
  attach();
  return Object.freeze({ check });
};
export default observeDocumentLifetime;
