// Quotes preserve empty strings and whitespace. Formatting controls are escaped
// visibly, including a leading BOM, rather than changing the apparent value.
const escapeCodeUnits = char => Array.from({ length: char.length }, (_, index) =>
  '\\u' + char.charCodeAt(index).toString(16).padStart(4, '0')).join('');
const displayString = text => JSON.stringify(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, escapeCodeUnits);

// Preserve ordinary line breaks. Escape literal backslashes as well so that
// someone reading the preview can tell a typed escape from an actual control.
const displayApprovalMessage = text => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/gu, char => {
  if (char === '\n') return char;
  return char === '\\' ? '\\\\' : escapeCodeUnits(char);
});

export { displayApprovalMessage, displayString };
