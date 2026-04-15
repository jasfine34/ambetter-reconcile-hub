import { useMemo } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { MetricCard } from '@/components/MetricCard';
import { DataTable } from '@/components/DataTable';

export default function EntitySummaryPage() {
  const { reconciled } = useBatch();

  const entityData = useMemo(() => {
    const coverall = reconciled.filter(r => r.actual_pay_entity === 'Coverall');
    const vix = reconciled.filter(r => r.actual_pay_entity === 'Vix');
    const ericaCoverell = reconciled.filter(r => r.issue_type === 'Erica Paid Under Coverall');
    const ericaVix = reconciled.filter(r => r.issue_type === 'Erica Paid Under Vix');

    return {
      coverallCount: coverall.length,
      coverallComm: coverall.reduce((s, r) => s + (r.actual_commission || 0), 0),
      vixCount: vix.length,
      vixComm: vix.reduce((s, r) => s + (r.actual_commission || 0), 0),
      ericaCoverallCount: ericaCoverell.length,
      ericaVixCount: ericaVix.length,
    };
  }, [reconciled]);

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
