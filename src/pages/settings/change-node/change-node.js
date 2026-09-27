import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { Zenon } from 'znn-ts-sdk';

import NodeList from '../../../components/node-list/node-list';
import useNodeList from '../../../services/hooks/useNodeList';
import { storeChainIdentifier } from '../../../services/redux/connectionParametersSlice';
import { detectNodeChainId, mainnetChainId, parseChainId } from '../../../services/utils/chainId';
import { notify } from '../../../services/utils/notify';
import session from '../../../services/wallet/session';
import { announceChain } from '../../../services/wallet/announce';

// Node and chain settings.
//
// The chain identifier is signed into every block, so a wallet pointed at a
// devnet while still signing for mainnet produces blocks the node rejects with
// an error that says nothing about why. The node is asked what chain it is on
// and the mismatch is offered as a one-press fix.

const ChangeNode = () => {
  const dispatch = useDispatch();
  const nodeList = useNodeList();

  const [chainId, setChainId] = useState(() => Zenon.getChainIdentifier());
  const [draftChainId, setDraftChainId] = useState(() => String(Zenon.getChainIdentifier()));
  const [detected, setDetected] = useState({ isDetecting: true, chainId: null });

  const detect = useCallback(async () => {
    setDetected({ isDetecting: true, chainId: null });
    setDetected({ isDetecting: false, chainId: await detectNodeChainId(Zenon.getSingleton()) });
  }, []);

  useEffect(() => {
    detect();
  }, [detect, nodeList.currentNode]);

  // Nothing is reconnected here: the chain identifier is not a property of the
  // connection but of the blocks this wallet signs, and the SDK reads it back
  // from storage for every block it builds.
  const applyChainId = async (value) => {
    const activity = session.capture();
    const parsed = parseChainId(value);

    if (parsed === null) {
      notify.error('The chain identifier must be a whole number, 1 or higher.');
      return;
    }
    Zenon.setChainIdentifier(parsed);
    setChainId(parsed);
    setDraftChainId(String(parsed));
    dispatch(storeChainIdentifier(parsed));
    await announceChain(activity);

    notify.success(`Signing for chain ${parsed}`);
  };

  const detectedLabel = () => {
    if (detected.isDetecting) {
      return 'Asking the node…';
    }
    if (detected.chainId === null) {
      return 'This node did not report a chain';
    }
    return `This node is on chain ${detected.chainId}`;
  };

  const isMismatched =
    !detected.isDetecting && detected.chainId !== null && detected.chainId !== chainId;

  return (
    <div className="page">
      <NodeList
        nodes={nodeList.nodes}
        currentNode={nodeList.currentNode}
        onSelect={nodeList.select}
        onRemove={nodeList.remove}
        onAdd={nodeList.add}
        isValidNodeUrl={nodeList.isValidNodeUrl}
        disabled={nodeList.isConnecting}
      />

      <h3 className="section-title">Chain identifier</h3>

      <div className="chain-id-card">
        <div className="chain-id-card-data">
          <div className="chain-id-current">Signing for chain {chainId}</div>
          <div className="text-gray text-xs">{detectedLabel()}</div>
        </div>
      </div>

      {isMismatched && (
        <div className="chain-id-suggestion">
          <div className="text-xs">
            The node is on chain <b>{detected.chainId}</b> and this wallet signs for{' '}
            <b>{chainId}</b>. Blocks will be rejected until they match.
          </div>
          <button
            type="button"
            className="button secondary w-100 mt-2"
            onClick={() => applyChainId(detected.chainId)}
          >
            Use chain {detected.chainId}
          </button>
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          applyChainId(draftChainId);
        }}
      >
        <div className="custom-control">
          <div className="input-with-button w-100">
            <input
              className="w-100 custom-label pr-3"
              placeholder={`Chain identifier (${mainnetChainId} is mainnet)`}
              value={draftChainId}
              onChange={(event) => setDraftChainId(event.target.value)}
              inputMode="numeric"
              type="text"
            />
            <button type="submit" className="input-chip-button">
              Save
            </button>
          </div>
        </div>
      </form>

      {chainId !== mainnetChainId && (
        <button
          type="button"
          className="button secondary w-100"
          onClick={() => applyChainId(mainnetChainId)}
        >
          Back to mainnet
        </button>
      )}
    </div>
  );
};

export default ChangeNode;
