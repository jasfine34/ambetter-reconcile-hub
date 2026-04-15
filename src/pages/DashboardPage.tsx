import { useMemo, useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { MetricCard } from '@/components/MetricCard';
import { DataTable } from '@/components/DataTable';
import { BatchSelector } from '@/components/BatchSelector';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, Building2, DollarSign, AlertTriangle, CheckCircle2, XCircle, FileText, TrendingDown, Database } from 'lucide-react';

const RECON_COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'aor_bucket', label: 'AOR' },
  { key: 'in_ede', label: 'EDE' },
  { key: 'in_back_office', label: 'Back Office' },
  { key: 'in_commission', label: 'Commission' },
  { key: 'eligible_for_commission', label: 'Eligible' },
  { key: 'actual_pay_entity', label: 'Pay Entity' },
  { key: 'actual_commission', label: 'Commission $' },
  { key: 'issue_type', label: 'Issue' },
];

export default function DashboardPage() {
  const { reconciled, loading, counts } = useBatch();
  const [drilldown, setDrilldown] = useState<string | null>(null);

  const metrics = useMemo(() => {
    const expected = reconciled.filter(r => r.in_ede).length;
    const foundBO = reconciled.filter(r => r.in_ede && r.in_back_office).length;
    const eligible = reconciled.filter(r => r.in_ede && r.in_back_office && r.eligible_for_commission === 'Yes').length;
    const shouldPay = eligible;
    const actuallyPaid = reconciled.filter(r => r.in_commission).length;
    const unpaid = reconciled.filter(r => r.in_ede && r.in_back_office && r.eligible_for_commission === 'Yes' && !r.in_commission).length;
    const totalComm = reconciled.reduce((s, r) => s + (r.actual_commission || 0), 0);
    const estMissing = reconciled.reduce((s, r) => s + (r.estimated_missing_commission || 0), 0);
    return { expected, foundBO, eligible, shouldPay, actuallyPaid, unpaid, totalComm, estMissing };
  }, [reconciled]);

  const drilldownData = useMemo(() => {
    if (!drilldown) return null;
    switch (drilldown) {
      case 'expected': return reconciled.filter(r => r.in_ede);
      case 'foundBO': return reconciled.filter(r => r.in_ede && r.in_back_office);
      case 'eligible': return reconciled.filter(r => r.in_ede && r.in_back_office && r.eligible_for_commission === 'Yes');
      case 'paid': return reconciled.filter(r => r.in_commission);
      case 'unpaid': return reconciled.filter(r => r.in_ede && r.in_back_office && r.eligible_for_commission === 'Yes' && !r.in_commission);
      default: return reconciled;
    }
  }, [drilldown, reconciled]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Reconciliation Dashboard</h2>
          <p className="text-sm text-muted-foreground">Ambetter Commission Reconciliation</p>
        </div>
        <BatchSelector />
      </div>

      <Card className="border-dashed">
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Database className="h-4 w-4" /> Debug Counts (Selected Batch)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3 pt-0">
          <div className="flex gap-6 text-sm">
            <span className="text-muted-foreground">Uploaded Files: <strong className="text-foreground">{counts.uploadedFiles}</strong></span>
            <span className="text-muted-foreground">Normalized Records: <strong className="text-foreground">{counts.normalizedRecords}</strong></span>
            <span className="text-muted-foreground">Reconciled Members: <strong className="text-foreground">{counts.reconciledMembers}</strong></span>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="text-center py-20 text-muted-foreground">Loading...</div>
      ) : reconciled.length === 0 ? (
        <div className="text-center py-20">
          <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground">No reconciliation data yet. Upload files to get started.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard title="Expected Enrollments" value={metrics.expected} icon={<Users className="h-4 w-4" />} onClick={() => setDrilldown('expected')} />
            <MetricCard title="Found in Back Office" value={metrics.foundBO} icon={<Building2 className="h-4 w-4" />} variant="info" onClick={() => setDrilldown('foundBO')} />
            <MetricCard title="Eligible for Commission" value={metrics.eligible} icon={<CheckCircle2 className="h-4 w-4" />} variant="success" onClick={() => setDrilldown('eligible')} />
            <MetricCard title="Should Be Paid" value={metrics.shouldPay} icon={<DollarSign className="h-4 w-4" />} />
            <MetricCard title="Actually Paid" value={metrics.actuallyPaid} icon={<CheckCircle2 className="h-4 w-4" />} variant="success" onClick={() => setDrilldown('paid')} />
            <MetricCard title="Unpaid Policies" value={metrics.unpaid} icon={<XCircle className="h-4 w-4" />} variant="destructive" onClick={() => setDrilldown('unpaid')} />
            <MetricCard title="Total Paid Commission" value={`$${metrics.totalComm.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} icon={<DollarSign className="h-4 w-4" />} variant="success" />
            <MetricCard title="Est. Missing Commission" value={`$${metrics.estMissing.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} icon={<TrendingDown className="h-4 w-4" />} variant="warning" />
          </div>

          {drilldownData && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold capitalize">{drilldown} Details</h3>
                <button onClick={() => setDrilldown(null)} className="text-sm text-primary hover:underline">Close</button>
              </div>
              <DataTable data={drilldownData} columns={RECON_COLUMNS} exportFileName={`${drilldown}_details.csv`} />
            </div>
          )}

          {!drilldownData && (
            <div>
              <h3 className="text-lg font-semibold mb-3">Exception Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {['Missing from Back Office', 'Missing from Commission', 'Wrong Pay Entity', 'Not Eligible for Commission', 'Paid but Missing from EDE'].map(issue => {
                  const count = reconciled.filter(r => r.issue_type === issue).length;
                  return count > 0 ? (
                    <MetricCard key={issue} title={issue} value={count} variant={issue.includes('Wrong') ? 'destructive' : 'warning'} />
                  ) : null;
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
