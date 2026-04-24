import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { DataTable } from '@/components/DataTable';
import { ResolvedBadge } from '@/components/ResolvedBadge';
import { lookupResolved } from '@/lib/resolvedIdentities';

const COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'exchange_subscriber_id', label: 'Sub ID' },
  { key: 'exchange_policy_id', label: 'Exchange Policy ID' },
  { key: 'issuer_policy_id', label: 'Issuer Policy ID' },
  { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
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

const RESOLVED_FIELD_TO_RESOLVED_KEY: Record<string, 'resolved_issuer_subscriber_id' | 'resolved_issuer_policy_id' | 'resolved_exchange_policy_id'> = {
  issuer_subscriber_id: 'resolved_issuer_subscriber_id',
  issuer_policy_id: 'resolved_issuer_policy_id',
  exchange_policy_id: 'resolved_exchange_policy_id',
};

export default function AllRecordsPage() {
  const { reconciled, resolverIndex } = useBatch();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">All Reconciled Records</h2>
          <p className="text-sm text-muted-foreground">{reconciled.length} total records</p>
        </div>
        <BatchSelector />
      </div>
      <DataTable
        data={reconciled}
        columns={COLUMNS}
        exportFileName="all_reconciled_records.csv"
        renderCell={(key, row) => {
          const resolvedKey = RESOLVED_FIELD_TO_RESOLVED_KEY[key];
          if (!resolvedKey) return undefined;
          const v = row[key];
          if (v == null || v === '') return undefined;
          if (!resolverIndex || resolverIndex.totalRows === 0) return undefined;
          const hit = lookupResolved(row as any, resolverIndex);
          // Heuristic: badge when the resolver has a hit AND its winning value
          // for this field matches what's displayed. Originals that happened to
          // already carry the same ID won't be badged unless they're part of a
          // multi-batch group (the resolver only writes rows for groups with
          // ≥2 records — single-batch members never get a badge).
          if (!hit) return undefined;
          const winning = (hit as any)[resolvedKey];
          if (!winning || String(winning) !== String(v)) return undefined;
          return <span>{String(v)}<ResolvedBadge sourceKind={hit.source_kind ?? undefined} batchMonth={hit.source_batch_month} /></span>;
        }}
      />
    </div>
  );
}
