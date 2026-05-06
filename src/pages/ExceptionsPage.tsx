import { useMemo } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { DataTable } from '@/components/DataTable';
import { ISSUE_TYPES, getIssueTypeLabel, getIssueTypeTooltip } from '@/lib/constants';
import { IdentityResolutionConflictsPanel } from '@/components/IdentityResolutionConflictsPanel';

const COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'aor_bucket', label: 'AOR' },
  { key: 'in_ede', label: 'EDE' },
  { key: 'in_back_office', label: 'Back Office' },
  { key: 'in_commission', label: 'Commission' },
  { key: 'eligible_for_commission', label: 'Eligible' },
  { key: 'expected_pay_entity', label: 'Expected Entity' },
  { key: 'actual_pay_entity', label: 'Actual Entity' },
  { key: 'actual_commission', label: 'Commission $' },
  { key: 'estimated_missing_commission', label: 'Est. Missing $' },
  { key: 'issue_type', label: 'Issue Type' },
  { key: 'issue_notes', label: 'Notes' },
];

export default function ExceptionsPage() {
  const { reconciled } = useBatch();

  const exceptions = useMemo(() =>
    reconciled.filter(r => r.issue_type !== 'Fully Matched'),
  [reconciled]);

  const chips = useMemo(() =>
    ISSUE_TYPES.filter(t => t !== 'Fully Matched').map(t => {
      const count = exceptions.filter(e => e.issue_type === t).length;
      return {
        label: `${getIssueTypeLabel(t)} (${count})`,
        value: t,
        field: 'issue_type',
        tooltip: getIssueTypeTooltip(t),
        _count: count,
      };
    }).filter(c => c._count > 0),
  [exceptions]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Exception Queue</h2>
          <p className="text-sm text-muted-foreground">{exceptions.length} exceptions found</p>
        </div>
        <BatchSelector />
      </div>
      <DataTable
        data={exceptions}
        columns={COLUMNS}
        exportFileName="exception_queue.csv"
        filterChips={chips}
        renderCell={(key, row) =>
          key === 'issue_type' ? getIssueTypeLabel(String(row.issue_type ?? '')) : undefined
        }
      />
      <IdentityResolutionConflictsPanel />
    </div>
  );
}
