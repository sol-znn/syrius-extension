import { useCallback, useContext, useState } from 'react';
import { useDispatch } from 'react-redux';
import { Zenon } from 'znn-ts-sdk';

import { SpinnerContext } from './spinner/spinnerContext';
import { storeIsConnected, storeNodeUrl } from '../redux/connectionParametersSlice';
import {
  defaultNodeUrl,
  getCurrentNodeUrl,
  getNodeList,
  setCurrentNodeUrl,
  setNodeList,
} from '../utils/storage';
import { notify } from '../utils/notify';
import { announceNode, captureLifetime } from '../wallet/announce';

// The node list, shared by the two screens that show it.
//
// `initial-node-selection.js` and `change-node.js` each had their own copy of
// the list, the add, the remove, the connect and a doubly-nested catch that
// reconnected to the previous node — about a hundred duplicated lines, and they
// had already drifted: one showed its errors top-center and the other
// bottom-center, and only one of them told connected sites the node had
// changed.

const isValidNodeUrl = (url) => /^wss?:\/\/.+/i.test((url || '').trim());

const useNodeList = () => {
  const dispatch = useDispatch();
  const { showSpinner, hideSpinner } = useContext(SpinnerContext);

  const [nodes, setNodes] = useState(() => getNodeList());
  const [currentNode, setCurrentNode] = useState(() => getCurrentNodeUrl() || defaultNodeUrl);
  const [isConnecting, setIsConnecting] = useState(false);

  const persist = (next) => {
    setNodes(next);
    setNodeList(next);
  };

  const add = useCallback(
    (url) => {
      const trimmed = (url || '').trim();

      if (!isValidNodeUrl(trimmed) || nodes.includes(trimmed)) {
        return false;
      }
      persist([...nodes, trimmed]);
      return true;
    },
    [nodes]
  );

  const remove = useCallback(
    (url) => {
      persist(nodes.filter((node) => node !== url));
    },
    [nodes]
  );

  // Connecting, with the previous node as the fallback. If the fallback is also
  // unreachable the wallet says so and carries on disconnected rather than
  // throwing a second error on top of the first — the header shows the state,
  // and the person is on the screen where they can fix it.
  const select = useCallback(
    async (url) => {
      const activity = captureLifetime();
      const previous = currentNode;
      const zenon = Zenon.getSingleton();

      setIsConnecting(true);
      showSpinner(`Connecting to ${url}`);

      try {
        zenon.clearSocketConnection();
        await zenon.initialize(url, false, 5000);

        setCurrentNode(url);
        setCurrentNodeUrl(url);
        dispatch(storeNodeUrl(url));
        dispatch(storeIsConnected(true));
        await announceNode(activity);

        notify.success('Connected');
        return true;
      } catch (err) {
        notify.error(err);

        try {
          zenon.clearSocketConnection();
          await zenon.initialize(previous, false, 5000);
          dispatch(storeIsConnected(true));
        } catch (fallbackError) {
          dispatch(storeIsConnected(false));
        }
        return false;
      } finally {
        hideSpinner();
        setIsConnecting(false);
      }
    },
    [currentNode, dispatch, hideSpinner, showSpinner]
  );

  return { nodes, currentNode, isConnecting, add, remove, select, isValidNodeUrl };
};

export default useNodeList;
