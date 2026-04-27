export const NPN_MAP = {
  '21055210': { name: 'Jason Fine', expectedPayEntity: 'Coverall' },
  '21277051': { name: 'Erica Fine', expectedPayEntity: 'Coverall_or_Vix' },
  '16531877': { name: 'Becky Shuta', expectedPayEntity: 'Coverall' },
} as const;

export const FILE_LABELS = [
  { label: 'EDE Summary', sourceType: 'EDE' as const, payEntity: null, aorBucket: null },
  { label: 'EDE Archived Enrolled', sourceType: 'EDE' as const, payEntity: null, aorBucket: null },
  { label: 'EDE Archived Not Enrolled', sourceType: 'EDE' as const, payEntity: null, aorBucket: null },
  { label: 'Jason Back Office', sourceType: 'BACK_OFFICE' as const, payEntity: null, aorBucket: 'Jason Fine' },
  { label: 'Erica Back Office', sourceType: 'BACK_OFFICE' as const, payEntity: null, aorBucket: 'Erica Fine' },
  { label: 'Becky Back Office', sourceType: 'BACK_OFFICE' as const, payEntity: null, aorBucket: 'Becky Shuta' },
  { label: 'Coverall Commission Statement', sourceType: 'COMMISSION' as const, payEntity: 'Coverall', aorBucket: null },
  { label: 'Vix Commission Statement', sourceType: 'COMMISSION' as const, payEntity: 'Vix', aorBucket: null },
] as const;

export const ISSUE_TYPES = [
  'Missing from Back Office',
  'Missing from Commission',
  'Paid but Missing from EDE',
  'SBA Enrollment (no FFM EDE expected)',
  'Back Office but Missing from EDE',
  'Not Eligible for Commission',
  'Wrong Pay Entity',
  'Erica Paid Under Coverall',
  'Erica Paid Under Vix',
  'Fully Matched',
] as const;

/**
 * State-Based Exchange (SBA) state codes. Coverall enrolls in these states via
 * SBA platforms whose EDE files are intentionally NOT uploaded to this app, so
 * commission-paid members from these states will appear without a matching FFM
 * EDE record. They are reclassified to 'SBA Enrollment (no FFM EDE expected)'
 * instead of polluting the 'Paid but Missing from EDE' exception queue.
 *
 * Detected via the matched Back Office record's `State` column (raw_json.State).
 * Extend this list when new SBA states come online.
 */
export const SBA_STATES = ['GA', 'IL', 'NJ', 'PA'] as const;

export const DEFAULT_COMMISSION_ESTIMATE = 18.00;
