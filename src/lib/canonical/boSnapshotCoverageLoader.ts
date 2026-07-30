/**
 * L1 — BO snapshot coverage LOADER (read-side only).
 *
 * Reads `bo_snapshots` joined to their `uploaded_files` state and the
 * canonically-active BO normalized rows belonging to each snapshot, producing
 * the pure coverage rows consumed by `buildBoSnapshotCoverage`.
 *
 * No schema change, no write, no rebuild. "Successful/promoted" is derived
 * from EXISTING canonical predicates only:
 *   uploaded_files.staging_status === 'active' && superseded_at IS NULL,
 * and the presence set uses only normalized rows that are themselves
 * staging_status='active' AND superseded_at IS NULL.
 *
 * Anything missing (no snapshot row, no file linkage, no date) simply does not
 * produce a coverage entry ⇒ the classifier sees `unknown`.
 */
import { supabase } from '@/integrations/supabase/client';
import {
  buildBoSnapshotCoverage,
  policyIdentityKeyForRecord,
  type BoSnapshotCoverageIndex,
  type BoSnapshotCoverageRow,
} from '@/lib/canonical/boSnapshotCoverage';

const PAGE = 1000;

export async function loadBoSnapshotCoverageRows(): Promise<BoSnapshotCoverageRow[]> {
  const { data: snaps, error: snapErr } = await (supabase as any)
    .from('bo_snapshots')
    .select(
      'id,carrier,agent_bucket,snapshot_date,created_at,uploaded_file_id,' +
        'uploaded_files!inner(id,staging_status,superseded_at,snapshot_date,aor_bucket)',
    );
  if (snapErr) throw snapErr;
  const rows: BoSnapshotCoverageRow[] = [];
  for (const s of (snaps ?? []) as any[]) {
    const f = s.uploaded_files ?? {};
    const promoted = f.staging_status === 'active' && f.superseded_at == null;
    const date = String(f.snapshot_date ?? s.snapshot_date ?? '').substring(0, 10);
    rows.push({
      snapshot_id: String(s.id),
      carrier: s.carrier,
      agent_bucket: s.agent_bucket ?? f.aor_bucket ?? null,
      snapshot_date: date || null,
      promoted,
      recency: s.created_at ?? null,
      policy_keys: promoted ? await loadSnapshotPolicyKeys(String(s.id)) : [],
    });
  }
  return rows;
}

/** Canonically-active BO rows belonging to one snapshot → identity keys. */
async function loadSnapshotPolicyKeys(snapshotId: string): Promise<string[]> {
  const keys = new Set<string>();
  let lastId: string | null = null;
  while (true) {
    let q: any = (supabase as any)
      .from('normalized_records')
      .select('id,carrier,policy_number,issuer_subscriber_id')
      .eq('bo_snapshot_id', snapshotId)
      .eq('staging_status', 'active')
      .is('superseded_at', null)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (lastId !== null) q = q.gt('id', lastId);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      const key = policyIdentityKeyForRecord({ ...r, source_type: 'BACK_OFFICE' } as any);
      if (key) keys.add(key);
    }
    if (data.length < PAGE) break;
    lastId = (data[data.length - 1] as any).id;
  }
  return Array.from(keys);
}

export async function loadBoSnapshotCoverage(): Promise<BoSnapshotCoverageIndex> {
  return buildBoSnapshotCoverage(await loadBoSnapshotCoverageRows());
}
