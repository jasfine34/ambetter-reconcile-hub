/**
 * Canonical helpers — the single source of truth for scope filtering and
 * metric computation. See ARCHITECTURE_PLAN.md § Canonical Definitions.
 *
 * Pages MUST import metrics through this barrel rather than re-deriving
 * them from raw reconciled / normalized data.
 */
export * from './scope';
export * from './metrics';
export * from './invariants';
