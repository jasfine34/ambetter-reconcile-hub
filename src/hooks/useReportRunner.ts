/**
 * #124 — Loading State + Explicit Run Report pattern.
 *
 * Reusable state machine for filter-driven report pages. Built first for
 * Missing Commission Export; designed so other filter pages (Exception
 * Queue, Member Timeline, etc.) can adopt the same surface later.
 *
 * Five explicit states, never blank-on-error:
 *
 *   - idle    : page just loaded; user has not clicked Run Report yet.
 *   - loading : Run Report is currently computing.
 *   - error   : the runner threw; UI must show the error + a retry control.
 *   - empty   : runner completed with zero rows; UI must say so explicitly.
 *   - ready   : runner completed with rows; UI shows the results table.
 *
 * Plus one orthogonal flag:
 *
 *   - stale   : current filters differ from the filters that produced the
 *               currently-shown result. Old results stay visible (so the
 *               operator can still read / download them) but a banner is
 *               required to invite a re-run.
 *
 * Filter equality: shallow JSON-compare. Pages should pass small,
 * JSON-serializable filter objects. Object identity is NOT used so that
 * recomputed-but-equal filter objects do not flap the stale flag.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

export type ReportStatus = 'idle' | 'loading' | 'error' | 'empty' | 'ready';

export interface ReportRunnerState<F, R> {
  /** Coarse state — drive the top-level UI branch off this. */
  status: ReportStatus;
  /**
   * Filters captured at the moment of the most recent successful (or failed)
   * run. `null` until the first Run Report click. Download / export logic
   * must read from this snapshot, NOT the live filter state, so the file
   * always matches what the operator sees on screen.
   */
  ranFilters: F | null;
  /** Result of the most recent successful run. `null` while idle / loading / error. */
  result: R | null;
  /** Error from the most recent failed run; cleared on the next successful run. */
  error: Error | null;
  /**
   * True iff a result exists AND the live filters no longer match the
   * filters that produced it. Always false in idle / loading / error.
   */
  stale: boolean;
  /** Trigger a run with the current filters. Idempotent if already loading. */
  run: () => Promise<void>;
  /** Reset to idle (drops result + error + ranFilters). Used by tests; pages rarely need it. */
  reset: () => void;
}

interface Options<R> {
  /**
   * Treat a result as "empty" instead of "ready". Defaults to
   * `r => Array.isArray(r) && r.length === 0`. Pass a custom predicate when
   * the result is e.g. an object containing a rows array.
   */
  isEmpty?: (result: R) => boolean;
}

function shallowEq<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  const ak = Object.keys(a as any);
  const bk = Object.keys(b as any);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.is((a as any)[k], (b as any)[k])) return false;
  }
  return true;
}

/**
 * Build a filter-driven report runner.
 *
 * Usage:
 *
 *     const filters = { scope, premiumBucket, batchId };
 *     const runner = useReportRunner(filters, async (f) => {
 *       return computeRows(f);   // pure or async — both fine
 *     });
 *
 *     // Render branch:
 *     if (runner.status === 'idle')    return <Initial />;
 *     if (runner.status === 'loading') return <Spinner />;
 *     if (runner.status === 'error')   return <ErrorState onRetry={runner.run} />;
 *     if (runner.status === 'empty')   return <EmptyState />;
 *     return <Table rows={runner.result!} />;
 */
export function useReportRunner<F, R>(
  filters: F,
  runner: (filters: F) => Promise<R> | R,
  options: Options<R> = {},
): ReportRunnerState<F, R> {
  const [status, setStatus] = useState<ReportStatus>('idle');
  const [ranFilters, setRanFilters] = useState<F | null>(null);
  const [result, setResult] = useState<R | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Latest runner ref so callers can pass an inline async fn without
  // re-binding `run` (which would invalidate downstream memoization).
  const runnerRef = useRef(runner);
  runnerRef.current = runner;

  // Latest filters ref — `run()` always uses the live snapshot, not a
  // stale closure capture from when the button was first wired.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // Single-flight guard: clicking Run Report twice fast must not fire two
  // overlapping runners (the second's result could land before the first's
  // and silently overwrite it).
  const inflightRef = useRef(false);

  const isEmpty = options.isEmpty ?? ((r: R) => Array.isArray(r) && r.length === 0);

  const run = useCallback(async () => {
    if (inflightRef.current) return;
    const snapshot = filtersRef.current;
    inflightRef.current = true;
    setStatus('loading');
    setError(null);
    try {
      const out = await runnerRef.current(snapshot);
      setResult(out);
      setRanFilters(snapshot);
      setStatus(isEmpty(out) ? 'empty' : 'ready');
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      setRanFilters(snapshot);
      // Keep prior `result` visible so operator can still read the last
      // good run while seeing the error toast / banner. The status flip
      // gates the table render branch instead.
      setStatus('error');
    } finally {
      inflightRef.current = false;
    }
  }, [isEmpty]);

  const reset = useCallback(() => {
    setStatus('idle');
    setRanFilters(null);
    setResult(null);
    setError(null);
  }, []);

  // Stale: only meaningful once a run has produced a snapshot AND the
  // current state shows that snapshot's data (ready/empty/error). During
  // idle / loading there is nothing on screen to be stale.
  const stale = useMemo(() => {
    if (ranFilters == null) return false;
    if (status === 'idle' || status === 'loading') return false;
    return !shallowEq(filters, ranFilters);
  }, [filters, ranFilters, status]);

  return { status, ranFilters, result, error, stale, run, reset };
}
