import { describe, it, expect } from 'vitest';

/**
 * Mirror of the server-side chunking logic in
 * public.replace_reconciled_members_for_batch (see migration
 * 2026.04.30-chunked-rpc). The SQL function loops `chunk_size = 1000` rows at
 * a time within a single transaction, so each individual INSERT statement
 * stays well under statement_timeout while preserving atomic replace.
 *
 * This test documents and validates the chunking contract: for any payload
 * size, every input row is inserted exactly once and no chunk exceeds 1000.
 */
function chunkLikeRpc<T>(rows: T[], chunkSize = 1000): T[][] {
  const chunks: T[][] = [];
  let start = 0;
  while (start < rows.length) {
    chunks.push(rows.slice(start, start + chunkSize));
    start += chunkSize;
  }
  return chunks;
}

describe('replace_reconciled_members_for_batch — chunking contract', () => {
  it('handles a 5,000-row payload in 5 chunks of 1,000', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ idx: i }));
    const chunks = chunkLikeRpc(rows);
    expect(chunks.length).toBe(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    const flat = chunks.flat();
    expect(flat.length).toBe(rows.length);
    expect(flat[0].idx).toBe(0);
    expect(flat[flat.length - 1].idx).toBe(4999);
  });

  it('handles the realistic March 2026 batch size (3,890)', () => {
    const rows = Array.from({ length: 3890 }, (_, i) => ({ idx: i }));
    const chunks = chunkLikeRpc(rows);
    expect(chunks.length).toBe(4); // 1000 + 1000 + 1000 + 890
    expect(chunks[3].length).toBe(890);
    expect(chunks.flat().length).toBe(3890);
  });

  it('handles partial last chunk', () => {
    const rows = Array.from({ length: 1234 }, (_, i) => i);
    const chunks = chunkLikeRpc(rows);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(1000);
    expect(chunks[1].length).toBe(234);
  });

  it('handles empty payload (no chunks emitted, no INSERT runs)', () => {
    expect(chunkLikeRpc([])).toEqual([]);
  });

  it('handles small payload below chunk size in a single chunk', () => {
    const rows = Array.from({ length: 17 }, (_, i) => i);
    const chunks = chunkLikeRpc(rows);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(17);
  });
});
