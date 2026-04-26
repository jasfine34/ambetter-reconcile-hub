import { useEffect, useState } from 'react';

/**
 * Returns `value` only after it has remained unchanged for `delay` ms.
 * Used to throttle API calls behind text inputs (search boxes, filters).
 */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
