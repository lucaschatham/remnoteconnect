import { fail, ok, type ApiResponse } from "@remnoteconnect/shared";
import { IrreversibleApprovalStore, type IrreversibleBinding } from "./approvals.js";
import { dryRunHash } from "./dryRun.js";

export const MAGNITUDE_THRESHOLD = 50;
export const IRREVERSIBLE_SESSION_BUDGET = 3;
const DRY_RUN_TTL_MS = 30 * 60_000;
const MAX_DRY_RUNS = 500;

type DryRunPlan = IrreversibleBinding & {
  targetIds: string[];
  warnings: string[];
  createdAt: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function countFromResult(result: unknown): number {
  const count = asRecord(result).count;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

function idsFromResult(result: unknown): string[] {
  const record = asRecord(result);
  return [...new Set([record.remIds, record.ids, record.cardIds, record.targetIds]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((value): value is string => typeof value === "string"))].sort();
}

export class SafetyCoordinator {
  private readonly dryRuns = new Map<string, DryRunPlan>();
  private readonly approvals = new IrreversibleApprovalStore();
  private irreversibleRemaining = IRREVERSIBLE_SESSION_BUDGET;

  recordDryRun(action: string, result: unknown): { hash: string; plan: DryRunPlan } {
    this.prune();
    const hash = dryRunHash(action, result);
    const record = asRecord(result);
    const warning = typeof record.warning === "string" ? [record.warning] : [];
    const plan: DryRunPlan = {
      action,
      fromDryRun: hash,
      confirmCount: countFromResult(result),
      targetIds: idsFromResult(result),
      warnings: warning,
      createdAt: Date.now(),
    };
    this.dryRuns.set(hash, plan);
    while (this.dryRuns.size > MAX_DRY_RUNS) this.dryRuns.delete(this.dryRuns.keys().next().value as string);
    return { hash, plan };
  }

  approve(params: Record<string, unknown>): ApiResponse {
    this.prune();
    const sessionReset = params.sessionReset === true;
    const action = sessionReset ? "reconfirmIrreversibleBudget" : typeof params.action === "string" ? params.action : "";
    const fromDryRun = sessionReset ? "session-budget" : typeof params.fromDryRun === "string" ? params.fromDryRun : "";
    const confirmCount = sessionReset ? IRREVERSIBLE_SESSION_BUDGET : Number(params.confirmCount);
    const plan = sessionReset
      ? { action, fromDryRun, confirmCount, targetIds: [], warnings: ["Resetting the session budget permits three more irreversible operations."], createdAt: Date.now() }
      : this.dryRuns.get(fromDryRun);
    if (!plan || plan.action !== action || plan.confirmCount !== confirmCount) return fail("dry_run_mismatch", "Approval request does not match a retained dry-run plan.");
    const binding = { action, fromDryRun, confirmCount };
    const stage = params.stage === "approve" ? "approve" : "challenge";
    if (stage === "challenge") {
      return ok({
        stage,
        ...this.approvals.createChallenge(binding),
        action,
        fromDryRun,
        confirmCount,
        targetIds: plan.targetIds,
        warnings: plan.warnings,
      });
    }
    const challengeId = typeof params.challengeId === "string" ? params.challengeId : "";
    const response = typeof params.response === "string" ? params.response : "";
    const approval = this.approvals.approve(binding, challengeId, response);
    return approval ? ok({ stage, ...approval, action, fromDryRun, confirmCount }) : fail("approval_invalid", "Approval challenge is invalid, expired, or already used.");
  }

  resetBudget(approvalNonce: string): ApiResponse {
    const binding = {
      action: "reconfirmIrreversibleBudget",
      fromDryRun: "session-budget",
      confirmCount: IRREVERSIBLE_SESSION_BUDGET,
    };
    if (!this.approvals.consume(binding, approvalNonce)) {
      return fail("approval_invalid", "Session reset approval is invalid, expired, already used, or bound to another action.");
    }
    this.irreversibleRemaining = IRREVERSIBLE_SESSION_BUDGET;
    return ok({ irreversibleRemaining: this.irreversibleRemaining, irreversibleSessionBudget: IRREVERSIBLE_SESSION_BUDGET });
  }

  consumeIrreversible(action: string, currentResult: unknown, params: Record<string, unknown>): ApiResponse<{
    hash: string;
    count: number;
    targetIds: string[];
    remaining: number;
  }> {
    this.prune();
    const current = this.recordDryRun(action, currentResult);
    const fromDryRun = typeof params.fromDryRun === "string" ? params.fromDryRun : "";
    const confirmCount = Number(params.confirmCount);
    if (!fromDryRun) return fail("dry_run_required", `${action} requires a prior dry-run hash.`, { fromDryRun: current.hash });
    const retained = this.dryRuns.get(fromDryRun);
    if (!retained || fromDryRun !== current.hash || retained.action !== action) {
      return fail("dry_run_mismatch", `${action} targets changed after the approved dry-run.`, { expected: current.hash });
    }
    if (!Number.isInteger(confirmCount) || confirmCount !== current.plan.confirmCount) {
      return fail("magnitude_guard", `${action} requires confirmCount:${current.plan.confirmCount}.`, {
        count: current.plan.confirmCount,
        targetIds: current.plan.targetIds,
      });
    }
    if (this.irreversibleRemaining <= 0) {
      return fail("irreversible_budget_exceeded", "The irreversible operation session budget is exhausted.");
    }
    const approvalNonce = typeof params.approvalNonce === "string" ? params.approvalNonce : "";
    if (!approvalNonce) return fail("approval_required", `${action} requires a single-use approval nonce.`);
    if (!this.approvals.consume({ action, fromDryRun, confirmCount }, approvalNonce)) {
      return fail("approval_invalid", "Approval nonce is invalid, expired, already used, or bound to a different plan.");
    }
    this.irreversibleRemaining -= 1;
    this.dryRuns.delete(fromDryRun);
    return ok({ hash: current.hash, count: current.plan.confirmCount, targetIds: current.plan.targetIds, remaining: this.irreversibleRemaining });
  }

  magnitudeError(action: string, result: unknown, confirmCount: unknown): ApiResponse | undefined {
    const count = countFromResult(result);
    if (count <= MAGNITUDE_THRESHOLD || Number(confirmCount) === count) return undefined;
    return fail("magnitude_guard", `${action} resolved ${count} targets. Pass confirmCount:${count} to execute.`, {
      count,
      threshold: MAGNITUDE_THRESHOLD,
      targetIds: idsFromResult(result),
    });
  }

  metrics(): { irreversibleRemaining: number; dryRunHashesRetained: number } {
    this.prune();
    return { irreversibleRemaining: this.irreversibleRemaining, dryRunHashesRetained: this.dryRuns.size };
  }

  private prune(): void {
    const cutoff = Date.now() - DRY_RUN_TTL_MS;
    for (const [hash, plan] of this.dryRuns) if (plan.createdAt < cutoff) this.dryRuns.delete(hash);
  }
}
