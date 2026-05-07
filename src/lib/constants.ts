export const NPN_MAP = {
  '21055210': { name: 'Jason Fine', expectedPayEntity: 'Coverall' },
  '21277051': { name: 'Erica Fine', expectedPayEntity: 'Coverall_or_Vix' },
  '16531877': { name: 'Becky Shuta', expectedPayEntity: 'Coverall' },
} as const;

/**
 * Writing-agent NPNs whose commissions are owned by Coverall even though the
 * NPN is NOT one of our active AORs (Jason / Erica / Becky). Examples:
 *  - Downline agents who write under our hierarchy
 *  - Former Coverall AORs whose existing book still pays to Coverall
 *  - Carrier service-desk NPNs labeled e.g. "Coverall Health Group Call Center"
 *
 * Use via `isCoverallOwnedWritingNPN(npn)`. This is intentionally SEPARATE
 * from NPN_MAP so it does NOT change AOR-string resolution, scope semantics,
 * or any predicate today. It is a metadata layer for ownership-attribution
 * audits (e.g., classifying P4 leakage rows where current_policy_aor is
 * blank/foreign but the writing agent is Coverall-owned).
 *
 * Add new NPNs here as they're verified (DOI lookup or Jason confirmation).
 */
export const COVERALL_OWNED_WRITING_NPNS: Record<string, { name: string; reason: string }> = {
  '21077804': { name: 'Allen Ford', reason: 'Downline agent under Coverall hierarchy' },
  '21574255': { name: 'Hantz Pierre', reason: 'Former Coverall agent; book still pays to Coverall' },
  '15978551': { name: "Scott O'Toole", reason: "Verified via DOI lookup; carrier feed labels NPN as 'Coverall Health Group Call Center'" },
};

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

export type IssueType = (typeof ISSUE_TYPES)[number];

/**
 * Display labels for issue_type enum values. The underlying enum strings are
 * persisted in `reconciled_members.issue_type` and used as predicate keys
 * across reconcile, classifier, exports, and tests — they MUST NOT change.
 *
 * These labels are UI-only renames (#119, #120 from the Phase 1 audit) that
 * make the chip labels reflect the literal predicate they apply, so users
 * stop conflating Exception-queue chips with Dashboard EE-universe metrics
 * of similar-sounding names.
 *
 * Use `getIssueTypeLabel(issueType)` instead of rendering the raw enum string
 * in any user-facing context.
 */
export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  'Missing from Back Office': 'Has EDE Row but Not in Back Office',
  'Missing from Commission': 'Eligible & In BO but No Commission Row',
  'Paid but Missing from EDE': 'Paid but Missing from EDE',
  'SBA Enrollment (no FFM EDE expected)': 'SBA Enrollment (no FFM EDE expected)',
  'Back Office but Missing from EDE': 'Back Office but Missing from EDE',
  'Not Eligible for Commission': 'Not Eligible for Commission',
  'Wrong Pay Entity': 'Wrong Pay Entity',
  'Erica Paid Under Coverall': 'Erica Paid Under Coverall',
  'Erica Paid Under Vix': 'Erica Paid Under Vix',
  'Fully Matched': 'Fully Matched',
};

/**
 * Per-issue-type tooltip copy clarifying the literal predicate vs. the
 * similar-sounding Dashboard EE-universe metrics. Surface in chip / card
 * tooltips so operators understand what each Exception bucket actually
 * counts.
 */
export const ISSUE_TYPE_TOOLTIPS: Partial<Record<IssueType, string>> = {
  'Missing from Back Office':
    'Members with an EDE row whose policy is NOT present in any Back Office export. Distinct from Dashboard "Not in BO" (which is scoped to the current EE universe).',
  'Missing from Commission':
    'Members eligible for commission AND found in Back Office, but with no matching commission row. Mutually exclusive with Wrong Pay Entity / Erica Paid Under Coverall / Erica Paid Under Vix.',
};

export function getIssueTypeLabel(issueType: string): string {
  return (ISSUE_TYPE_LABELS as Record<string, string>)[issueType] ?? issueType;
}

export function getIssueTypeTooltip(issueType: string): string | undefined {
  return (ISSUE_TYPE_TOOLTIPS as Record<string, string | undefined>)[issueType];
}

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
