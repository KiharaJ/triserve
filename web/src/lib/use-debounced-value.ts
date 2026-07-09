import { useEffect, useState } from 'react'

/**
 * Debounces a fast-changing value (search inputs) so dependent queries don't
 * fire on every keystroke (Task 1.5: customer/model search, board filters).
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
