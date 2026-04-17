// Detects which source-type schema a CSV most likely matches based on its headers.
// Used to warn users when a file appears to be uploaded under the wrong category.

export type DetectedSchema = 'EDE' | 'BACK_OFFICE' | 'COMMISSION' | 'UNKNOWN';

const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '').trim();

// Strong signal headers per schema (after normalization)
const EDE_SIGNALS = ['exchangesubscriberid', 'exchangepolicyid', 'policystatus', 'qhpid'];
const BACK_OFFICE_SIGNALS = ['eligibleforcommission', 'numberofmembers', 'coveredmembercount'];
const COMMISSION_SIGNALS = ['grosscommission', 'netcommission', 'commissionamount', 'paidamount'];

export function detectSchema(headers: string[]): DetectedSchema {
  const set = new Set(headers.map(norm));
  const score = {
    EDE: EDE_SIGNALS.filter(h => set.has(h)).length,
    BACK_OFFICE: BACK_OFFICE_SIGNALS.filter(h => set.has(h)).length,
    COMMISSION: COMMISSION_SIGNALS.filter(h => set.has(h)).length,
  };
  const max = Math.max(score.EDE, score.BACK_OFFICE, score.COMMISSION);
  if (max === 0) return 'UNKNOWN';
  // Prefer specificity: BACK_OFFICE/COMMISSION over EDE if tied (EDE policy fields can appear elsewhere)
  if (score.BACK_OFFICE === max) return 'BACK_OFFICE';
  if (score.COMMISSION === max) return 'COMMISSION';
  return 'EDE';
}

export async function readCSVHeaders(file: File): Promise<string[]> {
  // Read just enough of the file to capture the header row
  const slice = file.slice(0, 64 * 1024);
  const text = await slice.text();
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  // Simple CSV header split — handles quoted fields
  const headers: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i++) {
    const c = firstLine[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { headers.push(cur); cur = ''; continue; }
    cur += c;
  }
  headers.push(cur);
  return headers.map(h => h.trim());
}
