/**
 * WideDataTable — shared "mirrored scrollbar" wrapper for wide tables.
 *
 * Extracted from OperatorReviewPage's previously local MirroredScrollTable.
 * Provides:
 *   - Top horizontal scrollbar mirrored to the bottom scroll container
 *     (bidirectional sync).
 *   - A focusable bottom scroll region with ArrowLeft/ArrowRight keyboard
 *     navigation that scrolls horizontally by ~one column width.
 *   - Stable test ids (`op-top-scrollbar`, `op-table-scroll`) preserved
 *     for back-compat with existing tests.
 *
 * Keyboard navigation deliberately does NOT intercept arrow keys when the
 * focused element is an interactive control inside the scroll region
 * (input/textarea/select/button/contenteditable). The scroll region itself
 * is keyboard-focusable via tabIndex={0}.
 */
import React, { useEffect, useRef, useState } from 'react';

interface WideDataTableProps {
  children: React.ReactNode;
  /** Horizontal scroll step in px for ArrowLeft/ArrowRight. Defaults to 200. */
  scrollStep?: number;
}

function isInteractiveTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return true;
  if (t.isContentEditable) return true;
  if (t.getAttribute('role') === 'combobox' || t.getAttribute('role') === 'textbox') return true;
  return false;
}

export function WideDataTable({ children, scrollStep = 200 }: WideDataTableProps) {
  const topRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [innerWidth, setInnerWidth] = useState(0);
  const syncing = useRef<'top' | 'bottom' | null>(null);

  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const measure = () => setInnerWidth(el.scrollWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild as Element);
    return () => ro.disconnect();
  }, [children]);

  const onTopScroll = () => {
    if (syncing.current === 'bottom') { syncing.current = null; return; }
    if (!topRef.current || !bottomRef.current) return;
    syncing.current = 'top';
    bottomRef.current.scrollLeft = topRef.current.scrollLeft;
  };
  const onBottomScroll = () => {
    if (syncing.current === 'top') { syncing.current = null; return; }
    if (!topRef.current || !bottomRef.current) return;
    syncing.current = 'bottom';
    topRef.current.scrollLeft = bottomRef.current.scrollLeft;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (isInteractiveTarget(e.target)) return;
    const el = bottomRef.current;
    if (!el) return;
    // Use first column width when available; fall back to scrollStep.
    let step = scrollStep;
    const firstCell = el.querySelector('thead th, tbody td') as HTMLElement | null;
    if (firstCell && firstCell.offsetWidth > 0) step = firstCell.offsetWidth;
    e.preventDefault();
    el.scrollLeft += e.key === 'ArrowRight' ? step : -step;
  };

  return (
    <div className="border rounded-lg bg-card">
      <div
        ref={topRef}
        onScroll={onTopScroll}
        className="overflow-x-auto overflow-y-hidden"
        aria-hidden="true"
        data-testid="op-top-scrollbar"
      >
        <div style={{ width: innerWidth || 1, height: 1 }} />
      </div>
      <div
        ref={bottomRef}
        onScroll={onBottomScroll}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="region"
        aria-label="Scrollable table"
        className="overflow-x-auto max-h-[70vh] overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="op-table-scroll"
      >
        {children}
      </div>
    </div>
  );
}

export default WideDataTable;
