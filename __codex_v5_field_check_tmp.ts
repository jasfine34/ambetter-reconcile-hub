Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  },
  configurable: true,
});

const { getBatches, getReconciledMembers } = await import('@/lib/persistence');

const batches = await getBatches();
const batchByMonth = new Map<string, any>();
for (const b of batches) {
  const month = String(b.statement_month ?? '').substring(0, 7);
  if (month === '2026-04' && String(b.carrier ?? 'Ambetter') === 'Ambetter') {
    batchByMonth.set(month, b);
  }
}
const batch = batchByMonth.get('2026-04');
if (!batch) throw new Error('missing April Ambetter batch');
const reconciled = await getReconciledMembers(batch.id);
const withExpected = reconciled.filter((r: any) => Object.prototype.hasOwnProperty.call(r, 'expected_pay_entity')).length;
const withActual = reconciled.filter((r: any) => Object.prototype.hasOwnProperty.call(r, 'actual_pay_entity')).length;
const values = {
  batch_id: batch.id,
  row_count: reconciled.length,
  expected_pay_entity_field_count: withExpected,
  actual_pay_entity_field_count: withActual,
  expected_pay_entity_values: Array.from(new Set(reconciled.map((r: any) => r.expected_pay_entity))).sort(),
  actual_pay_entity_values: Array.from(new Set(reconciled.map((r: any) => r.actual_pay_entity))).sort(),
  sample: reconciled.slice(0, 3).map((r: any) => ({
    member_key: r.member_key,
    expected_pay_entity: r.expected_pay_entity,
    actual_pay_entity: r.actual_pay_entity,
  })),
};
console.log(JSON.stringify(values, null, 2));
