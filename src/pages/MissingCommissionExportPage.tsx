/**
 * #104 — Best Known Member Profile + Messer Missing Commission Export.
 *
 * Read-only enrichment + new export workflow:
 *   1. Pulls reconciled members for the active batch (or any selected month).
 *   2. Identifies the "missing commission" cohort: members in the canonical
 *      eligible cohort (EE-universe ∩ in_back_office ∩ eligible=Yes) who are
 *      NOT in the commission file (`!in_commission`).
 *   3. For each missing member, builds a {@link MemberProfile} live from
 *      ALL normalized records across ALL batches — so a Jan record's blank
 *      Address 1 picks up the value from a Mar BO row.
 *   4. Lets the user filter by pay-entity scope and net-premium bucket, and
 *      download a Messer-form-shaped CSV (column order locked).
 *
 * NO persisted-data changes. NO RECONCILE_LOGIC_VERSION bump (UI/export-only,
 * same precedent as #90).
 */
import { useEffect, useMemo, useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Download, Info, AlertTriangle } from 'lucide-react';
import Papa from 'papaparse';
import { getAllNormalizedRecords } from '@/lib/persistence';
import {
  buildMemberProfile,
  splitNameLastSpace,
  assembleAddressLine,
  type MemberProfile,
  type EnrichedField,
} from '@/lib/canonical/memberProfileView';
import {
  type CanonicalScope,
  filterReconciledByScope,
} from '@/lib/canonical/scope';
import { extractNpnFromAorString } from '@/lib/agents';
import { NPN_MAP, DEFAULT_COMMISSION_ESTIMATE } from '@/lib/constants';
import { computeFilteredEde } from '@/lib/expectedEde';
import { getEligibleCohort } from '@/lib/canonical/metrics';
import { getCoveredMonths } from '@/lib/dateRange';
import {
  findWeakMatches,
  loadWeakMatchOverrides,
  applyOverrides,
  pickStableKey,
  type WeakMatchOverride,
} from '@/lib/weakMatch';

type PremiumBucket = 'all' | 'zero_premium' | 'has_premium';

interface ExportRow {
  // Messer columns (downloaded)
  carrierName: string;
  npn: string;
  writingAgentCarrierId: string;
  writingAgentName: string;
  policyEffectiveDate: string;
  policyNumber: string;
  memberFirstName: string;
  memberLastName: string;
  dob: string;
  ssn: string; // blank v1
  memberId: string;
  address: string;
  // Internal preview-only columns
  _memberKey: string;
  _ffmId: EnrichedField<string>;
  _exchangeSubscriberId: string;
  _issuerSubscriberId: string;
  _aor: string;
  _netPremiumBucket: PremiumBucket;
  _missingReason: string;
  _estimatedMissingCommission: number | null;
  _profile: MemberProfile;
  _hasConflict: boolean;
  _phone: EnrichedField<string>;
  _email: EnrichedField<string>;
}

const MESSER_COLUMNS: Array<{ key: keyof ExportRow; label: string }> = [
  { key: 'carrierName', label: 'Carrier Name' },
  { key: 'npn', label: 'NPN' },
  { key: 'writingAgentCarrierId', label: 'Writing Agent Carrier ID' },
  { key: 'writingAgentName', label: 'Writing Agent Name' },
  { key: 'policyEffectiveDate', label: 'Policy Effective Date' },
  { key: 'policyNumber', label: 'Policy #' },
  { key: 'memberFirstName', label: 'Member First Name' },
  { key: 'memberLastName', label: 'Member Last Name' },
  { key: 'dob', label: 'DOB' },
  { key: 'ssn', label: 'SSN' },
  { key: 'memberId', label: 'Member ID' },
  { key: 'address', label: 'Address (Street, City, State, Zip)' },
];

const INTERNAL_COLUMNS: Array<{ key: keyof ExportRow; label: string }> = [
  { key: '_memberKey', label: 'member_key' },
  { key: '_ffmId', label: 'FFM ID' },
  { key: '_phone', label: 'Phone' },
  { key: '_email', label: 'Email' },
  { key: '_exchangeSubscriberId', label: 'exchange_subscriber_id' },
  { key: '_issuerSubscriberId', label: 'issuer_subscriber_id' },
  { key: '_aor', label: 'AOR' },
  { key: '_netPremiumBucket', label: 'Net premium bucket' },
  { key: '_missingReason', label: 'Missing reason' },
  { key: '_estimatedMissingCommission', label: 'Est. missing commission' },
];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Resolve "writing agent name" for the Messer form using the AOR-primary
 * fallback ladder spec'd in #104:
 *   current_policy_aor (display name) → BO Broker Name → Commission
 *   Writing Agent Name → blank.
 *
 * AOR is primary because the inquiry form is about who wrote/owns the policy,
 * not who is currently being paid.
 */
export function resolveWritingAgentName(opts: {
  currentPolicyAor: string | null | undefined;
  boBrokerName: string | null | undefined;
  commissionWritingAgentName: string | null | undefined;
}): string {
  const aor = String(opts.currentPolicyAor ?? '').trim();
  if (aor) {
    // Strip embedded "(NPN)" suffix for display: "Jason Fine (21055210)" → "Jason Fine".
    const cleaned = aor.replace(/\s*\(\d+\)\s*$/, '').trim();
    if (cleaned) return cleaned;
  }
  const boName = String(opts.boBrokerName ?? '').trim();
  if (boName) return boName;
  const commName = String(opts.commissionWritingAgentName ?? '').trim();
  if (commName) return commName;
  return '';
}

/** Member ID fallback ladder: issuer_subscriber_id → policy_number → exchange_subscriber_id. */
export function resolveMemberId(opts: {
  issuerSubscriberId: string | null | undefined;
  policyNumber: string | null | undefined;
  exchangeSubscriberId: string | null | undefined;
}): string {
  const i = String(opts.issuerSubscriberId ?? '').trim();
  if (i) return i;
  const p = String(opts.policyNumber ?? '').trim();
  if (p) return p;
  const e = String(opts.exchangeSubscriberId ?? '').trim();
  if (e) return e;
  return '';
}

/**
 * Row-context Policy Effective Date (NOT enrichment-walk).
 * Pulls from EDE `effective_date` (typed) → EDE `raw_json.effectiveDate`
 * → BO `broker_effective_date` → BO `Policy Effective Date` raw → reconciled
 * `effective_date`. First non-blank wins. EDE is preferred because it carries
 * the authoritative policy effective date as filed on the marketplace; BO
 * dates can lag for retro-enrolled policies.
 */
export function resolvePolicyEffectiveDate(opts: {
  records: any[];
  reconciledEffectiveDate?: string | null;
}): string {
  const recs = opts.records || [];
  for (const r of recs) {
    if (r.source_type === 'EDE' && r.effective_date) return String(r.effective_date);
  }
  for (const r of recs) {
    if (r.source_type === 'EDE') {
      const v = r.raw_json?.effectiveDate;
      if (v) return String(v).trim();
    }
  }
  for (const r of recs) {
    if (r.source_type === 'BACK_OFFICE' && r.broker_effective_date) return String(r.broker_effective_date);
  }
  for (const r of recs) {
    if (r.source_type === 'BACK_OFFICE') {
      const v = r.raw_json?.['Policy Effective Date'];
      if (v) return String(v).trim();
    }
  }
  if (opts.reconciledEffectiveDate) return String(opts.reconciledEffectiveDate);
  return '';
}

// ---------------------------------------------------------------------------
// #109 — Writing Agent Carrier ID derived lookup.
//
// The carrier-specific writing-agent ID lives only on COMMISSION rows. For the
// missing-commission cohort, by definition there is no current commission row
// for that member, so direct lookup yields blank for ~85% of rows. We observed
// (and the diagnostic confirmed) that `writing_agent_carrier_id` is uniform
// per (carrier, pay_entity, agent_npn) across all loaded commission rows
// (e.g. every Coverall row → CHG9852, Vix → VIX9696). Building a derived map
// from observed COMMISSION rows lets us fall back to that ID when the member
// has no current commission row but the AOR has historical commission activity.
//
// Pure (no React hooks) — caller memoizes against batch data-version stamps.
// ---------------------------------------------------------------------------

export interface WritingAgentIdEntry {
  /** Most-recent winning ID (by batch month, then created_at). */
  id: string;
  /** Distinct losing values, if any, for conflict warnings. */
  conflicts: string[];
}

/** Stable key for (carrier, pay_entity, agent_npn). */
function carrierIdLookupKey(carrier: string, payEntity: string, npn: string): string {
  return `${(carrier || '').trim().toLowerCase()}|${(payEntity || '').trim().toLowerCase()}|${(npn || '').trim()}`;
}

/**
 * Build a lookup `(carrier, pay_entity, agent_npn) → writing_agent_carrier_id`
 * from observed COMMISSION rows. Most-recent batch month wins on conflict; all
 * losing values are surfaced in `conflicts` so callers can warn for review.
 *
 * Pure — pass already-loaded normalized records and a batch_id → 'YYYY-MM' map.
 */
export function buildWritingAgentCarrierIdLookup(opts: {
  records: any[];
  batchMonthByBatchId: Map<string, string>;
}): Map<string, WritingAgentIdEntry> {
  const groups = new Map<string, Array<{ id: string; month: string; createdAt: string }>>();
  for (const r of opts.records) {
    if (r.source_type !== 'COMMISSION') continue;
    const id = String(r.writing_agent_carrier_id ?? '').trim();
    if (!id) continue;
    const npn = String(r.agent_npn ?? '').trim();
    if (!npn) continue;
    const key = carrierIdLookupKey(r.carrier ?? '', r.pay_entity ?? '', npn);
    const month = opts.batchMonthByBatchId.get(r.batch_id) || '';
    const arr = groups.get(key);
    const entry = { id, month, createdAt: String(r.created_at ?? '') };
    if (arr) arr.push(entry); else groups.set(key, [entry]);
  }
  const out = new Map<string, WritingAgentIdEntry>();
  for (const [key, rows] of groups) {
    // Sort: most-recent month first, then most-recent created_at first.
    rows.sort((a, b) => {
      if (a.month !== b.month) return a.month < b.month ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
    const winner = rows[0].id;
    const losers = Array.from(new Set(rows.slice(1).map((r) => r.id).filter((v) => v !== winner)));
    out.set(key, { id: winner, conflicts: losers });
  }
  return out;
}

/**
 * Resolution ladder for the export's Writing Agent Carrier ID column:
 *   1. Direct: member has a commission row with `writing_agent_carrier_id` → use it.
 *   2. Historical: derived `(carrier, pay_entity, agent_npn)` lookup hit.
 *   3. Blank.
 */
export function resolveWritingAgentCarrierId(opts: {
  records: any[];
  carrier: string;
  payEntity: string;
  agentNpn: string;
  lookup: Map<string, WritingAgentIdEntry>;
}): string {
  // Direct
  for (const r of opts.records) {
    if (r.source_type === 'COMMISSION' && r.writing_agent_carrier_id) {
      const v = String(r.writing_agent_carrier_id).trim();
      if (v) return v;
    }
  }
  // Historical
  const npn = String(opts.agentNpn || '').trim();
  if (!npn) return '';
  const hit = opts.lookup.get(carrierIdLookupKey(opts.carrier, opts.payEntity, npn));
  return hit ? hit.id : '';
}

/** Bucket a numeric net premium into the three-way premium filter buckets. */
export function classifyNetPremium(net: number | null | undefined): PremiumBucket {
  const n = Number(net);
  if (!net || isNaN(n) || n === 0) return 'zero_premium';
  return 'has_premium';
}

export function buildMesserCsvFilename(opts: {
  scope: CanonicalScope;
  batchMonth: string; // 'YYYY-MM' or ''
  filter: PremiumBucket;
  downloadDate: Date;
}): string {
  const scopeTok =
    opts.scope === 'Coverall' ? 'coverall' : opts.scope === 'Vix' ? 'vix' : 'all';
  const batchTok = opts.batchMonth
    ? opts.batchMonth.replace('-', '_')
    : 'unknown_batch';
  const filterTok =
    opts.filter === 'all' ? 'all' : opts.filter === 'zero_premium' ? 'zero_premium' : 'has_premium';
  const dt = opts.downloadDate;
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `messer_missing_commission_ambetter_${scopeTok}_${batchTok}_${filterTok}_${yyyy}_${mm}_${dd}.csv`;
}

/** Convert ExportRow[] → CSV with EXACTLY the Messer column order (no internals). */
export function buildMesserCsv(rows: ExportRow[]): string {
  const data = rows.map((r) => {
    const obj: Record<string, string> = {};
    for (const col of MESSER_COLUMNS) {
      const v = r[col.key];
      obj[col.label] = v == null ? '' : String(v);
    }
    return obj;
  });
  return Papa.unparse({
    fields: MESSER_COLUMNS.map((c) => c.label),
    data,
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MissingCommissionExportPage() {
  const { batches, currentBatchId, setCurrentBatchId, reconciled, resolverIndex } = useBatch();
  const [scope, setScope] = useState<CanonicalScope>('Coverall');
  const [premiumBucket, setPremiumBucket] = useState<PremiumBucket>('all');
  const [allRecords, setAllRecords] = useState<any[]>([]);
  const [weakOverrides, setWeakOverrides] = useState<Map<string, WeakMatchOverride>>(new Map());
  const [loading, setLoading] = useState(false);

  // Cross-batch normalized records — required for profile enrichment AND
  // for computing the canonical EE-universe (filteredEde) used by the cohort.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [data, overrides] = await Promise.all([
          getAllNormalizedRecords(),
          loadWeakMatchOverrides().catch(() => new Map<string, WeakMatchOverride>()),
        ]);
        if (!cancelled) {
          setAllRecords(data || []);
          setWeakOverrides(overrides);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const currentBatch = useMemo(
    () => batches.find((b: any) => b.id === currentBatchId) ?? null,
    [batches, currentBatchId],
  );
  const currentBatchMonth: string = currentBatch?.statement_month
    ? String(currentBatch.statement_month).substring(0, 7)
    : '';

  const coveredMonths = useMemo(
    () => getCoveredMonths(currentBatch?.statement_month),
    [currentBatch?.statement_month],
  );

  // batch_id → 'YYYY-MM' for profile tier bucketing.
  const batchMonthByBatchId = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of batches) {
      m.set(b.id, b.statement_month ? String(b.statement_month).substring(0, 7) : '');
    }
    return m;
  }, [batches]);

  // Records for the CURRENT batch only — needed for filteredEde / EE universe.
  const currentBatchRecords = useMemo(
    () => allRecords.filter((r) => r.batch_id === currentBatchId),
    [allRecords, currentBatchId],
  );

  // Index records by member_key once (reused for every profile build).
  const recordsByMemberKey = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const r of allRecords) {
      const k = r.member_key;
      if (!k) continue;
      const arr = m.get(k);
      if (arr) arr.push(r);
      else m.set(k, [r]);
    }
    return m;
  }, [allRecords]);

  // Canonical EE universe + confirmed weak-match upgrades (#104 cohort fix).
  // Mirrors DashboardPage so the export count ties to the audit's
  // Eligible-and-Found cohort (e.g. Apr Coverall = 1,391 not 1,476).
  const filteredEde = useMemo(
    () => computeFilteredEde(currentBatchRecords, reconciled, scope, coveredMonths, resolverIndex),
    [currentBatchRecords, reconciled, scope, coveredMonths, resolverIndex],
  );

  const confirmedUpgradeMemberKeys = useMemo(() => {
    const out = new Set<string>();
    if (!weakOverrides.size || !reconciled.length) return out;
    const candidates = findWeakMatches(filteredEde.uniqueMembers, currentBatchRecords);
    const { confirmedKeys } = applyOverrides(candidates, weakOverrides);
    if (!confirmedKeys.size) return out;
    const inScope = filterReconciledByScope(reconciled, scope);
    for (const r of inScope) {
      if (r.in_back_office) continue;
      const key = pickStableKey({
        issuer_subscriber_id: r.issuer_subscriber_id,
        exchange_subscriber_id: r.exchange_subscriber_id,
        policy_number: r.policy_number,
      });
      if (key && confirmedKeys.has(key)) out.add(r.member_key);
    }
    return out;
  }, [filteredEde, currentBatchRecords, weakOverrides, reconciled, scope]);

  // Missing-commission cohort: canonical Eligible Cohort ∩ !in_commission.
  // Eligible Cohort = EE-universe ∩ (in_back_office ∨ confirmed weak match)
  // ∩ eligible='Yes'. Then drop members whose commission row was found.
  const missingMembers = useMemo(() => {
    const eligible = getEligibleCohort(reconciled, scope, confirmedUpgradeMemberKeys, filteredEde);
    return eligible.filter((r) => !r.in_commission);
  }, [reconciled, scope, confirmedUpgradeMemberKeys, filteredEde]);

  // #109 — derived (carrier, pay_entity, agent_npn) → writing_agent_carrier_id
  // map. Memoized over allRecords (which is reloaded on mount, and via the
  // page's data-version subscription on Re-run Reconciliation). When new
  // commission rows arrive, the map recomputes and stale blanks fill in.
  const writingAgentIdLookup = useMemo(
    () => buildWritingAgentCarrierIdLookup({ records: allRecords, batchMonthByBatchId }),
    [allRecords, batchMonthByBatchId],
  );

  // One-shot console warning when the lookup discovers conflicting IDs for the
  // same (carrier, pay_entity, NPN) — surfaces forward-safety issues for review.
  useEffect(() => {
    const conflicts: Array<{ key: string; winner: string; losers: string[] }> = [];
    for (const [key, entry] of writingAgentIdLookup) {
      if (entry.conflicts.length) conflicts.push({ key, winner: entry.id, losers: entry.conflicts });
    }
    if (conflicts.length) {
      console.warn(
        `[#109] writing_agent_carrier_id lookup found ${conflicts.length} (carrier, pay_entity, NPN) pair(s) with multiple distinct IDs. Most-recent month wins; review:`,
        conflicts,
      );
    }
  }, [writingAgentIdLookup]);

  // Build export rows (with enriched profiles).
  const allExportRows = useMemo<ExportRow[]>(() => {
    const out: ExportRow[] = [];
    for (const m of missingMembers) {
      const memberKey = m.member_key;
      const records = recordsByMemberKey.get(memberKey) ?? [];
      const profile = buildMemberProfile(memberKey, {
        records,
        referenceMonth: currentBatchMonth,
        batchMonthByBatchId,
      });

      const nameVal = profile.applicant_name.value || m.applicant_name || '';
      const { first, last } = splitNameLastSpace(nameVal);

      // NPN: prefer NPN embedded in current_policy_aor; fall back to writing-agent NPN.
      const aor = String(m.current_policy_aor ?? '').trim();
      const aorNpn = extractNpnFromAorString(aor);
      const npn = aorNpn || String(m.agent_npn ?? '').trim();

      // Writing Agent Carrier ID (#109): direct from this member's commission
      // row when present; else fall back to the derived (carrier, pay_entity,
      // NPN) → ID lookup built from all observed commission rows; else blank.
      const commRec = records.find((r) => r.source_type === 'COMMISSION' && r.writing_agent_carrier_id);
      const writingAgentCarrierId = resolveWritingAgentCarrierId({
        records,
        carrier: 'Ambetter',
        // For missing-commission cohort members, expected_pay_entity reflects
        // the AOR's pay-entity assignment; that's the right key to match
        // against historical commission rows for the same agent.
        payEntity: m.expected_pay_entity || (scope !== 'All' ? scope : ''),
        agentNpn: npn,
        lookup: writingAgentIdLookup,
      });

      // Writing Agent Name: AOR display → BO Broker Name → Commission Writing Agent Name → blank.
      const boRec = records.find((r) => r.source_type === 'BACK_OFFICE' && r.agent_name);
      const writingAgentName = resolveWritingAgentName({
        currentPolicyAor: aor,
        boBrokerName: boRec?.agent_name,
        commissionWritingAgentName: commRec?.agent_name,
      });

      const memberId = resolveMemberId({
        issuerSubscriberId: m.issuer_subscriber_id,
        policyNumber: m.policy_number,
        exchangeSubscriberId: m.exchange_subscriber_id,
      });

      const address = assembleAddressLine({
        address1: profile.address1.value,
        city: profile.city.value,
        state: profile.state.value,
        zip: profile.zip.value,
      });

      const netPremium = m.net_premium ?? m.premium ?? null;
      const bucket = classifyNetPremium(netPremium);

      const estMissing =
        typeof m.estimated_missing_commission === 'number' && m.estimated_missing_commission > 0
          ? m.estimated_missing_commission
          : DEFAULT_COMMISSION_ESTIMATE;

      const hasConflict =
        profile.applicant_name.conflict ||
        profile.address1.conflict ||
        profile.city.conflict ||
        profile.state.conflict ||
        profile.zip.conflict ||
        profile.dob.conflict ||
        profile.phone.conflict ||
        profile.email.conflict;

      out.push({
        carrierName: 'Ambetter',
        npn,
        writingAgentCarrierId,
        writingAgentName,
        policyEffectiveDate: resolvePolicyEffectiveDate({
          records,
          reconciledEffectiveDate: m.effective_date,
        }),
        policyNumber: String(m.policy_number ?? '') || '',
        memberFirstName: first,
        memberLastName: last,
        dob: profile.dob.value || (m.dob ? String(m.dob) : ''),
        ssn: '', // v1: no trusted source
        memberId,
        address,
        _memberKey: memberKey,
        _ffmId: profile.ffm_id,
        _phone: profile.phone,
        _email: profile.email,
        _exchangeSubscriberId: String(m.exchange_subscriber_id ?? ''),
        _issuerSubscriberId: String(m.issuer_subscriber_id ?? ''),
        _aor: aor,
        _netPremiumBucket: bucket,
        _missingReason: m.issue_type || 'Missing from Commission',
        _estimatedMissingCommission: estMissing,
        _profile: profile,
        _hasConflict: hasConflict,
      });
    }
    return out;
  }, [missingMembers, recordsByMemberKey, currentBatchMonth, batchMonthByBatchId]);

  const filteredExportRows = useMemo(() => {
    if (premiumBucket === 'all') return allExportRows;
    return allExportRows.filter((r) => r._netPremiumBucket === premiumBucket);
  }, [allExportRows, premiumBucket]);

  function handleDownload() {
    const csv = buildMesserCsv(filteredExportRows);
    const filename = buildMesserCsvFilename({
      scope,
      batchMonth: currentBatchMonth,
      filter: premiumBucket,
      downloadDate: new Date(),
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Missing Commission Export</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Generate the Messer Commission Inquiry Form (CSV) for members who are eligible
            for commission, found in the Back Office, but missing from the commission
            statement. Each row is enriched with the best-known descriptive and contact
            fields across <strong>all uploaded sources</strong> (BO-first, walking later
            BO → same-month EDE → later EDE → earlier fallback).
          </p>
        </header>

        {/* Filter bar */}
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Month (Batch)</label>
              <Select value={currentBatchId ?? ''} onValueChange={(v) => setCurrentBatchId(v)}>
                <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select batch" /></SelectTrigger>
                <SelectContent>
                  {batches.map((b: any) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.statement_month ? String(b.statement_month).substring(0, 7) : '(no month)'} — {b.carrier ?? 'Ambetter'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Carrier</label>
              <Select value="Ambetter" disabled>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Ambetter">Ambetter</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Scope</label>
              <Select value={scope} onValueChange={(v) => setScope(v as CanonicalScope)}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Coverall">Coverall</SelectItem>
                  <SelectItem value="Vix">Vix</SelectItem>
                  <SelectItem value="All">All</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Premium bucket</label>
            <div className="mt-1.5 inline-flex rounded-md border bg-background p-1" role="group">
              {([
                { v: 'all', label: 'All' },
                { v: 'zero_premium', label: 'Zero Net Premium' },
                { v: 'has_premium', label: 'Has Net Premium' },
              ] as const).map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  data-bucket={opt.v}
                  onClick={() => setPremiumBucket(opt.v)}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                    premiumBucket === opt.v
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t">
            <div className="text-sm text-muted-foreground">
              {loading ? 'Loading cross-batch records…' : `${filteredExportRows.length} member${filteredExportRows.length === 1 ? '' : 's'}`}
              {filteredExportRows.length !== allExportRows.length && (
                <span className="ml-2 text-xs">({allExportRows.length} before premium filter)</span>
              )}
            </div>
            <Button
              onClick={handleDownload}
              disabled={filteredExportRows.length === 0}
              data-testid="messer-download"
            >
              <Download className="h-4 w-4 mr-2" />
              Download Messer Form (CSV)
            </Button>
          </div>
        </div>

        {/* Preview table */}
        <div className="rounded-lg border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {MESSER_COLUMNS.map((c) => (
                  <TableHead key={String(c.key)} className="whitespace-nowrap text-xs uppercase tracking-wide">
                    {c.label}
                  </TableHead>
                ))}
                {INTERNAL_COLUMNS.map((c) => (
                  <TableHead
                    key={String(c.key)}
                    className="whitespace-nowrap text-xs uppercase tracking-wide bg-muted/40 text-muted-foreground"
                  >
                    <span className="flex items-center gap-1">
                      {c.label}
                      <Tooltip>
                        <TooltipTrigger><Info className="h-3 w-3 opacity-60" /></TooltipTrigger>
                        <TooltipContent>Internal — not in download</TooltipContent>
                      </Tooltip>
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredExportRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={MESSER_COLUMNS.length + INTERNAL_COLUMNS.length} className="text-center text-sm text-muted-foreground py-12">
                    {loading ? 'Loading…' : 'No missing-commission members in this scope/filter.'}
                  </TableCell>
                </TableRow>
              ) : (
                filteredExportRows.slice(0, 250).map((row) => (
                  <TableRow key={row._memberKey}>
                    {MESSER_COLUMNS.map((c) => {
                      const v = row[c.key];
                      const fieldKey = c.key as string;
                      const profileField =
                        fieldKey === 'address'
                          ? row._profile.address1
                          : fieldKey === 'dob'
                            ? row._profile.dob
                            : fieldKey === 'memberFirstName' || fieldKey === 'memberLastName'
                              ? row._profile.applicant_name
                              : null;
                      return (
                        <TableCell key={fieldKey} className="text-sm whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {v == null || v === '' ? <span className="text-muted-foreground">—</span> : String(v)}
                            {profileField && profileField.source_type && (
                              <Badge variant="outline" className="text-[9px] px-1 py-0 font-normal">
                                {profileField.source_type === 'back_office' ? 'BO' : profileField.source_type === 'ede' ? 'EDE' : 'COMM'}
                                {profileField.source_month ? ` · ${profileField.source_month}` : ''}
                              </Badge>
                            )}
                            {profileField && profileField.conflict && (
                              <Tooltip>
                                <TooltipTrigger>
                                  <AlertTriangle className="h-3 w-3 text-amber-500" />
                                </TooltipTrigger>
                                <TooltipContent>
                                  Conflict — also saw: {profileField.conflict_values.map(c => c.value).join(', ')}
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </span>
                        </TableCell>
                      );
                    })}
                    {INTERNAL_COLUMNS.map((c) => {
                      const v = row[c.key];
                      let display: React.ReactNode;
                      if (c.key === '_ffmId' || c.key === '_phone' || c.key === '_email') {
                        const f = v as EnrichedField<string>;
                        display = f?.value ? f.value : <span className="text-muted-foreground">—</span>;
                      } else if (c.key === '_estimatedMissingCommission') {
                        display = typeof v === 'number'
                          ? `$${v.toFixed(2)}`
                          : <span className="text-muted-foreground">TBD</span>;
                      } else if (v == null || v === '') {
                        display = <span className="text-muted-foreground">—</span>;
                      } else {
                        display = String(v);
                      }
                      return (
                        <TableCell key={String(c.key)} className="text-sm whitespace-nowrap bg-muted/20 text-muted-foreground">
                          {display}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {filteredExportRows.length > 250 && (
            <div className="px-4 py-2 text-xs text-muted-foreground border-t bg-muted/20">
              Preview limited to first 250 rows. CSV download includes all {filteredExportRows.length}.
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          NPN reference (Coverall): {Object.entries(NPN_MAP).map(([npn, info]) => `${info.name} (${npn})`).join(' · ')}
        </p>
      </div>
    </TooltipProvider>
  );
}
