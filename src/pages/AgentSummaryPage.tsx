import { useEffect, useMemo, useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { DataTable } from '@/components/DataTable';
import { MetricCard } from '@/components/MetricCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NPN_MAP } from '@/lib/constants';
import { extractNpnFromAorString } from '@/lib/agents';
import { getNormalizedRecords } from '@/lib/persistence';
import { filterCommissionRowsByScope, getExpectedPaymentBreakdown } from '@/lib/canonical';
import { computeFilteredEde } from '@/lib/expectedEde';
import { getCoveredMonths } from '@/lib/dateRange';
import { usePayEntityScope, type PayEntityScope } from '@/hooks/usePayEntityScope';
import {
  findWeakMatches,
  loadWeakMatchOverrides,
  applyOverrides,
  pickStableKey,
  type WeakMatchOverride,
} from '@/lib/weakMatch';

const AGENTS = Object.entries(NPN_MAP).map(([npn, info]) => ({ npn, ...info }));

/**
 * Canonical "Expected (AOR)" predicate — see ARCHITECTURE_PLAN.md §
 * Canonical Definitions. Matches the convention used by `aorBelongsToScope`
 * in src/lib/canonical/scope.ts:
 *   1. If the AOR string carries an embedded NPN like "Jason Fine (21055210)",
 *      that NPN must equal the agent's NPN.
 *   2. Otherwise, the lowercased AOR string must start with the agent's
 *      lowercased name.
 */
function aorMatchesAgent(currentPolicyAor: string | null | undefined, agent: { npn: string; name: string }): boolean {
  if (!currentPolicyAor) return false;
  const s = String(currentPolicyAor).trim();
  if (!s) return false;
  const embeddedNpn = extractNpnFromAorString(s);
  if (embeddedNpn) return embeddedNpn === agent.npn;
  return s.toLowerCase().startsWith(agent.name.toLowerCase());
}

/**
 * Agent Summary — per-agent breakdown.
 *
 * UNPAID ALIGNMENT (Phase 1.6, 2026-05-11): the Unpaid column previously
 * used the narrow legacy predicate
 *   r.in_ede && r.in_back_office && eligible='Yes' && !r.in_commission
 * which excluded BO Only and EDE Only unpaid rows (Becky=0 on Jan 2026 All;
 * canonical=75). Unpaid now derives from
 * `getExpectedPaymentBreakdown(...).unpaidRows` so each agent's count
 * reflects Matched + BO Only + EDE Only unpaid (paid rows and the
 * "BO Active: Non-current EDE" diagnostic remain excluded by helper
 * contract). Est. Missing is summed over the SAME canonical unpaid rows,
 * keeping count and dollars on one definition.
 *
 * SCOPE-AWARE (#65 fix, 2026-04-28): the per-agent commission $ column was
 * previously aggregated with hard-coded scope='All'. The page now reads the
 * SAME `usePayEntityScope` hook the Dashboard writes to, so the scope
 * dropdown is shared across both pages.
 */
export default function AgentSummaryPage() {
  const { reconciled, currentBatchId, batches, resolverIndex } = useBatch();
  const [normalizedRecords, setNormalizedRecords] = useState<any[]>([]);
  const [weakOverrides, setWeakOverrides] = useState<Map<string, WeakMatchOverride>>(new Map());
  const [scope, setScope] = usePayEntityScope();

  const currentBatch = useMemo(
    () => batches.find((b: any) => b.id === currentBatchId),
    [batches, currentBatchId],
  );
  const coveredMonths = useMemo(
    () => getCoveredMonths(currentBatch?.statement_month),
    [currentBatch?.statement_month],
  );

  useEffect(() => {
    if (!currentBatchId) { setNormalizedRecords([]); return; }
    let cancelled = false;
    getNormalizedRecords(currentBatchId)
      .then((recs) => {
        if (cancelled) return;
        setNormalizedRecords(recs as any[]);
      })
      .catch(() => { if (!cancelled) setNormalizedRecords([]); });
    return () => { cancelled = true; };
  }, [currentBatchId, reconciled.length]);

  // Mirror Dashboard's weak-match override hydration so the canonical
  // unpaid helper sees the same confirmedUpgradeMemberKeys set.
  useEffect(() => {
    let cancelled = false;
    loadWeakMatchOverrides()
      .then((map) => { if (!cancelled) setWeakOverrides(map); })
      .catch(() => { if (!cancelled) setWeakOverrides(new Map()); });
    return () => { cancelled = true; };
  }, [currentBatchId]);

  /**
   * Per-agent commission totals from raw commission rows, scoped by the
   * active pay-entity dropdown (Coverall / Vix / All).
   */
  const commissionByNpn = useMemo(() => {
    const map = new Map<string, number>();
    const rows = filterCommissionRowsByScope(normalizedRecords, scope);
    for (const r of rows) {
      const npn = String((r as any).agent_npn || '').trim();
      if (!npn) continue;
      const amt = Number((r as any).commission_amount) || 0;
      map.set(npn, (map.get(npn) || 0) + amt);
    }
    return map;
  }, [normalizedRecords, scope]);

  const filteredEde = useMemo(
    () => computeFilteredEde(normalizedRecords, reconciled, scope, coveredMonths, resolverIndex),
    [normalizedRecords, reconciled, scope, coveredMonths, resolverIndex],
  );

  // Replicate Dashboard's weak-match resolution → confirmed upgrade keys so
  // the canonical unpaid breakdown matches Dashboard exactly.
  const confirmedUpgradeMemberKeys = useMemo(() => {
    const out = new Set<string>();
    if (!filteredEde.uniqueMembers.length || !normalizedRecords.length || !weakOverrides.size) {
      return out;
    }
    const periodStart = currentBatch?.statement_month ?? null;
    const candidates = findWeakMatches(filteredEde.uniqueMembers, normalizedRecords, { periodStart });
    const { confirmedKeys } = applyOverrides(candidates, weakOverrides);
    if (!confirmedKeys.size) return out;
    for (const r of reconciled) {
      if (r.in_back_office) continue;
      const key = pickStableKey({
        issuer_subscriber_id: r.issuer_subscriber_id,
        exchange_subscriber_id: r.exchange_subscriber_id,
        policy_number: r.policy_number,
      });
      if (key && confirmedKeys.has(key)) out.add(r.member_key);
    }
    return out;
  }, [filteredEde, normalizedRecords, weakOverrides, reconciled, currentBatch?.statement_month]);

  /**
   * Canonical Expected But Unpaid universe (Matched + BO Only + EDE Only
   * unpaid). Diagnostic "BO Active: Non-current EDE" rows are excluded by
   * the helper contract.
   */
  const canonicalUnpaidRows = useMemo(
    () => getExpectedPaymentBreakdown(reconciled, scope, filteredEde, confirmedUpgradeMemberKeys).unpaidRows,
    [reconciled, scope, filteredEde, confirmedUpgradeMemberKeys],
  );

  // Group canonical unpaid rows by writing-agent NPN once so the per-row
  // table can read off count + summed estimated_missing_commission in O(1).
  const unpaidByNpn = useMemo(() => {
    const m = new Map<string, { count: number; estMissing: number }>();
    for (const r of canonicalUnpaidRows) {
      const npn = String((r as any).agent_npn || '').trim();
      if (!npn) continue;
      const entry = m.get(npn) ?? { count: 0, estMissing: 0 };
      entry.count += 1;
      entry.estMissing += Number((r as any).estimated_missing_commission) || 0;
      m.set(npn, entry);
    }
    return m;
  }, [canonicalUnpaidRows]);

  const agentData = useMemo(() =>
    AGENTS.map(agent => {
      const writingRecs = reconciled.filter(r => r.agent_npn === agent.npn);

      const expected = filteredEde.uniqueMembers.filter(m =>
        aorMatchesAgent(m.current_policy_aor, agent),
      ).length;

      const writtenBy = writingRecs.length;
      const bo = writingRecs.filter(r => r.in_back_office).length;
      const eligible = writingRecs.filter(r => r.eligible_for_commission === 'Yes').length;
      const paid = writingRecs.filter(r => r.in_commission).length;
      // CANONICAL Unpaid (Phase 1.6): Matched + BO Only + EDE Only unpaid
      // for this writing-agent NPN. Replaces the legacy narrow predicate
      // (in_ede ∧ in_back_office ∧ eligible='Yes' ∧ !in_commission).
      const unpaidEntry = unpaidByNpn.get(agent.npn);
      const unpaid = unpaidEntry?.count ?? 0;
      const totalComm = commissionByNpn.get(agent.npn) || 0;
      // Est. Missing now sums ONLY canonical unpaid rows for this agent,
      // matching the count above (single definition for count + dollars).
      const estMissing = unpaidEntry?.estMissing ?? 0;
      return {
        agent_name: agent.name,
        agent_npn: agent.npn,
        expected_count: expected,
        written_by_count: writtenBy,
        back_office_count: bo,
        eligible_count: eligible,
        paid_count: paid,
        unpaid_count: unpaid,
        total_paid_commission: totalComm,
        estimated_missing_commission: estMissing,
      };
    }),
  [reconciled, commissionByNpn, filteredEde, unpaidByNpn]);

  const columns = [
    { key: 'agent_name', label: 'Agent' },
    { key: 'agent_npn', label: 'NPN' },
    { key: 'expected_count', label: 'Expected (AOR)' },
    { key: 'written_by_count', label: 'Written by' },
    { key: 'back_office_count', label: 'Back Office' },
    { key: 'eligible_count', label: 'Eligible' },
    { key: 'paid_count', label: 'Paid' },
    { key: 'unpaid_count', label: 'Unpaid' },
    { key: 'total_paid_commission', label: 'Total Commission' },
    { key: 'estimated_missing_commission', label: 'Est. Missing' },
  ];

  // Disclose attribution scope: Unpaid totals across this table sum only
  // the displayed AOR agents' writing-NPNs. The aggregate row below
  // surfaces the remaining canonical Expected But Unpaid rows using THE
  // SAME filtered set the attribution-scope note counts — no second
  // predicate, no re-classification.
  const displayedNpns = useMemo(() => new Set(AGENTS.map((a) => a.npn)), []);
  const otherUnpaidRows = useMemo(
    () => canonicalUnpaidRows.filter((r: any) => !displayedNpns.has(String(r.agent_npn || '').trim())),
    [canonicalUnpaidRows, displayedNpns],
  );
  const otherUnpaidCount = otherUnpaidRows.length;
  const otherEstMissing = useMemo(
    () => otherUnpaidRows.reduce((sum: number, r: any) => sum + (Number(r.estimated_missing_commission) || 0), 0),
    [otherUnpaidRows],
  );
  const tableData = useMemo(() => {
    if (otherUnpaidCount === 0) return agentData;
    return [
      ...agentData,
      {
        agent_name: 'Other Writing NPNs (Aggregate)',
        agent_npn: '—',
        expected_count: 0,
        written_by_count: otherUnpaidCount,
        back_office_count: 0,
        eligible_count: 0,
        paid_count: 0,
        unpaid_count: otherUnpaidCount,
        total_paid_commission: 0,
        estimated_missing_commission: otherEstMissing,
      },
    ];
  }, [agentData, otherUnpaidCount, otherEstMissing]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-foreground">Agent Summary</h2>
        <div className="flex items-center gap-3">
          <Select value={scope} onValueChange={(v) => setScope(v as PayEntityScope)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Pay entity scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Coverall">Coverall</SelectItem>
              <SelectItem value="Vix">Vix</SelectItem>
              <SelectItem value="All">All (Combined)</SelectItem>
            </SelectContent>
          </Select>
          <BatchSelector />
        </div>
      </div>
      <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <strong className="text-foreground">Expected (AOR)</strong> counts members whose <code>currentPolicyAOR</code> on EDE
        matches this agent — the canonical "ownership" definition.{' '}
        <strong className="text-foreground">Written by</strong> counts members whose writing-agent NPN matches this agent.
        Commission dollar totals come from <code className="font-mono">filterCommissionRowsByScope</code> at the active{' '}
        <strong className="text-foreground">{scope}</strong> scope.
      </div>
      <div
        data-testid="agent-summary-attribution-note"
        className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
      >
        <strong className="text-foreground">Unpaid</strong> and <strong className="text-foreground">Est. Missing</strong>{' '}
        use the canonical Expected But Unpaid universe (Matched + BO Only + EDE Only unpaid), grouped by writing-agent
        NPN. This table only displays the active AOR agents in NPN_MAP (Jason, Erica, Becky); Expected But Unpaid rows
        written by other NPNs are not included here
        {otherUnpaidCount > 0 ? (
          <>
            {' '}— <strong className="text-foreground">{otherUnpaidCount.toLocaleString()}</strong> such row
            {otherUnpaidCount === 1 ? '' : 's'} at the current scope.
          </>
        ) : (
          <>.</>
        )}
      </div>
      <div className="grid grid-cols-3 gap-4">
        {agentData.map(a => (
          <MetricCard
            key={a.agent_npn}
            title={a.agent_name}
            value={`${a.expected_count} AOR / ${a.written_by_count} written`}
            subtitle={`${a.paid_count} paid · $${a.total_paid_commission.toLocaleString(undefined, { minimumFractionDigits: 2 })} commission`}
          />
        ))}
      </div>
      <DataTable data={tableData} columns={columns} exportFileName="agent_summary.csv" />
    </div>
  );
}
