import Papa from 'papaparse';
import * as fs from 'fs';
import { normalizeEDERow, normalizeBackOfficeRow, normalizeCommissionRow } from '/dev-server/src/lib/normalize.ts';

const files = [
  { f: 'Becky_Back_Office_1776348079264.csv', t: 'BACK_OFFICE', aor: 'Becky Shuta' },
  { f: 'Erica_Back_Office_1776348086874.csv', t: 'BACK_OFFICE', aor: 'Erica Fine' },
  { f: 'Jason_Back_Office_1776973178940.csv', t: 'BACK_OFFICE', aor: 'Jason Fine' },
  { f: 'Vix_Commission_Statement_1776973243940.csv', t: 'COMMISSION', pe: 'Vix' },
  { f: 'Coverall_Commission_Statement_1776973343842.csv', t: 'COMMISSION', pe: 'Coverall' },
  { f: 'EDE_Archived_Not_Enrolled_1776358177757.csv', t: 'EDE' },
  { f: 'EDE_Archived_Enrolled_1776358182381.csv', t: 'EDE' },
  { f: 'EDE_Summary_1776358192204.csv', t: 'EDE' },
];

for (const { f, t, aor, pe } of files) {
  const content = fs.readFileSync(`/tmp/feb_files/${f}`, 'utf8');
  const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
  const raw = parsed.data as Record<string, string>[];
  let normalized: any[] = [];
  let firstErr: string | null = null;
  try {
    if (t === 'EDE') normalized = raw.map(r => normalizeEDERow(r, f)).filter(Boolean) as any[];
    else if (t === 'BACK_OFFICE') normalized = raw.map(r => normalizeBackOfficeRow(r, f, aor || ''));
    else normalized = raw.map(r => normalizeCommissionRow(r, f, pe || '')).filter(Boolean) as any[];
  } catch (e: any) { firstErr = e.message; }
  console.log(`${t.padEnd(11)} ${f}`);
  console.log(`   raw=${raw.length}  normalized=${normalized.length}  parseErrs=${parsed.errors?.length||0}  err=${firstErr||'none'}`);
  if (normalized.length === 0 && raw.length > 0) {
    console.log(`   FIRST RAW ROW KEYS: ${Object.keys(raw[0]).slice(0,10).join('|')}`);
    console.log(`   FIRST RAW ROW VAL: ${JSON.stringify(raw[0]).slice(0,300)}`);
  }
}
