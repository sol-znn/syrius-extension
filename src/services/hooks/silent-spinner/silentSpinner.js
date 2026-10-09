import React, { useContext } from 'react';
import ReactDOM from 'react-dom';
import { SilentSpinnerContext } from './silentSpinnerContext';

// Portalled into the header, so background work reads as the wallet being busy
// rather than as a dialog demanding attention.
const SilentSpinner = () => {
  const { silentSpinner, silentSpinnerContent } = useContext(SilentSpinnerContext);
  const root = document.querySelector('#pow-spinner-root');

  if (!silentSpinner || !root) {
    return null;
  }

  return ReactDOM.createPortal(
    <div className="pow-spinner-container" role="status" aria-label={silentSpinnerContent || 'Working…'} title={silentSpinnerContent}>
      <img alt="" src={require('./../../../assets/spinner.svg')} className="pow-spinner" />
      <span className="pow-spinner-content" aria-hidden="true">Working…</span>
    </div>,
    root
  );
};

export default SilentSpinner;
