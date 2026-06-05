/**
 * Phase C1a — live active-DMI denominator smoke (gated).
 *
 * Extracted from blocker-facts-c1a.test.ts to avoid Vitest module-mock
 * contamination (the purity test in that file vi.doMocks the supabase client)
 * and to give the live load a generous timeout. Default-skipped; run with
 * RUN_SMOKE_CONTROLS=1.
 */
import { describe, it, expect } from 'vitest';
import { getDmiSignal } from '@/lib/canonical/dmiSignal';

const smokeIt = process.env.RUN_SMOKE_CONTROLS === '1' ? it : it.skip;

describe('Phase C1a — live active-DMI denominator (RUN_SMOKE_CONTROLS=1 only)', () => {
  smokeIt(
    'measures total / paid-vs-unpaid / per-month active-DMI under picked-EDE definition',
    async () => {
      const { getAllNormalizedRecordsForMemberTimeline, getBatches } =
        await import('@/lib/persistence');
      const { loadResolverIndex } = await import('@/lib/resolvedIdentities');
      const { mergeRecordsToMemberKeys } = await import('@/lib/canonical/memberKeyMerge');
      const { buildMonthList } = await import('@/lib/memberTimeline');
      const { buildMonthPickerMapForMember } = await import('@/lib/canonical/edeMonthPicker');
      const {
        classifyMember,
        buildClassifierContext,
        buildIsDueEligibleRecord,
      } = await import('@/lib/classifier');
      const { latestAuthoritativeBoTermDates, makeBoRecency } =
        await import('@/lib/canonical/latestAuthoritativeBo');

      const resolverIndex = await loadResolverIndex(true);

      const batches = await getBatches();
      const batchMonthByBatchId = new Map<string, string>();
      const dedupBatchMonthByBatchId: Record<string, string> = {};
      for (const b of batches ?? []) {
        if (!b?.id || !b?.statement_month) continue;
        const m = String(b.statement_month).substring(0, 7);
        batchMonthByBatchId.set(String(b.id), m);
        dedupBatchMonthByBatchId[String(b.id)] = m;
      }

      const allRecords = await getAllNormalizedRecordsForMemberTimeline({
        batchMonthByBatchId: dedupBatchMonthByBatchId,
        onDiagnostic: (d) => console.log('[smoke dedup]', d.droppedCount, d.groupCount, d.unresolvedBatchMonthIds.length),
      });
      mergeRecordsToMemberKeys(allRecords as any, resolverIndex);
      const recency = makeBoRecency({ batchMonthByBatchId });
      const overlay = latestAuthoritativeBoTermDates(allRecords as any, recency);
      const monthList = buildMonthList('2026-01', '2026-04');

      const isDue = buildIsDueEligibleRecord({ aorScope: 'all', payEntity: 'All' });
      const scoped = (allRecords as any[]).filter(isDue);

      const byMember = new Map<string, any[]>();
      for (const r of scoped) {
        const k = r.member_key || r.applicant_name || 'unknown';
        let arr = byMember.get(k);
        if (!arr) { arr = []; byMember.set(k, arr); }
        arr.push(r);
      }

      const baseCtx = buildClassifierContext(scoped, monthList, [], {
        batchMonthByBatchId,
        latestAuthoritativeBoOverlay: overlay,
      });

      const perMonth = new Map<string, { paid: number; unpaid: number; other: number }>();
      for (const m of monthList) perMonth.set(m, { paid: 0, unpaid: 0, other: 0 });
      let total = 0;
      let totalPaid = 0;
      let totalUnpaid = 0;

      for (const [_k, recs] of byMember) {
        const picker = buildMonthPickerMapForMember(recs, monthList);
        const ctx = { ...baseCtx, pickerEdeByMonth: picker };
        const cls = classifyMember(recs, ctx);
        for (const m of monthList) {
          const picked = picker.get(m) ?? null;
          const sig = getDmiSignal(picked as any);
          if (!sig) continue;
          const cell = cls.cells[m];
          if (!cell) continue;
          total += 1;
          const bucket = perMonth.get(m)!;
          if (cell.state === 'paid') { totalPaid += 1; bucket.paid += 1; }
          else if (cell.state === 'unpaid') { totalUnpaid += 1; bucket.unpaid += 1; }
          else { bucket.other += 1; }
        }
      }

      // eslint-disable-next-line no-console
      console.log('[C1a denominator]', {
        total, totalPaid, totalUnpaid,
        perMonth: Object.fromEntries(perMonth),
      });
      expect(total).toBeGreaterThanOrEqual(0);
    },
    120_000,
  );
});
