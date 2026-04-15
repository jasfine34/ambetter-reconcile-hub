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
  'Back Office but Missing from EDE',
  'Not Eligible for Commission',
  'Wrong Pay Entity',
  'Erica Paid Under Coverall',
  'Erica Paid Under Vix',
  'Fully Matched',
] as const;

export const DEFAULT_COMMISSION_ESTIMATE = 18.00;
