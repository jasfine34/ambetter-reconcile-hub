import { useEffect, useMemo, useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { MetricCard } from '@/components/MetricCard';
import { DataTable } from '@/components/DataTable';
import { getNormalizedRecords } from '@/lib/persistence';
import { getNetPaidCommission } from '@/lib/canonical';

/**
 * Entity Summary — high-level Coverall vs Vix breakdown.
 *
 * IMPORTANT: All commission totals on this page MUST use canonical helpers
 * (`getNetPaidCommission` from src/lib/canonical) so they tie out to the
 * Dashboard's Net Paid Commission card EXACTLY. Historical drift here was
 * caused by aggregating `actual_commission` from reconciled members, which
 * collapses some inter-member roll-ups and produced $36,727.50 vs the
 * canonical $36,640.50 on Mar 2026 Coverall scope. Always source dollar
 * totals from raw COMMISSION normalized rows via the canonical helpers.
 */
export default function EntitySummaryPage() {
  const { reconciled, currentBatchId } = useBatch();
  const [normalizedRecords, setNormalizedRecords] = useState<any[]>([]);

  useEffect(() => {
    if (!currentBatchId) { setNormalizedRecords([]); return; }
    let cancelled = false;
    getNormalizedRecords(currentBatchId)
      .then((recs) => { if (!cancelled) setNormalizedRecords(recs as any[]); })
      .catch(() => { if (!cancelled) setNormalizedRecords([]); });
    return () => { cancelled = true; };
  }, [currentBatchId]);

  const entityData = useMemo(() => {
    const coverallPaidCount = reconciled.filter(
      (r) => r.actual_pay_entity === 'Coverall' && r.in_commission,
    ).length;
    const vixPaidCount = reconciled.filter(
      (r) => r.actual_pay_entity === 'Vix' && r.in_commission,
    ).length;
    const ericaCoverall = reconciled.filter((r) => r.issue_type === 'Erica Paid Under Coverall').length;
    const ericaVix = reconciled.filter((r) => r.issue_type === 'Erica Paid Under Vix').length;

    // Canonical Net Paid: from raw COMMISSION normalized rows (matches the
    // Dashboard's Net Paid Commission card exactly).
    const coverallNet = getNetPaidCommission(normalizedRecords, 'Coverall').net;
    const vixNet = getNetPaidCommission(normalizedRecords, 'Vix').net;

    return {
      coverallCount: coverallPaidCount,
      coverallComm: coverallNet,
      vixCount: vixPaidCount,
      vixComm: vixNet,
      ericaCoverallCount: ericaCoverall,
      ericaVixCount: ericaVix,
    };
  }, [reconciled, normalizedRecords]);

  const tableData = [
    { entity: 'Coverall', paid_count: entityData.coverallCount, total_commission: entityData.coverallComm },
    { entity: 'Vix', paid_count: entityData.vixCount, total_commission: entityData.vixComm },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-foreground">Entity Summary</h2>
        <BatchSelector />
      </div>
      <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        Commission totals are sourced from the canonical{' '}
        <code className="font-mono">getNetPaidCommission</code> helper and tie out to the Dashboard's
        Net Paid Commission card exactly.
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard title="Coverall Paid" value={entityData.coverallCount} variant="info" />
        <MetricCard title="Coverall Commission" value={`$${entityData.coverallComm.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} variant="success" />
        <MetricCard title="Vix Paid" value={entityData.vixCount} variant="info" />
        <MetricCard title="Vix Commission" value={`$${entityData.vixComm.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} variant="success" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <MetricCard title="Erica Paid Under Coverall" value={entityData.ericaCoverallCount} />
        <MetricCard title="Erica Paid Under Vix" value={entityData.ericaVixCount} />
      </div>
      <DataTable
        data={tableData}
        columns={[
          { key: 'entity', label: 'Entity' },
          { key: 'paid_count', label: 'Paid Count' },
          { key: 'total_commission', label: 'Total Commission' },
        ]}
        exportFileName="entity_summary.csv"
      />
    </div>
  );
}
