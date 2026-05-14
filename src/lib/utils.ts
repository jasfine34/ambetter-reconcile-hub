import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Bundle 13c — currency formatter for clearing-aware surfaces.
 *  - null / undefined / NaN → '--'
 *  - 100 → '$100.00'
 *  - -50 → '-$50.00'
 *  - { signed: true } → always include sign ('+$100.00' / '-$50.00')
 */
export function formatMoney(amount: number | null | undefined, opts?: { signed?: boolean }): string {
  if (amount === null || amount === undefined) return '--';
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return '--';
  const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (opts?.signed) return `${n < 0 ? '-' : '+'}$${abs}`;
  return `${n < 0 ? '-' : ''}$${abs}`;
}
