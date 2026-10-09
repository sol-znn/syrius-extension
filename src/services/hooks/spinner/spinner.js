import React, { useContext } from 'react';
import ReactDOM from 'react-dom';
import { SpinnerContext } from './spinnerContext';

const Spinner = () => {
  const { spinner, spinnerContent } = useContext(SpinnerContext);
  const root = document.querySelector('#spinner-root');

  if (!spinner || !root) {
    return null;
  }

  return ReactDOM.createPortal(
    <div className="spinner-backdrop">
      <div className="spinner-container text-white" role="status">
        <img alt="" src={require('./../../../assets/spinner.svg')} className="spinner" />
        <div className="spinner-content">{spinnerContent}</div>
      </div>
    </div>,
    root
  );
};

export default Spinner;
