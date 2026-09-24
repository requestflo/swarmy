import * as React from 'react';

/** `value`, settled for `ms` — keeps a search box from firing a query per keystroke. */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
