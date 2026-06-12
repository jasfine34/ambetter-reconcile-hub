/**
 * WideDataTable — extracted mirrored-scroll primitive.
 *
 * Covers:
 *   - Top scrollbar exists with stable test id `op-top-scrollbar`.
 *   - Bottom scroll region exists with stable test id `op-table-scroll`.
 *   - Bidirectional scroll sync (top → bottom and bottom → top).
 *   - ArrowLeft/ArrowRight scroll horizontally when the region has focus.
 *   - Arrow keys are NOT intercepted when focus is inside an interactive
 *     cell control (input/button/etc.).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { WideDataTable } from '@/components/WideDataTable';

beforeEach(() => {
  // jsdom doesn't implement ResizeObserver.
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function renderTable() {
  return render(
    <WideDataTable scrollStep={200}>
      <table>
        <thead>
          <tr>
            <th>A</th><th>B</th><th>C</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <input data-testid="cell-input" defaultValue="x" />
            </td>
            <td>
              <button data-testid="cell-button">go</button>
            </td>
            <td>plain</td>
          </tr>
        </tbody>
      </table>
    </WideDataTable>,
  );
}

describe('WideDataTable', () => {
  it('renders both stable scroll regions', () => {
    const { getByTestId } = renderTable();
    expect(getByTestId('op-top-scrollbar')).toBeInTheDocument();
    expect(getByTestId('op-table-scroll')).toBeInTheDocument();
  });

  it('mirrors scroll bidirectionally', () => {
    const { getByTestId } = renderTable();
    const top = getByTestId('op-top-scrollbar') as HTMLDivElement;
    const bottom = getByTestId('op-table-scroll') as HTMLDivElement;

    // top → bottom
    top.scrollLeft = 75;
    fireEvent.scroll(top);
    // In a real browser, the programmatic scrollLeft assignment on bottom
    // fires a scroll event that the handler swallows via the guard. jsdom
    // doesn't auto-fire that scroll, so we fire it manually to exercise
    // both directions of the sync.
    fireEvent.scroll(bottom);
    expect(bottom.scrollLeft).toBe(75);

    // bottom → top
    bottom.scrollLeft = 130;
    fireEvent.scroll(bottom);
    fireEvent.scroll(top);
    expect(top.scrollLeft).toBe(130);
  });

  it('ArrowRight / ArrowLeft scroll horizontally when region has focus', () => {
    const { getByTestId } = renderTable();
    const bottom = getByTestId('op-table-scroll') as HTMLDivElement;
    expect(bottom.tabIndex).toBe(0);

    bottom.scrollLeft = 0;
    fireEvent.keyDown(bottom, { key: 'ArrowRight' });
    expect(bottom.scrollLeft).toBeGreaterThan(0);
    const after = bottom.scrollLeft;
    fireEvent.keyDown(bottom, { key: 'ArrowLeft' });
    expect(bottom.scrollLeft).toBeLessThan(after);
  });

  it('does NOT intercept arrows when focus is in an interactive cell control', () => {
    const { getByTestId } = renderTable();
    const bottom = getByTestId('op-table-scroll') as HTMLDivElement;
    const input = getByTestId('cell-input') as HTMLInputElement;
    const button = getByTestId('cell-button') as HTMLButtonElement;

    bottom.scrollLeft = 50;
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(bottom.scrollLeft).toBe(50);

    fireEvent.keyDown(button, { key: 'ArrowLeft' });
    expect(bottom.scrollLeft).toBe(50);
  });
});
