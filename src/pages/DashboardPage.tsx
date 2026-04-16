import { useMemo, useState, useCallback } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { MetricCard } from '@/components/MetricCard';
import { DataTable } from '@/components/DataTable';
import { BatchSelector } from '@/components/BatchSelector';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Users, Building2, DollarSign, AlertTriangle, CheckCircle2, XCircle, FileText, TrendingDown, Database, Info, ShieldAlert, RefreshCw } from 'lucide-react';
import { getNormalizedRecords, saveReconciledMembers } from '@/lib/persistence';
import { reconcile } from '@/lib/reconcile';
import { useToast } from '@/hooks/use-toast';

const RECON_COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
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

const UNPAID_SAMPLE_COLUMNS = [
  { key: 'member_key', label: 'Member Key' },
  { key: 'applicant_name', label: 'Name' },
  { key: 'agent_npn', label: 'Agent NPN' },
  { key: 'in_ede', label: 'EDE' },
  { key: 'in_back_office', label: 'Back Office' },
  { key: 'eligible_for_commission', label: 'Eligible' },
  { key: 'in_commission', label: 'Commission' },
  { key: 'actual_commission', label: 'Commission $' },
  { key: 'commission_record_count', label: 'Comm Records' },
  { key: 'has_mixed_sources', label: 'Mixed Sources' },
  { key: 'source_count', label: 'Source Count' },
];

const COVERAGE_DRILLDOWN_COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'agent_npn', label: 'Agent NPN' },
  { key: 'aor_bucket', label: 'AOR' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
  { key: 'in_ede', label: 'EDE' },
  { key: 'in_back_office', label: 'Back Office' },
  { key: 'in_commission', label: 'Commission' },
  { key: 'eligible_for_commission', label: 'Eligible' },
  { key: 'actual_commission', label: 'Commission $' },
];

export default function DashboardPage() {
  const { reconciled, loading, counts, debugStats, currentBatchId, refreshAll } = useBatch();
  const [drilldown, setDrilldown] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const { toast } = useToast();

  const handleRerun = useCallback(async () => {
    if (!currentBatchId) return;
    setRerunning(true);
    try {
      const allRecords = await getNormalizedRecords(currentBatchId);
      const { members } = reconcile(allRecords as any[]);
      await saveReconciledMembers(currentBatchId, members);
      await refreshAll();
      toast({ title: 'Reconciliation Complete', description: `${members.length} members reconciled` });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setRerunning(false);
    }
  }, [currentBatchId, refreshAll, toast]);

  const metrics = useMemo(() => {
    const expected = reconciled.filter(r => r.is_in_expected_ede_universe).length;
    const foundBO = reconciled.filter(r => r.is_in_expected_ede_universe && r.in_back_office).length;
    const eligible = reconciled.filter(r => r.is_in_expected_ede_universe && r.in_back_office && r.eligible_for_commission === 'Yes').length;
    const shouldPay = eligible;
    const paidCommRecords = reconciled.filter(r => r.in_commission).length;
    const paidEligible = reconciled.filter(r => r.is_in_expected_ede_universe && r.in_back_office && r.eligible_for_commission === 'Yes' && r.in_commission).length;
    const unpaid = shouldPay - paidEligible;
    const totalComm = reconciled.filter(r => r.in_commission).reduce((s, r) => s + (r.actual_commission || 0), 0);
    const estMissing = reconciled.reduce((s, r) => s + (r.estimated_missing_commission || 0), 0);
    const difference = shouldPay - paidEligible;
    const unpaidVariance = unpaid - difference;
    const totalEdeRaw = reconciled.filter(r => r.in_ede).length;
    const hasAnyEde = reconciled.filter(r => r.in_ede).length;
    const hasExpectedEde = reconciled.filter(r => r.is_in_expected_ede_universe).length;
    const expectedWithBO = reconciled.filter(r => r.is_in_expected_ede_universe && r.in_back_office).length;
    const fullyMatched = reconciled.filter(r => r.in_ede && r.in_back_office && r.in_commission).length;
    const paidOutsideEde = reconciled.filter(r => !r.in_ede && r.in_back_office && r.in_commission).length;
    const commissionOnly = reconciled.filter(r => !r.in_ede && !r.in_back_office && r.in_commission).length;
    const backOfficeOnly = reconciled.filter(r => !r.in_ede && r.in_back_office && !r.in_commission).length;
    const unpaidExpected = reconciled.filter(r => r.in_ede && r.in_back_office && r.eligible_for_commission === 'Yes' && !r.in_commission).length;
    const totalPaidAll = reconciled.filter(r => r.in_commission).length;
    const paidOutsideExpected = reconciled.filter(r => !r.in_ede && r.in_commission).length;
    return { expected, foundBO, eligible, shouldPay, paidCommRecords, paidEligible, unpaid, totalComm, estMissing, difference, unpaidVariance, totalEdeRaw, hasAnyEde, hasExpectedEde, expectedWithBO, fullyMatched, paidOutsideEde, commissionOnly, backOfficeOnly, unpaidExpected, totalPaidAll, paidOutsideExpected };
  }, [reconciled]);

  const unpaidSample = useMemo(() => {
    return reconciled
      .filter(r => r.is_in_expected_ede_universe && r.in_back_office && r.eligible_for_commission === 'Yes' && !r.in_commission)
      .slice(0, 50);
  }, [reconciled]);

  const drilldownData = useMemo(() => {
    if (!drilldown) return null;
    switch (drilldown) {
      case 'expected': return reconciled.filter(r => r.is_in_expected_ede_universe);
      case 'foundBO': return reconciled.filter(r => r.is_in_expected_ede_universe && r.in_back_office);
      case 'eligible': return reconciled.filter(r => r.is_in_expected_ede_universe && r.in_back_office && r.eligible_for_commission === 'Yes');
      case 'paidComm': return reconciled.filter(r => r.in_commission);
      case 'paidEligible': return reconciled.filter(r => r.is_in_expected_ede_universe && r.in_back_office && r.eligible_for_commission === 'Yes' && r.in_commission);
      case 'unpaid': return reconciled.filter(r => r.is_in_expected_ede_universe && r.in_back_office && r.eligible_for_commission === 'Yes' && !r.in_commission);
      case 'fullyMatched': return reconciled.filter(r => r.in_ede && r.in_back_office && r.in_commission);
      case 'paidOutsideEde': return reconciled.filter(r => !r.in_ede && r.in_back_office && r.in_commission);
      case 'commissionOnly': return reconciled.filter(r => !r.in_ede && !r.in_back_office && r.in_commission);
      case 'backOfficeOnly': return reconciled.filter(r => !r.in_ede && r.in_back_office && !r.in_commission);
      case 'unpaidExpected': return reconciled.filter(r => r.in_ede && r.in_back_office && r.eligible_for_commission === 'Yes' && !r.in_commission);
      case 'totalPaidAll': return reconciled.filter(r => r.in_commission);
      case 'paidOutsideExpected': return reconciled.filter(r => !r.in_ede && r.in_commission);
      default: return reconciled;
    }
  }, [drilldown, reconciled]);

  const isCoverageDrilldown = ['fullyMatched', 'paidOutsideEde', 'commissionOnly', 'backOfficeOnly', 'unpaidExpected', 'totalPaidAll', 'paidOutsideExpected'].includes(drilldown || '');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Reconciliation Dashboard</h2>
          <p className="text-sm text-muted-foreground">Ambetter Commission Reconciliation</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRerun} disabled={rerunning || !currentBatchId}>
            <RefreshCw className={`h-4 w-4 mr-1 ${rerunning ? 'animate-spin' : ''}`} />
            {rerunning ? 'Running...' : 'Re-run Reconciliation'}
          </Button>
          <BatchSelector />
        </div>
      </div>

      {/* Matching explanation */}
      <Card className="border-dashed border-primary/30 bg-primary/5">
        <CardContent className="px-4 py-3">
          <p className="text-xs text-muted-foreground flex items-start gap-2">
            <Info className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
            For Ambetter, the EDE field <strong>issuerSubscriberId</strong> often contains the actual member/policy identifier used in carrier systems and commission statements. This is used as the primary match key.
          </p>
        </CardContent>
      </Card>

      {/* Debug Counts */}
      <Card className="border-dashed">
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Database className="h-4 w-4" /> Debug Counts (Selected Batch)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3 pt-0 space-y-2">
          <div className="flex flex-wrap gap-6 text-sm">
            <span className="text-muted-foreground">Uploaded Files: <strong className="text-foreground">{counts.uploadedFiles}</strong></span>
            <span className="text-muted-foreground">Normalized Records: <strong className="text-foreground">{counts.normalizedRecords}</strong></span>
            <span className="text-muted-foreground">Reconciled Members: <strong className="text-foreground">{counts.reconciledMembers}</strong></span>
          </div>
          {debugStats && (
            <div className="flex flex-wrap gap-6 text-sm border-t pt-2 mt-2">
              <span className="text-muted-foreground">Raw Records: <strong className="text-foreground">{debugStats.totalRawRecords}</strong></span>
              <span className="text-muted-foreground">EDE rows: <strong className="text-foreground">{debugStats.totalEDE}</strong></span>
              <span className="text-muted-foreground">Back Office rows: <strong className="text-foreground">{debugStats.totalBO}</strong></span>
              <span className="text-muted-foreground">Commission rows: <strong className="text-foreground">{debugStats.totalComm}</strong></span>
              <span className="text-muted-foreground">Unique Member Keys: <strong className="text-foreground">{debugStats.uniqueMemberKeys}</strong></span>
              <span className="text-muted-foreground">Avg Records/Key: <strong className="text-foreground">{debugStats.avgRecordsPerKey}</strong></span>
            </div>
          )}
          {debugStats && (
            <div className="flex flex-wrap gap-6 text-sm border-t pt-2 mt-2">
              <span className="text-muted-foreground">EDE w/ issuerSubId: <strong className="text-foreground">{debugStats.edeWithIssuerSubId}</strong></span>
              <span className="text-muted-foreground">BO starting "U": <strong className="text-foreground">{debugStats.boStartingWithU}</strong></span>
              <span className="text-muted-foreground">Comm starting "U": <strong className="text-foreground">{debugStats.commStartingWithU}</strong></span>
            </div>
          )}
          {debugStats && (
            <div className="flex flex-wrap gap-6 text-sm border-t pt-2 mt-2">
              <span className="text-muted-foreground">Match by issuer_sub_id: <strong className="text-foreground">{debugStats.matchByIssuerSubId}</strong></span>
              <span className="text-muted-foreground">Match by exchange_sub_id: <strong className="text-foreground">{debugStats.matchByExchangeSubId}</strong></span>
              <span className="text-muted-foreground">Match by policy_number: <strong className="text-foreground">{debugStats.matchByPolicyNumber}</strong></span>
              <span className="text-muted-foreground">Match by fallback: <strong className="text-foreground">{debugStats.matchByFallback}</strong></span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* EDE Enrollment Debug */}
      {debugStats && (
        <Card className="border-dashed">
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4" /> EDE Expected Enrollment Debug
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-0 space-y-2">
            <div className="flex flex-wrap gap-6 text-sm">
              <span className="text-muted-foreground">Total Raw EDE rows: <strong className="text-foreground">{debugStats.edeRawTotal}</strong></span>
              <span className="text-muted-foreground">After filter (eff. date + status): <strong className="text-foreground">{debugStats.edeAfterFilter}</strong></span>
              <span className="text-muted-foreground">Unique member_keys after filter: <strong className="text-foreground">{debugStats.edeUniqueKeysAfterFilter}</strong></span>
              <span className="text-muted-foreground">Expected Enrollments (reconciled): <strong className="text-foreground">{metrics.expected}</strong></span>
              <span className="text-muted-foreground">All EDE unfiltered: <strong className="text-foreground">{metrics.totalEdeRaw}</strong></span>
              <span className="text-muted-foreground">Invalid date rows: <strong className="text-foreground">{debugStats.edeInvalidDateCount}</strong></span>
            </div>
            <div className="flex flex-wrap gap-4 text-sm border-t pt-2">
              <span className="text-muted-foreground font-medium">Status breakdown:</span>
              {Object.entries(debugStats.edeStatusBreakdown).sort((a, b) => b[1] - a[1]).map(([status, count]) => (
                <span key={status} className="text-muted-foreground">
                  {status}: <strong className="text-foreground">{count as number}</strong>
                </span>
              ))}
            </div>
            {debugStats.edeEffDateSamples.length > 0 && (
              <div className="flex flex-wrap gap-4 text-sm border-t pt-2">
                <span className="text-muted-foreground font-medium">Effective date samples:</span>
                {debugStats.edeEffDateSamples.map((d, i) => (
                  <span key={i} className="text-muted-foreground font-mono">{d}</span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="text-center py-20 text-muted-foreground">Loading...</div>
      ) : reconciled.length === 0 ? (
        <div className="text-center py-20">
          <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground">No reconciliation data yet. Upload files to get started.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <MetricCard title="Expected Enrollments" value={metrics.expected} icon={<Users className="h-4 w-4" />} onClick={() => setDrilldown('expected')} tooltip={{ text: "These are the Ambetter members we believe should exist based on our enrollment system (EDE), after filtering for active policies starting 1/1/2026.", why: "This is your baseline. All other numbers are measured against this to determine if anything is missing or incorrect." }} />
            <MetricCard title="Found in Back Office" value={metrics.foundBO} icon={<Building2 className="h-4 w-4" />} variant="info" onClick={() => setDrilldown('foundBO')} tooltip={{ text: "Out of the expected members, these are the ones Ambetter recognizes in their system.", why: "If members are missing here, Ambetter may not have the policy correctly recorded, which can prevent payment." }} />
            <MetricCard title="Eligible for Commission" value={metrics.eligible} icon={<CheckCircle2 className="h-4 w-4" />} variant="success" onClick={() => setDrilldown('eligible')} tooltip={{ text: "These are members that exist in Ambetter's system and are marked as eligible for commission.", why: "Only members in this group can generate commission. If eligibility is wrong, payments will not occur." }} />
            <MetricCard title="Should Be Paid" value={metrics.shouldPay} icon={<DollarSign className="h-4 w-4" />} tooltip={{ text: "This is the total number of members we expect to receive commission for based on enrollment, carrier records, and eligibility.", why: "This represents your true payable book of business and is the key number for identifying missing revenue." }} />
            <MetricCard title="Paid Commission Records" value={metrics.paidCommRecords} icon={<CheckCircle2 className="h-4 w-4" />} variant="info" onClick={() => setDrilldown('paidComm')} tooltip={{ text: "These are all members that appear on the commission statements as having been paid, regardless of whether they match our expected book.", why: "This shows what the carrier actually paid, including payments that may not belong to your tracked enrollments." }} />
            <MetricCard title="Paid Within Eligible Cohort" value={metrics.paidEligible} icon={<CheckCircle2 className="h-4 w-4" />} variant="success" onClick={() => setDrilldown('paidEligible')} tooltip={{ text: "These are members we expected to be paid on AND actually received commission for.", why: "This is your true success rate — how much of your expected revenue you actually collected." }} />
            <MetricCard title="Unpaid Policies" value={metrics.unpaid} icon={<XCircle className="h-4 w-4" />} variant="destructive" onClick={() => setDrilldown('unpaid')} tooltip={{ text: "These are members we expected to be paid on but did not receive commission for.", why: "This is your potential revenue loss and the most important number for recovery and escalation." }} />
            <MetricCard title="Total Paid Commission" value={`$${metrics.totalComm.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} icon={<DollarSign className="h-4 w-4" />} variant="success" tooltip={{ text: "The total dollar amount of commission actually received based on the statements.", why: "This shows your confirmed revenue and is what has already been realized." }} />
            <MetricCard title="Est. Missing Commission" value={`$${metrics.estMissing.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} icon={<TrendingDown className="h-4 w-4" />} variant="warning" tooltip={{ text: "This is an estimate of how much commission may be missing based on unpaid policies.", why: "This represents potential recoverable revenue and helps prioritize follow-up with carriers." }} />
          </div>

          {/* Validation Panel */}
          <Card className={metrics.unpaidVariance > 5 ? 'border-destructive/50 bg-destructive/5' : 'border-success/50 bg-success/5'}>
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <ShieldAlert className="h-4 w-4" /> Reconciliation Validation
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground block">Should Be Paid</span>
                  <strong className="text-foreground text-lg">{metrics.shouldPay}</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Paid Within Eligible</span>
                  <strong className="text-foreground text-lg">{metrics.paidEligible}</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Unpaid Policies</span>
                  <strong className="text-foreground text-lg">{metrics.unpaid}</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Difference (Should − Paid)</span>
                  <strong className="text-foreground text-lg">{metrics.difference}</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Unpaid Variance</span>
                  <strong className={`text-lg ${metrics.unpaidVariance > 5 ? 'text-destructive' : 'text-success'}`}>
                    {metrics.unpaidVariance}
                  </strong>
                </div>
              </div>
              {debugStats && (
                <div className="flex flex-wrap gap-6 text-sm border-t pt-2">
                  <span className="text-muted-foreground">Raw Records: <strong className="text-foreground">{debugStats.totalRawRecords}</strong></span>
                  <span className="text-muted-foreground">Unique Member Keys: <strong className="text-foreground">{debugStats.uniqueMemberKeys}</strong></span>
                  <span className="text-muted-foreground">Avg Records/Key: <strong className="text-foreground">{debugStats.avgRecordsPerKey}</strong></span>
                  <span className="text-muted-foreground">has_any_ede: <strong className="text-foreground">{metrics.hasAnyEde}</strong></span>
                  <span className="text-muted-foreground">is_in_expected_ede_universe: <strong className="text-foreground">{metrics.hasExpectedEde}</strong></span>
                  <span className="text-muted-foreground">expected + in_back_office: <strong className="text-foreground">{metrics.expectedWithBO}</strong></span>
                </div>
              )}
              {metrics.unpaidVariance > 5 && (
                <div className="flex items-start gap-2 text-sm bg-destructive/10 rounded-md p-3 border border-destructive/20">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                  <span className="text-destructive font-medium">
                    Possible duplicate consolidation or classification issue remains. Unpaid Variance ({metrics.unpaidVariance}) is materially above zero.
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Unpaid Validation Sample */}
          {unpaidSample.length > 0 && !drilldownData && (
            <div className="space-y-3">
              <h3 className="text-lg font-semibold">Unpaid Validation Sample (top 50)</h3>
              <DataTable data={unpaidSample} columns={UNPAID_SAMPLE_COLUMNS} exportFileName="unpaid_validation_sample.csv" />
            </div>
          )}

          {drilldownData && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold capitalize">{drilldown} Details</h3>
                <button onClick={() => setDrilldown(null)} className="text-sm text-primary hover:underline">Close</button>
              </div>
              <DataTable data={drilldownData} columns={isCoverageDrilldown ? COVERAGE_DRILLDOWN_COLUMNS : RECON_COLUMNS} exportFileName={`${drilldown}_details.csv`} />
            </div>
          )}

          {!drilldownData && (
            <div>
              <h3 className="text-lg font-semibold mb-3">Exception Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {([
                  { issue: 'Missing from Back Office', tip: { text: "These members appear in our system but are not found in Ambetter's system.", why: "If the carrier doesn't recognize the policy, they cannot pay commission on it." } },
                  { issue: 'Missing from Commission', tip: { text: "These members should have generated commission but do not appear on the commission statements.", why: "These are likely unpaid policies and should be reviewed for missing payments." } },
                  { issue: 'Wrong Pay Entity', tip: { text: "These members were paid, but under the wrong entity (for example, Vix instead of Coverall).", why: "Revenue may be going to the wrong account and may need to be corrected." } },
                  { issue: 'Not Eligible for Commission', tip: { text: "These members exist but are not marked as eligible for commission by the carrier.", why: "These policies will not generate revenue unless eligibility is corrected." } },
                  { issue: 'Paid but Missing from EDE', tip: { text: "These members were paid on commission statements but do not appear in our enrollment system.", why: "This may indicate external enrollments, data mismatches, or policies written outside your tracked workflow." } },
                ] as const).map(({ issue, tip }) => {
                  const count = reconciled.filter(r => r.issue_type === issue).length;
                  return count > 0 ? (
                    <MetricCard key={issue} title={issue} value={count} variant={issue.includes('Wrong') ? 'destructive' : 'warning'} tooltip={tip} />
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