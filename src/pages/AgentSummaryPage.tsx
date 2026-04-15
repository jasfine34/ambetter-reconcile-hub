import { useMemo } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { DataTable } from '@/components/DataTable';
import { MetricCard } from '@/components/MetricCard';
import { NPN_MAP } from '@/lib/constants';

const AGENTS = Object.entries(NPN_MAP).map(([npn, info]) => ({ npn, ...info }));

export default function AgentSummaryPage() {
  const { reconciled } = useBatch();

  const agentData = useMemo(() =>
    AGENTS.map(agent => {
      const recs = reconciled.filter(r => r.agent_npn === agent.npn);
      const expected = recs.filter(r => r.in_ede).length;
      const bo = recs.filter(r => r.in_back_office).length;
      const eligible = recs.filter(r => r.eligible_for_commission === 'Yes').length;
      const paid = recs.filter(r => r.in_commission).length;
      const unpaid = recs.filter(r => r.in_ede && r.in_back_office && r.eligible_for_commission === 'Yes' && !r.in_commission).length;
      const totalComm = recs.reduce((s, r) => s + (r.actual_commission || 0), 0);
      const estMissing = recs.reduce((s, r) => s + (r.estimated_missing_commission || 0), 0);
      return {
        agent_name: agent.name,
        agent_npn: agent.npn,
        expected_count: expected,
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
    { key: 'expected_count', label: 'Expected' },
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
      <div className="grid grid-cols-3 gap-4">
        {agentData.map(a => (
          <MetricCard key={a.agent_npn} title={a.agent_name} value={`${a.paid_count} paid / ${a.expected_count} expected`} subtitle={`$${a.total_paid_commission.toLocaleString(undefined, { minimumFractionDigits: 2 })} commission`} />
        ))}
      </div>
      <DataTable data={agentData} columns={columns} exportFileName="agent_summary.csv" />
    </div>
  );
}
