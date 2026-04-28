/**
 * Shared pay-entity scope state — synchronizes the Coverall / Vix / All
 * filter across pages (Dashboard, Agent Summary, ...). Persisted to
 * localStorage under the same key the Dashboard already uses, and synced
 * across hook instances via a custom event so a change on one page is
 * reflected immediately on another without a remount.
 *
 * Background: prior to this hook, AgentSummaryPage had no scope state at all
 * and silently aggregated commission across BOTH pay entities (effectively
 * scope='All'). That produced a +$463.50 over-count on Mar 2026 Coverall —
 * exactly the Vix scope total leaking in. This hook fixes that by giving
 * every page the SAME source-of-truth scope.
 */
import { useCallback, useEffect, useState } from 'react';

export type PayEntityScope = 'Coverall' | 'Vix' | 'All';

export const PAY_ENTITY_STORAGE_KEY = 'dashboard_pay_entity_filter';
const SCOPE_CHANGE_EVENT = 'lovable:pay-entity-scope-change';

export function readStoredPayEntity(): PayEntityScope {
  try {
    const v = localStorage.getItem(PAY_ENTITY_STORAGE_KEY);
    if (v === 'Coverall' || v === 'Vix' || v === 'All') return v;
  } catch {}
  return 'Coverall';
}

export function usePayEntityScope(): [PayEntityScope, (s: PayEntityScope) => void] {
  const [scope, setScopeState] = useState<PayEntityScope>(readStoredPayEntity);

  // Listen for changes from other hook instances (same-tab) and other tabs.
  useEffect(() => {
    const onCustom = (e: Event) => {
      const next = (e as CustomEvent<PayEntityScope>).detail;
      if (next === 'Coverall' || next === 'Vix' || next === 'All') setScopeState(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== PAY_ENTITY_STORAGE_KEY) return;
      const v = e.newValue;
      if (v === 'Coverall' || v === 'Vix' || v === 'All') setScopeState(v);
    };
    window.addEventListener(SCOPE_CHANGE_EVENT, onCustom as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SCOPE_CHANGE_EVENT, onCustom as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setScope = useCallback((next: PayEntityScope) => {
    setScopeState(next);
    try { localStorage.setItem(PAY_ENTITY_STORAGE_KEY, next); } catch {}
    try {
      window.dispatchEvent(new CustomEvent<PayEntityScope>(SCOPE_CHANGE_EVENT, { detail: next }));
    } catch {}
  }, []);

  return [scope, setScope];
}
