/**
 * Returns the first value in the list that, when trimmed, is a nonblank string.
 * Returns null if none qualify.
 *
 * Use this INSTEAD OF nullish coalescing (??) when blank strings should be
 * skipped (e.g., EDE rows where clientState='' but state='FL').
 */
export function firstNonblankString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
