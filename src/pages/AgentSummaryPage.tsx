import { useEffect, useMemo, useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { DataTable } from '@/components/DataTable';
import { MetricCard } from '@/components/MetricCard';
import { NPN_MAP } from '@/lib/constants';
import { extractNpnFromAorString } from '@/lib/agents';
import { getNormalizedRecords } from '@/lib/persistence';
import { filterCommissionRowsByScope } from '@/lib/canonical';

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
 * Two distinct attributions per agent (see ARCHITECTURE_PLAN.md):
 *   - **Expected (AOR)**: members whose canonical `current_policy_aor` matches
 *     this agent. This is the EE-universe ownership count.
 *   - **Written by**: reconciled members where this agent's NPN appears as the
 *     writing agent. Drives the historical paid / unpaid / commission columns
 *     (commission flows through writing-agent NPN on Ambetter statements).
 *
 * Commission dollar totals are sourced from RAW commission rows via the
 * canonical `filterCommissionRowsByScope` helper, then grouped by writing-agent
 * NPN. This guarantees the per-agent "Total Commission" column ties out to
 * the Dashboard's Net Paid Commission card and to Entity Summary at the same
 * scope (within $0.01) — no roll-up drift from per-member aggregates.
 */
export default function AgentSummaryPage() {
  const { reconciled, currentBatchId } = useBatch();
  const [normalizedRecords, setNormalizedRecords] = useState<any[]>([]);

  useEffect(() => {
    if (!currentBatchId) { setNormalizedRecords([]); return; }
    let cancelled = false;
    getNormalizedRecords(currentBatchId)
      .then((recs) => {
        if (cancelled) return;
        setNormalizedRecords(recs as any[]);
        if (typeof console !== 'undefined') {
          const comm = (recs as any[]).filter((r) => r.source_type === 'COMMISSION');
          const peSamples = Array.from(new Set(comm.slice(0, 50).map((r) => r.pay_entity)));
          // eslint-disable-next-line no-console
          console.debug('[AgentSummary] normalizedRecords loaded', {
            batchId: currentBatchId,
            total: (recs as any[]).length,
            commissionRows: comm.length,
            payEntitySamples: peSamples,
          });
        }
      })
      .catch(() => { if (!cancelled) setNormalizedRecords([]); });
    return () => { cancelled = true; };
  }, [currentBatchId, reconciled.length]);

  /**
   * Per-agent commission totals from raw commission rows (canonical scope =
   * 'All' so we count every dollar this writing agent earned across both pay
   * entities — Coverall and Vix — which matches the page's historical column
   * semantics).
   */
  const commissionByNpn = useMemo(() => {
    const map = new Map<string, number>();
    const rows = filterCommissionRowsByScope(normalizedRecords, 'All');
    for (const r of rows) {
      const npn = String((r as any).agent_npn || '').trim();
      if (!npn) continue;
      const amt = Number((r as any).commission_amount) || 0;
      map.set(npn, (map.get(npn) || 0) + amt);
    }
    return map;
  }, [normalizedRecords]);

  const agentData = useMemo(() =>
    AGENTS.map(agent => {
      // Writing-agent scoped reconciled rows (drives BO / eligible / paid /
      // unpaid / est-missing). Commission $ comes from raw rows above.
      const writingRecs = reconciled.filter(r => r.agent_npn === agent.npn);

      // Canonical "Expected (AOR)" — count by current_policy_aor matching
      // this agent (NPN-embedded or name-prefix), within the EE universe.
      const expected = reconciled.filter(r =>
        r.is_in_expected_ede_universe && aorMatchesAgent(r.current_policy_aor, agent),
      ).length;

      const writtenBy = writingRecs.length;
      const bo = writingRecs.filter(r => r.in_back_office).length;
      const eligible = writingRecs.filter(r => r.eligible_for_commission === 'Yes').length;
      const paid = writingRecs.filter(r => r.in_commission).length;
      const unpaid = writingRecs.filter(r =>
        r.in_ede && r.in_back_office && r.eligible_for_commission === 'Yes' && !r.in_commission,
      ).length;
      // CANONICAL: from raw commission rows (NOT sum of actual_commission).
      const totalComm = commissionByNpn.get(agent.npn) || 0;
      const estMissing = writingRecs.reduce((s, r) => s + (r.estimated_missing_commission || 0), 0);
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
  [reconciled, commissionByNpn]);

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-foreground">Agent Summary</h2>
        <BatchSelector />
      </div>
      <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <strong className="text-foreground">Expected (AOR)</strong> counts members whose <code>currentPolicyAOR</code> on EDE
        matches this agent — the canonical "ownership" definition.{' '}
        <strong className="text-foreground">Written by</strong> counts members whose writing-agent NPN matches this agent.
        Commission dollar totals come from the canonical{' '}
        <code className="font-mono">filterCommissionRowsByScope</code> helper and tie to the Dashboard's Net Paid card.
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
      <DataTable data={agentData} columns={columns} exportFileName="agent_summary.csv" />
    </div>
  );
}
