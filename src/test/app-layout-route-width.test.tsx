/**
 * AppLayout route-based full-width opt-in.
 *
 * Locks two invariants:
 *   1. Default routes keep the EXACT classes `max-w-7xl mx-auto p-6` (regression lock).
 *   2. `/operator-review` opts into a full-width wrapper (`w-full p-6`, no `max-w-7xl`).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';

function classesOfMainChild(container: HTMLElement): string {
  const main = container.querySelector('main');
  expect(main).toBeTruthy();
  const inner = main!.firstElementChild as HTMLElement | null;
  expect(inner).toBeTruthy();
  return inner!.className;
}

describe('AppLayout — route-based wrapper width', () => {
  it('keeps byte-identical default classes on non-opt-in routes', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <AppLayout>
          <div data-testid="child">x</div>
        </AppLayout>
      </MemoryRouter>,
    );
    expect(classesOfMainChild(container)).toBe('max-w-7xl mx-auto p-6');
  });

  it('also keeps default classes on /upload (regression lock for other routes)', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/upload']}>
        <AppLayout>
          <div>x</div>
        </AppLayout>
      </MemoryRouter>,
    );
    expect(classesOfMainChild(container)).toBe('max-w-7xl mx-auto p-6');
  });

  it('renders full-width wrapper on /operator-review', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/operator-review']}>
        <AppLayout>
          <div>x</div>
        </AppLayout>
      </MemoryRouter>,
    );
    const cls = classesOfMainChild(container);
    expect(cls).toContain('w-full');
    expect(cls).not.toContain('max-w-7xl');
  });
});
