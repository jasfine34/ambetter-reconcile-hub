/**
 * Named Canary Ledger v1 — MT certification.
 *
 * Two layers:
 *
 *   1. Parser/shape validation (ALWAYS runs):
 *      - Reads `docs/named-canary-ledger.md`.
 *      - Parses the canary table.
 *      - Validates every non-TBD per-month cell value is one of the 9
 *        permitted `ClassificationState` enum literals.
 *      - Validates the table actually contains at least the 19 expected
 *        assertion rows (slots 1..15 with 7/9/14 scope-split).
 *      Any new shape/typo regression surfaces immediately on `npm test`.
 *
 *   2. Live MT classification (OPT-IN via RUN_SMOKE_CONTROLS=1):
 *      - Mirrors the production MemberTimelinePage computation path:
 *        getAllNormalizedRecordsForMemberTimeline → mergeRecordsToMemberKeys
 *        → buildMemberTimeline → classifyMember → applyNoSourceInvariant.
 *      - For each canary row × month, asserts the actual classified state
 *        matches the ledger's expectation.
 *      - Reports first 5 failures + total count. Does NOT flip the ledger.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const LEDGER_PATH = path.resolve(__dirname, '../../docs/named-canary-ledger.md');

const PERMITTED_STATES = new Set([
  'paid',
  'unpaid',
  'reversed',
  'not_expected_premium_unpaid',
  'not_expected_pre_eligibility',
  'not_expected_cancelled',
  'not_expected_not_ours',
  'pending',
  'manual_review',
]);

type Scope = 'All' | 'Vix' | 'Coverall';

interface CanaryRow {
  slot: string;
  canary: string;
  member: string;
  policy: string;
  scope: Scope;
  expected: Record<string, string>; // 'YYYY-MM' -> state
}

const MONTH_HEADERS: Array<{ label: string; key: string }> = [
  { label: 'Jan 2026', key: '2026-01' },
  { label: 'Feb 2026', key: '2026-02' },
  { label: 'Mar 2026', key: '2026-03' },
  { label: 'Apr 2026', key: '2026-04' },
];

function parseLedger(): { rows: CanaryRow[]; skipped: number } {
  const md = fs.readFileSync(LEDGER_PATH, 'utf8');
  const lines = md.split('\n');
  const headerIdx = lines.findIndex(l =>
    /^\|\s*#\s*\|\s*Canary\s*\|\s*Pattern\s*\|/.test(l),
  );
  if (headerIdx < 0) throw new Error('Could not find canary table header in ledger');
  // Skip header + separator
  const rows: CanaryRow[] = [];
  let skipped = 0;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 11) continue;
    const [slot, canary, _pattern, member, policy, scopeRaw, jan, feb, mar, apr] = cells;
    if ([member, policy, jan, feb, mar, apr].some(v => /TBD/i.test(v))) {
      skipped++;
      continue;
    }
    const expected: Record<string, string> = {
      '2026-01': jan,
      '2026-02': feb,
      '2026-03': mar,
      '2026-04': apr,
    };
    for (const [m, v] of Object.entries(expected)) {
      if (!PERMITTED_STATES.has(v)) {
        throw new Error(
          `Ledger parse error: row "${canary}" month ${m} has invalid state "${v}"`,
        );
      }
    }
    const scope = (scopeRaw as Scope);
    if (!['All', 'Vix', 'Coverall'].includes(scope)) {
      throw new Error(`Ledger parse error: row "${canary}" has invalid scope "${scopeRaw}"`);
    }
    rows.push({ slot, canary, member, policy, scope, expected });
  }
  return { rows, skipped };
}

describe('Named Canary Ledger v1 — parser/shape validation', () => {
  it('parses the ledger and validates all per-month states are permitted', () => {
    const { rows, skipped } = parseLedger();
    // 19 total rows; slot 15 (1 row) is TBD → 18 assertable. (slot 2 Adam
    // Shrum is filled, so only slot 15 is skipped.)
    expect(rows.length).toBeGreaterThanOrEqual(18);
    expect(skipped).toBeGreaterThanOrEqual(1);
    // Spot-check well-known canaries are present.
    const policies = new Set(rows.map(r => r.policy.toLowerCase()));
    for (const p of [
      'u96332808', 'u98019911', 'u96954671', 'u72991776', 'u96603414',
      'u97896137', 'u97385094', 'u70050073', 'u96757202', 'u71478796',
      'u70396792', 'u96806211', 'u97638656', 'u98544697',
    ]) {
      expect(policies.has(p)).toBe(true);
    }
  });
});

// ─────────────────────────── Live MT classification (opt-in) ───────────────────────────

const smokeIt = process.env.RUN_SMOKE_CONTROLS === '1' ? it : it.skip;

describe('Named Canary Ledger v1 — MT certification (live data)', () => {
  smokeIt('actual classified state matches expected for every canary cell', async () => {
    const { rows: ledgerRows } = parseLedger();

    const { getAllNormalizedRecordsForMemberTimeline } = await import('@/lib/persistence');
    const { loadResolverIndex } = await import('@/lib/resolvedIdentities');
    const { mergeRecordsToMemberKeys } = await import('@/lib/canonical/memberKeyMerge');
    const { buildMemberTimeline, buildMonthList, applyNoSourceInvariantToMonthCell } =
      await import('@/lib/memberTimeline');
    const { buildMonthPickerMapForMember } = await import('@/lib/canonical/edeMonthPicker');
    const {
      classifyMember,
      buildClassifierContext,
      buildIsDueEligibleRecord,
    } = await import('@/lib/classifier');
    const { getBatches } = await import('@/lib/persistence');

    const resolverIndex = await loadResolverIndex(true);
    const allRecords = await getAllNormalizedRecordsForMemberTimeline();
    mergeRecordsToMemberKeys(allRecords as any, resolverIndex);

    const batches = await getBatches();
    const batchMonthByBatchId = new Map<string, string>();
    for (const b of batches ?? []) {
      if (!b?.id || !b?.statement_month) continue;
      batchMonthByBatchId.set(String(b.id), String(b.statement_month).substring(0, 7));
    }

    const monthList = buildMonthList('2026-01', '2026-04');

    // Group scopes once — classifier output depends on aorScope+payEntity.
    interface ScopeConfig {
      aorScope: 'all' | 'official';
      payEntity: 'All' | 'Vix' | 'Coverall';
    }
    const scopeConfigs: Record<Scope, ScopeConfig> = {
      All: { aorScope: 'all', payEntity: 'All' },
      Vix: { aorScope: 'official', payEntity: 'Vix' },
      Coverall: { aorScope: 'official', payEntity: 'Coverall' },
    };

    const failures: string[] = [];

    for (const scope of ['All', 'Vix', 'Coverall'] as Scope[]) {
      const rowsForScope = ledgerRows.filter(r => r.scope === scope);
      if (rowsForScope.length === 0) continue;

      const cfg = scopeConfigs[scope];
      const isDueEligibleRecord = buildIsDueEligibleRecord(cfg);

      const rawRecordsByMemberKey = new Map<string, any[]>();
      for (const r of allRecords as any[]) {
        const key = r.member_key || r.applicant_name || 'unknown';
        let arr = rawRecordsByMemberKey.get(key);
        if (!arr) { arr = []; rawRecordsByMemberKey.set(key, arr); }
        arr.push(r);
      }

      const pickerMapsByMemberKey = new Map<string, Map<string, any>>();
      for (const [k, recs] of rawRecordsByMemberKey) {
        pickerMapsByMemberKey.set(k, buildMonthPickerMapForMember(recs as any, monthList));
      }

      const allRowsBuilt = buildMemberTimeline(
        allRecords as any,
        monthList,
        isDueEligibleRecord,
        {
          rawRecordsByMemberKey,
          pickerMapsByMemberKey,
          selectedAorScope: cfg.aorScope === 'official' ? 'official' : 'all',
          payEntity: cfg.payEntity,
        },
      );

      const classifierRecords = (allRecords as any[]).filter(isDueEligibleRecord);
      const classifierByMember = new Map<string, any[]>();
      for (const r of classifierRecords) {
        const key = r.member_key || r.applicant_name || 'unknown';
        let arr = classifierByMember.get(key);
        if (!arr) { arr = []; classifierByMember.set(key, arr); }
        arr.push(r);
      }
      const baseContext = buildClassifierContext(
        classifierRecords as any,
        monthList,
        [],
        { batchMonthByBatchId },
      );

      // Build a row lookup by policy_number (lowercased).
      const rowByPolicy = new Map<string, any>();
      for (const row of allRowsBuilt) {
        const pk = String(row.policy_number || '').trim().toLowerCase();
        if (pk) rowByPolicy.set(pk, row);
      }

      for (const canary of rowsForScope) {
        const row = rowByPolicy.get(canary.policy.toLowerCase());
        if (!row) {
          failures.push(`[${canary.canary}] scope=${scope} policy=${canary.policy} — NOT FOUND in MT rows`);
          continue;
        }
        const recs = classifierByMember.get(row.member_key) ?? [];
        const pickerForMember = pickerMapsByMemberKey.get(row.member_key);
        const context = { ...baseContext, pickerEdeByMonth: pickerForMember };
        const classification = recs.length
          ? classifyMember(recs as any, context)
          : { cells: {} as Record<string, any> };

        for (const m of monthList) {
          const expected = canary.expected[m];
          const c = classification.cells?.[m];
          const existing = row.cells[m];
          let actual: string | undefined;
          if (c && existing) {
            const stamped = applyNoSourceInvariantToMonthCell({
              ...existing,
              state: c.state,
              state_reason: c.reason,
              reversal_evidence: c.reversal_evidence,
            });
            actual = stamped.state;
          } else if (existing) {
            const stamped = applyNoSourceInvariantToMonthCell(existing);
            actual = stamped.state;
          }
          if (actual !== expected) {
            failures.push(
              `[${canary.canary}] scope=${scope} policy=${canary.policy} month=${m} expected=${expected} actual=${actual ?? '<none>'}`,
            );
          }
        }
      }
    }

    if (failures.length > 0) {
      const preview = failures.slice(0, 5).join('\n  ');
      throw new Error(
        `Named Canary Ledger v1 — ${failures.length} canary assertion(s) failed.\n  ${preview}${failures.length > 5 ? `\n  ...and ${failures.length - 5} more` : ''}`,
      );
    }
  }, 120000);
});
