import { randomBytes, timingSafeEqual } from "node:crypto";

const APPROVAL_TTL_MS = 5 * 60_000;
const CHALLENGE_TTL_MS = 2 * 60_000;
const WORDS = [
  "amber",
  "cedar",
  "delta",
  "ember",
  "frost",
  "harbor",
  "ivory",
  "lumen",
  "maple",
  "orbit",
  "quartz",
  "river",
  "solar",
  "tundra",
  "velvet",
  "willow",
];

export type IrreversibleBinding = {
  action: string;
  fromDryRun: string;
  confirmCount: number;
};

type Challenge = IrreversibleBinding & {
  challengeId: string;
  phrase: string;
  expiresAt: number;
};

type Approval = IrreversibleBinding & {
  approvalNonce: string;
  expiresAt: number;
};

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function phrase(): string {
  const bytes = randomBytes(4);
  return [...bytes].map((value) => WORDS[value % WORDS.length]).join("-");
}

export class IrreversibleApprovalStore {
  private readonly challenges = new Map<string, Challenge>();
  private readonly approvals = new Map<string, Approval>();

  createChallenge(binding: IrreversibleBinding): Omit<Challenge, "action" | "fromDryRun" | "confirmCount"> {
    this.prune();
    const challenge: Challenge = {
      ...binding,
      challengeId: randomBytes(24).toString("hex"),
      phrase: phrase(),
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    };
    this.challenges.set(challenge.challengeId, challenge);
    return { challengeId: challenge.challengeId, phrase: challenge.phrase, expiresAt: challenge.expiresAt };
  }

  approve(binding: IrreversibleBinding, challengeId: string, response: string): { approvalNonce: string; expiresAt: number } | undefined {
    this.prune();
    const challenge = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!challenge || challenge.expiresAt <= Date.now()) return undefined;
    if (
      challenge.action !== binding.action ||
      challenge.fromDryRun !== binding.fromDryRun ||
      challenge.confirmCount !== binding.confirmCount ||
      !equalSecret(challenge.phrase, response)
    ) {
      return undefined;
    }
    const approval: Approval = {
      ...binding,
      approvalNonce: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    };
    this.approvals.set(approval.approvalNonce, approval);
    return { approvalNonce: approval.approvalNonce, expiresAt: approval.expiresAt };
  }

  consume(binding: IrreversibleBinding, approvalNonce: string): boolean {
    this.prune();
    const approval = this.approvals.get(approvalNonce);
    this.approvals.delete(approvalNonce);
    return Boolean(
      approval &&
        approval.expiresAt > Date.now() &&
        approval.action === binding.action &&
        approval.fromDryRun === binding.fromDryRun &&
        approval.confirmCount === binding.confirmCount,
    );
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= now) this.challenges.delete(id);
    for (const [nonce, approval] of this.approvals) if (approval.expiresAt <= now) this.approvals.delete(nonce);
  }
}
