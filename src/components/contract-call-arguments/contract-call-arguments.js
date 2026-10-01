import React from 'react';

const ContractCallArguments = ({ args }) => args.length ? (
  <dl className="contract-arguments">
    {args.map(argument => (
      <React.Fragment key={argument.name}>
        <dt>{argument.label}</dt>
        <dd>{argument.display}</dd>
      </React.Fragment>
    ))}
  </dl>
) : <p className="approval-note">This method has no arguments.</p>;
export default ContractCallArguments;
