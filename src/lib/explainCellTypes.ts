/**
 * Source-to-Screen Lineage — Stage 1 trace infrastructure.
 *
 * Types + TraceContext for per-cell classifier instrumentation. The trace
 * mechanism is opt-in: when classifyCell receives `trace === undefined`,
 * every recordX call is a no-op (optional chaining). Default off — no perf
 * impact on production rendering.
 */
import type { ClassificationState, ReversalEvidence } from './classifier';
import type { MonthKey } from './dateRange';
import type { NormalizedRecord } from './normalize';

export type HelperCheckpoint = {
  name: string;
  output: unknown;
  notes?: string;
};

export type GuardCheckpoint = {
  name: string;
  condition: string;
  values: Record<string, unknown>;
  result: boolean;
};

export type FiringRuleCheckpoint = {
  name: string;
  reason: string;
};

export type CellTrace = {
  member: {
    memberKey: string;
    policyNumber: string;
    name: string;
  };
  cell: {
    month: MonthKey;
    scope: string;
  };
  final: {
    state: ClassificationState;
    reason?: string;
    chips: {
      in_ede: boolean;
      in_back_office: boolean;
      in_commission: boolean;
      paid_amount: number;
    };
    badges: {
      carrier_recognition?: boolean;
      reversal_evidence?: ReversalEvidence;
    };
  };
  helpers: HelperCheckpoint[];
  guards: GuardCheckpoint[];
  firingRule: FiringRuleCheckpoint | null;
  scopedRows: NormalizedRecord[];
};

export class TraceContext {
  helpers: HelperCheckpoint[] = [];
  guards: GuardCheckpoint[] = [];
  firingRule: FiringRuleCheckpoint | null = null;

  recordHelper(name: string, output: unknown, notes?: string): void {
    this.helpers.push({ name, output, notes });
  }

  recordGuard(
    name: string,
    condition: string,
    values: Record<string, unknown>,
    result: boolean,
  ): void {
    this.guards.push({ name, condition, values, result });
  }

  /** First writer wins — the first rule to fire is the firing rule. */
  recordFiringRule(name: string, reason: string): void {
    if (this.firingRule) return;
    this.firingRule = { name, reason };
  }
}
