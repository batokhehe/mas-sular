/**
 * Trailing-edge debounce: the wrapped function runs once, `waitMs` after the LAST
 * call in a burst. Used to coalesce SSE-driven cache invalidations (an event storm
 * must not trigger a refetch per event), reusable for search inputs etc.
 */
export function trailingDebounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): { (...args: Args): void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Args): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return debounced;
}
