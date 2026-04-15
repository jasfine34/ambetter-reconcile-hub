import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { DataTable } from '@/components/DataTable';

const COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'exchange_subscriber_id', label: 'Sub ID' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'agent_npn', label: 'NPN' },
  { key: 'aor_bucket', label: 'AOR' },
  { key: 'in_ede', label: 'EDE' },
  { key: 'in_back_office', label: 'Back Office' },
  { key: 'in_commission', label: 'Commission' },
  { key: 'eligible_for_commission', label: 'Eligible' },
  { key: 'expected_pay_entity', label: 'Expected Entity' },
  { key: 'actual_pay_entity', label: 'Actual Entity' },
  { key: 'actual_commission', label: 'Commission $' },
  { key: 'issue_type', label: 'Issue' },
];

export default function AllRecordsPage() {
  const { reconciled } = useBatch();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">All Reconciled Records</h2>
          <p className="text-sm text-muted-foreground">{reconciled.length} total records</p>
        </div>
        <BatchSelector />
      </div>
      <DataTable data={reconciled} columns={COLUMNS} exportFileName="all_reconciled_records.csv" />
    </div>
  );
}
