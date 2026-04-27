import { useMemo } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { DataTable } from '@/components/DataTable';
import { MetricCard } from '@/components/MetricCard';
import { NPN_MAP } from '@/lib/constants';
import { extractNpnFromAorString } from '@/lib/agents';

const AGENTS = Object.entries(NPN_MAP).map(([npn, info]) => ({ npn, ...info }));

/**
 * Returns true if the canonical AOR string on a reconciled member belongs to
 * this agent. Matching is in two passes:
 *   1. If the AOR string has an embedded NPN like "Jason Fine (21055210)",
 *      that NPN must equal the agent's NPN.
 *   2. Otherwise, the lowercased AOR string must start with the agent's
 *      lowercased name.
 *
 * This is the canonical "Expected" definition — see ARCHITECTURE_PLAN.md
 * § Canonical Definitions and the comment block at the top of normalize.ts.
 */
function aorMatchesAgent(currentPolicyAor: string | null | undefined, agent: { npn: string; name: string }): boolean {
  if (!currentPolicyAor) return false;
  const s = String(currentPolicyAor).trim();
  if (!s) return false;
  const embeddedNpn = extractNpnFromAorString(s);
  if (embeddedNpn) return embeddedNpn === agent.npn;
  return s.toLowerCase().startsWith(agent.name.toLowerCase());
}

export default function AgentSummaryPage() {
  const { reconciled } = useBatch();

  const agentData = useMemo(() =>
    AGENTS.map(agent => {
      // Writing-agent scoped: anything where this agent's NPN appears as the
      // writing agent on a reconciled record. Used for "Written by" + the
      // historical eligible / paid / commission totals (commission flows
      // through writing agent NPN, not AOR, on Ambetter statements).
      const writingRecs = reconciled.filter(r => r.agent_npn === agent.npn);

      // Canonical "Expected" — count by current_policy_aor (AOR-of-record).
      // This is the policyholder's chosen agent on EDE, not the writing agent.
      const expected = reconciled.filter(r =>
        r.is_in_expected_ede_universe && aorMatchesAgent(r.current_policy_aor, agent),
      ).length;

      const writtenBy = writingRecs.length;
      const bo = writingRecs.filter(r => r.in_back_office).length;
      const eligible = writingRecs.filter(r => r.eligible_for_commission === 'Yes').length;
      const paid = writingRecs.filter(r => r.in_commission).length;
      const unpaid = writingRecs.filter(r => r.in_ede && r.in_back_office && r.eligible_for_commission === 'Yes' && !r.in_commission).length;
      const totalComm = writingRecs.reduce((s, r) => s + (r.actual_commission || 0), 0);
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
  [reconciled]);

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
        These are intentionally separate: an agent can write a policy whose AOR is held by someone else, and vice versa.
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
