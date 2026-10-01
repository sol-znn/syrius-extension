import React, { useEffect, useMemo, useRef, useState } from 'react';

import { authorizationMetadata } from '../../services/wallet/tokenMetadata';
import { formatAmount, truncateAddress } from '../../services/utils/format';

// The token select.
//
// Its selected option was found with
// `currentValue.token.tokenStandard === value`, comparing the SDK's
// `TokenStandard` object against the `zts1…` string the form holds. That is
// never true, so the control showed its placeholder no matter what was
// selected — including on the send screen, where the placeholder read "Select
// token" while a token was in fact selected and about to be sent.
//
// It also showed each option as a symbol and a truncated standard and nothing
// else, so there was no way to tell which of two tokens you had more of.
//
// This is a display, like the Tokens tab: a custom token is labelled with the
// symbol and decimals from the account's balance data. What is signed never
// reads these; the amount and the confirmation use authorizationMetadata,
// which knows only ZNN and QSR.
const displayOf = (option) => {
  const metadata = authorizationMetadata(option.token.tokenStandard);
  if (metadata.isNative) return { symbol: metadata.symbol, decimals: metadata.decimals };
  const { symbol, decimals } = option.token;
  return {
    symbol: typeof symbol === 'string' && symbol.trim() ? symbol : 'Custom token',
    decimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : 0,
  };
};

const TokenDropdown = React.forwardRef(
  ({ name, className, options = [], onChange, onBlur, value, placeholder, label }, ref) => {
    const [isOpen, setIsOpen] = useState(false);
    const rootRef = useRef(null);

    const selectedIndex = useMemo(
      () => options.findIndex((option) => option?.token?.tokenStandard?.toString() === value),
      [options, value]
    );

    useEffect(() => {
      if (!isOpen) {
        return undefined;
      }
      const onPointerDown = (event) => {
        if (!rootRef.current?.contains(event.target)) {
          setIsOpen(false);
          onBlur?.(event);
        }
      };
      document.addEventListener('mousedown', onPointerDown);
      return () => document.removeEventListener('mousedown', onPointerDown);
    }, [isOpen, onBlur]);

    const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
    const selectedDisplay = selected ? displayOf(selected) : null;

    return (
      <div className={`Dropdown-root ${isOpen ? 'is-open' : ''}`} ref={rootRef}>
        {label && <div className="dropdown-label">{label}</div>}

        <div
          className={`${className || ''} w-100 Dropdown-control`}
          tabIndex="0"
          role="button"
          ref={ref}
          onClick={() => setIsOpen((open) => !open)}
        >
          {selected ? (
            <span className="token-option">
              <span className="token-option-symbol">{selectedDisplay.symbol}</span>
              <span className="token-option-balance">{formatAmount(selected.balance, selectedDisplay.decimals)}</span>
            </span>
          ) : (
            <span>{placeholder}</span>
          )}
          <span className="Dropdown-arrow" />
        </div>

        {isOpen && (
          <div className="Dropdown-menu">
            {options.map((option, index) => {
              const zts = option?.token?.tokenStandard?.toString() || '';
              const display = displayOf(option);

              return (
                <div
                  className={`Dropdown-option ${index === selectedIndex ? 'is-selected' : ''}`}
                  key={zts || `${name}-option-${index}`}
                  onClick={() => {
                    setIsOpen(false);
                    onChange?.(index, option);
                  }}
                >
                  <span className="token-option">
                    <span className="token-option-symbol">{display.symbol}</span>
                    <span className="token-option-standard">{truncateAddress(zts, 8, 4)}</span>
                    <span className="token-option-balance">{formatAmount(option.balance, display.decimals)}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }
);

export default TokenDropdown;
