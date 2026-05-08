/**
 * Phase 1 follow-up render tests:
 *
 * 1. Bottom-split chips (Matched / BO Only / EDE Only) render on the three
 *    expected-payment cards (Should Be Paid, Expected Payments Received,
 *    Expected But Unpaid) with labels exactly as required.
 * 2. Paid: EDE Only drilldown column renders bo_reason ("BO inactive/terminated"
 *    or "BO absent") for the corresponding rows.
 *
 * These tests target the presentation contract directly (MetricCard +
 * DataTable) rather than mounting the full DashboardPage so they remain fast
 * and deterministic.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetricCard } from '@/components/MetricCard';
import { DataTable } from '@/components/DataTable';

const PAID_EDE_ONLY_DRILLDOWN_COLUMNS = [
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
  { key: 'bo_reason', label: 'BO Reason' },
];

describe('Expected-payment cards render bottom-split chips', () => {
  it('Should Be Paid card shows Matched / BO Only / EDE Only chips with helper counts', () => {
    render(
      <MetricCard
        title="Should Be Paid"
        value={2573}
        splits={[
          { label: 'Matched', value: 1703 },
          { label: 'BO Only', value: 558 },
          { label: 'EDE Only', value: 312 },
        ]}
      />,
    );
    const matched = screen.getByTestId('metric-card-split-Matched');
    const boOnly = screen.getByTestId('metric-card-split-BO Only');
    const edeOnly = screen.getByTestId('metric-card-split-EDE Only');
    expect(matched).toHaveTextContent('Matched');
    expect(matched).toHaveTextContent('1,703');
    expect(boOnly).toHaveTextContent('BO Only');
    expect(boOnly).toHaveTextContent('558');
    expect(edeOnly).toHaveTextContent('EDE Only');
    expect(edeOnly).toHaveTextContent('312');
  });

  it('Expected Payments Received card uses paidSplit chips', () => {
    render(
      <MetricCard
        title="Expected Payments Received"
        value={1422}
        splits={[
          { label: 'Matched', value: 1354 },
          { label: 'BO Only', value: 56 },
          { label: 'EDE Only', value: 12 },
        ]}
      />,
    );
    expect(screen.getByTestId('metric-card-split-Matched')).toHaveTextContent('1,354');
    expect(screen.getByTestId('metric-card-split-BO Only')).toHaveTextContent('56');
    expect(screen.getByTestId('metric-card-split-EDE Only')).toHaveTextContent('12');
  });

  it('Expected But Unpaid card uses unpaidSplit chips', () => {
    render(
      <MetricCard
        title="Expected But Unpaid"
        value={1151}
        splits={[
          { label: 'Matched', value: 349 },
          { label: 'BO Only', value: 502 },
          { label: 'EDE Only', value: 300 },
        ]}
      />,
    );
    expect(screen.getByTestId('metric-card-split-Matched')).toHaveTextContent('349');
    expect(screen.getByTestId('metric-card-split-BO Only')).toHaveTextContent('502');
    expect(screen.getByTestId('metric-card-split-EDE Only')).toHaveTextContent('300');
  });

  it('omits the splits region when no splits prop is passed', () => {
    render(<MetricCard title="Plain" value={1} />);
    expect(screen.queryByTestId('metric-card-splits')).toBeNull();
  });
});

describe('Paid: EDE Only drilldown renders bo_reason column', () => {
  it('shows "BO inactive/terminated" and "BO absent" values in the BO Reason column', () => {
    const rows = [
      {
        applicant_name: 'Jane Doe',
        agent_npn: '21055210',
        policy_number: 'u1234567',
        in_ede: true,
        in_back_office: false,
        in_commission: true,
        bo_reason: 'BO inactive/terminated',
      },
      {
        applicant_name: 'John Roe',
        agent_npn: '21277051',
        policy_number: 'uz9876543',
        in_ede: true,
        in_back_office: false,
        in_commission: true,
        bo_reason: 'BO absent',
      },
    ];
    render(<DataTable data={rows} columns={PAID_EDE_ONLY_DRILLDOWN_COLUMNS} />);
    // Header present
    expect(screen.getByText(/BO Reason/i)).toBeInTheDocument();
    // Both classification values rendered for the corresponding fixture rows
    expect(screen.getByText('BO inactive/terminated')).toBeInTheDocument();
    expect(screen.getByText('BO absent')).toBeInTheDocument();
  });
});
