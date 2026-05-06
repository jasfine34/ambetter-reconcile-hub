/**
 * #118 — Read-only measurement of persistent vs canonical EE-universe drift.
 *
 * For each batch × scope (Coverall, Vix, All):
 *   - Persistent set: reconciled_members.member_key WHERE is_in_expected_ede_universe=true
 *                     filtered to scope via canonical getMembersInScope.
 *   - Canonical set:  computeFilteredEde(...).uniqueMembers[].member_key.
 * Reports |P|, |C|, |P ∩ C|, P\C, C\P, jaccard.
 *
 * Read-only. No DB writes, no UI. Run via:
 *   bun run scripts/measure_ee_universe_drift.ts
 */
import { createClient } from '@supabase/supabase-js';
import { computeFilteredEde, type PayEntityScope } from '../src/lib/expectedEde';
import { getMembersInScope, type CanonicalScope } from '../src/lib/canonical/scope';
import { loadResolverIndex } from '../src/lib/resolvedIdentities';

// Hardcoded — read-only diagnostic.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sbbsfbzxixcmaoliixae.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY!;
if (!SUPABASE_KEY) {
  console.error('Need SUPABASE_SERVICE_ROLE_KEY or SUPABASE_PUBLISHABLE_KEY in env');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PAGE = 1000;

async function pagedSelect(table: string, batchId: string, opts: { activeOnly?: boolean } = {}) {
  const all: any[] = [];
  let lastId: string | null = null;
  while (true) {
    let q: any = (supabase as any).from(table).select('*').eq('batch_id', batchId)
      .order('id', { ascending: true }).limit(PAGE);
    if (opts.activeOnly) q = q.eq('staging_status', 'active').is('superseded_at', null);
    if (lastId) q = q.gt('id', lastId);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    lastId = data[data.length - 1].id;
  }
  return all;
}

function diff(a: Set<string>, b: Set<string>): { onlyA: string[]; onlyB: string[]; inter: number } {
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const k of a) if (!b.has(k)) onlyA.push(k);
  for (const k of b) if (!a.has(k)) onlyB.push(k);
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  return { onlyA, onlyB, inter };
}

async function main() {
  const { data: batches, error } = await supabase
    .from('upload_batches').select('id, statement_month').order('statement_month');
  if (error) throw error;
  const resolverIndex = await loadResolverIndex(true);

  const scopes: CanonicalScope[] = ['Coverall', 'Vix', 'All'];
  const lines: string[] = [];
  lines.push('# #118 EE-Universe Drift Measurement');
  lines.push('');
  lines.push('Persistent = `reconciled_members.is_in_expected_ede_universe=true`, filtered to scope via canonical `getMembersInScope`.');
  lines.push('Canonical  = `computeFilteredEde(...).uniqueMembers[].member_key` (the live Dashboard EE-universe).');
  lines.push('');
  lines.push('| Batch | Scope | Persistent | Canonical | Intersection | Persistent\\Canonical | Canonical\\Persistent | Jaccard |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|');

  const examples: string[] = [];

  for (const b of batches!) {
    const month = String(b.statement_month).substring(0, 7);
    const reconciled = await pagedSelect('reconciled_members', b.id);
    const normalized = await pagedSelect('normalized_records', b.id, { activeOnly: true });
    const coveredMonths = [month]; // single statement month per batch (matches BatchContext)

    for (const scope of scopes) {
      // Persistent set: filter reconciled to scope, then keep only is_in_expected_ede_universe.
      const inScope = scope === 'All'
        ? reconciled
        : reconciled.filter((r) => getMembersInScope([r], scope).has(r.member_key));
      const persistent = new Set<string>(
        inScope.filter((r) => r.is_in_expected_ede_universe === true).map((r) => r.member_key),
      );

      // Canonical set: filteredEde under same scope.
      const filteredEde = computeFilteredEde(
        normalized,
        reconciled,
        scope as PayEntityScope,
        coveredMonths,
        resolverIndex,
      );
      const canonical = new Set<string>(filteredEde.uniqueMembers.map((m) => m.member_key));

      const { onlyA, onlyB, inter } = diff(persistent, canonical);
      const union = persistent.size + canonical.size - inter;
      const jaccard = union === 0 ? 1 : inter / union;
      lines.push(
        `| ${month} | ${scope} | ${persistent.size} | ${canonical.size} | ${inter} | ${onlyA.length} | ${onlyB.length} | ${jaccard.toFixed(4)} |`,
      );

      // Sample up to 3 keys from each side for inspection.
      if (onlyA.length || onlyB.length) {
        examples.push(`\n### ${month} / ${scope}`);
        if (onlyA.length) examples.push(`- Persistent\\Canonical (${onlyA.length}): ${onlyA.slice(0, 5).join(', ')}${onlyA.length > 5 ? ' …' : ''}`);
        if (onlyB.length) examples.push(`- Canonical\\Persistent (${onlyB.length}): ${onlyB.slice(0, 5).join(', ')}${onlyB.length > 5 ? ' …' : ''}`);
      }
    }
  }

  if (examples.length) {
    lines.push('');
    lines.push('## Sample divergent member_keys');
    lines.push(...examples);
  }

  const out = lines.join('\n') + '\n';
  console.log(out);
  await Bun.write('/mnt/documents/issue_118_ee_universe_drift.md', out);
}

main().catch((e) => { console.error(e); process.exit(1); });
