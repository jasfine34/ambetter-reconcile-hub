import { describe, it, expect } from 'vitest';
import { computeFirstEligibleMonth } from '@/lib/classifier';

const COVERALL_NPN = '21055210';
const COVERALL_NAME = 'Jason Fine';

function bo(opts: any): any {
  return {
    source_type: 'BACK_OFFICE',
    agent_npn: COVERALL_NPN,
    agent_name: COVERALL_NAME,
    aor_bucket: COVERALL_NAME,
    carrier: 'ambetter',
    raw_json: {},
    ...opts,
  };
}

describe('computeFirstEligibleMonth — Fix 4 BED override returns BED month', () => {
  it('BED <= PED (new enrollment) → first eligible = PED month', () => {
    const r = bo({ effective_date: '2026-03-01', broker_effective_date: '2026-02-15' });
    expect(computeFirstEligibleMonth([r] as any)).toBe('2026-03');
  });

  it('BED > PED (NPN override) → first eligible = BED month (NOT BED+1)', () => {
    const r = bo({ effective_date: '2026-01-01', broker_effective_date: '2026-05-15' });
    expect(computeFirstEligibleMonth([r] as any)).toBe('2026-05');
  });

  it('BED far in future → first eligible = BED month', () => {
    const r = bo({ effective_date: '2025-06-01', broker_effective_date: '2027-01-15' });
    expect(computeFirstEligibleMonth([r] as any)).toBe('2027-01');
  });
});
