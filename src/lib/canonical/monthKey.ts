/**
 * Bundle 13b — month-key validation.
 */
export function isValidMonthKey(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  return /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function parseMonthKey(s: string): { year: number; month: number } | null {
  if (!isValidMonthKey(s)) return null;
  const [y, m] = s.split('-').map(Number);
  return { year: y, month: m };
}
