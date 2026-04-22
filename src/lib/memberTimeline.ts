import type { NormalizedRecord } from './normalize';
import { parseMoney } from './normalize';

export interface MonthCell {
  month: string;                   // 'YYYY-MM'
  in_ede: boolean;
  in_back_office: boolean;
  in_commission: boolean;
  paid_amount: number;             // sum of commission $ attributed to this service month
  payment_count: number;
  due: boolean;                    // active in BO OR qualified EDE this month
}

export interface MemberTimelineRow {
  member_key: string;
  applicant_name: string;
  policy_number: string;
  exchange_subscriber_id: string;
  issuer_subscriber_id: string;
  agent_name: string;
  aor_bucket: string;
  cells: Record<string, MonthCell>;  // keyed by 'YYYY-MM'
  total_paid: number;
  months_due: number;
  months_paid: number;
  months_unpaid: number;
}

const QUALIFIED_EDE_RAW_STATUSES = new Set([
  'effectuated',
  'pendingeffectuation',
  'pendingtermination',
]);

/** Generate inclusive list of YYYY-MM strings between start and end. */
export function buildMonthList(startYM: string, endYM: string): string[] {
  const out: string[] = [];
  const [sy, sm] = startYM.split('-').map(Number);
  const [ey, em] = endYM.split('-').map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function ymOf(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  // ISO YYYY-MM-DD or YYYY-MM
  const iso = s.match(/^(\d{4})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  // MM/DD/YYYY
  const slash = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (slash) {
    let yr = parseInt(slash[3]);
    if (yr < 100) yr += 2000;
    return `${yr}-${slash[1].padStart(2, '0')}`;
  }
  return null;
}

/** Add n months to a YYYY-MM string. */
function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  let total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function rawStatusKey(r: NormalizedRecord): string {
  const raw = (r.raw_json?.['policyStatus'] ?? r.status ?? '') as string;
  return String(raw).toLowerCase().replace(/\s+/g, '');
}
function rawIssuerKey(r: NormalizedRecord): string {
  const raw = (r.raw_json?.['issuer'] ?? r.carrier ?? '') as string;
  return String(raw).toLowerCase();
}

/** True if this EDE row is "qualified" — used to mark a member as due. */
function isEDEQualified(r: NormalizedRecord): boolean {
  if (r.source_type !== 'EDE') return false;
  if (!QUALIFIED_EDE_RAW_STATUSES.has(rawStatusKey(r))) return false;
  if (!rawIssuerKey(r).includes('ambetter')) return false;
  return true;
}

/**
 * For a Back Office record, return the inclusive [startYM, endYM] active range.
 * - start = effective_date month (or first of universe if missing)
 * - end   = policy_term_date month - 1, OR paid_through_date month, OR open
 *   We use policy_term_date as exclusive (a term date of 2/1 means active through Jan).
 */
function backOfficeActiveRange(r: NormalizedRecord): { start: string | null; end: string | null } {
  const start = ymOf(r.effective_date);
  let end: string | null = null;
  if (r.policy_term_date) {
    const termYM = ymOf(r.policy_term_date);
    if (termYM) {
      // Term date is exclusive — active through prior month
      end = addMonths(termYM, -1);
    }
  } else if (r.paid_through_date) {
    end = ymOf(r.paid_through_date);
  }
  return { start, end };
}

/**
 * Distribute a commission row's gross amount across the months it covers.
 * Uses Paid-To Date as the END of the covered period and Months Paid as the span.
 * Falls back to the Paid-To Date month alone, or Issue Date month, if Months Paid missing.
 */
function commissionServiceMonths(r: NormalizedRecord): { months: string[]; per: number; total: number } {
  const total = r.commission_amount ?? 0;
  if (total === 0) return { months: [], per: 0, total: 0 };

  const paidToRaw = r.raw_json?.['Paid-To Date'];
  const paidToYM = ymOf(typeof paidToRaw === 'string' ? paidToRaw : null);
  const monthsPaidRaw = r.raw_json?.['Months Paid'];
  const monthsPaid = monthsPaidRaw ? Math.max(1, parseInt(String(monthsPaidRaw)) || 1) : 1;

  let endYM = paidToYM;
  if (!endYM) {
    const issueRaw = r.raw_json?.['Issue Date'];
    endYM = ymOf(typeof issueRaw === 'string' ? issueRaw : null) || ymOf(r.effective_date);
  }
  if (!endYM) return { months: [], per: 0, total };

  const months: string[] = [];
  for (let i = monthsPaid - 1; i >= 0; i--) {
    months.push(addMonths(endYM, -i));
  }
  return { months, per: total / months.length, total };
}

function emptyCell(month: string): MonthCell {
  return {
    month,
    in_ede: false,
    in_back_office: false,
    in_commission: false,
    paid_amount: 0,
    payment_count: 0,
    due: false,
  };
}

export function buildMemberTimeline(
  records: NormalizedRecord[],
  monthList: string[]
): MemberTimelineRow[] {
  const monthSet = new Set(monthList);
  const byMember = new Map<string, NormalizedRecord[]>();
  for (const r of records) {
    const key = r.member_key || r.applicant_name || 'unknown';
    let arr = byMember.get(key);
    if (!arr) { arr = []; byMember.set(key, arr); }
    arr.push(r);
  }

  const rows: MemberTimelineRow[] = [];

  for (const [key, recs] of byMember) {
    const cells: Record<string, MonthCell> = {};
    for (const m of monthList) cells[m] = emptyCell(m);

    // Identity: prefer EDE/BO record with most info
    const sample = recs.find(r => r.applicant_name) || recs[0];
    const row: MemberTimelineRow = {
      member_key: key,
      applicant_name: sample?.applicant_name || '',
      policy_number: recs.find(r => r.policy_number)?.policy_number || '',
      exchange_subscriber_id: recs.find(r => r.exchange_subscriber_id)?.exchange_subscriber_id || '',
      issuer_subscriber_id: recs.find(r => r.issuer_subscriber_id)?.issuer_subscriber_id || '',
      agent_name: recs.find(r => r.agent_name)?.agent_name || '',
      aor_bucket: recs.find(r => r.aor_bucket)?.aor_bucket || '',
      cells,
      total_paid: 0,
      months_due: 0,
      months_paid: 0,
      months_unpaid: 0,
    };

    for (const r of recs) {
      if (r.source_type === 'EDE') {
        const ym = ymOf(r.effective_date);
        if (ym && monthSet.has(ym)) {
          cells[ym].in_ede = true;
          if (isEDEQualified(r)) cells[ym].due = true;
        }
      } else if (r.source_type === 'BACK_OFFICE') {
        const { start, end } = backOfficeActiveRange(r);
        if (!start) continue;
        for (const m of monthList) {
          if (m < start) continue;
          if (end && m > end) continue;
          cells[m].in_back_office = true;
          cells[m].due = true;
        }
      } else if (r.source_type === 'COMMISSION') {
        const { months, per } = commissionServiceMonths(r);
        for (const m of months) {
          if (!monthSet.has(m)) continue;
          cells[m].in_commission = true;
          cells[m].paid_amount += per;
          cells[m].payment_count += 1;
        }
      }
    }

    // Totals
    for (const m of monthList) {
      const c = cells[m];
      row.total_paid += c.paid_amount;
      if (c.due) row.months_due += 1;
      if (c.due && c.paid_amount > 0.0001) row.months_paid += 1;
      if (c.due && c.paid_amount <= 0.0001) row.months_unpaid += 1;
    }

    rows.push(row);
  }

  // Sort: most months_unpaid first, then by name
  rows.sort((a, b) => {
    if (b.months_unpaid !== a.months_unpaid) return b.months_unpaid - a.months_unpaid;
    return a.applicant_name.localeCompare(b.applicant_name);
  });

  return rows;
}

export function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleString('en-US', { month: 'short', year: '2-digit' });
}
