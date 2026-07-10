import { randomBytes, timingSafeEqual } from "node:crypto";

const PAIRING_TTL_MS = 2 * 60_000;

type PairingCode = { code: string; expiresAt: number };

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class PairingStore {
  private readonly codes = new Map<string, PairingCode>();

  create(): PairingCode {
    this.prune();
    const code = `pair-${randomBytes(16).toString("hex")}`;
    const pairing = { code, expiresAt: Date.now() + PAIRING_TTL_MS };
    this.codes.set(code, pairing);
    return pairing;
  }

  consume(candidate: string): boolean {
    this.prune();
    for (const [key, pairing] of this.codes) {
      if (!equal(pairing.code, candidate)) continue;
      this.codes.delete(key);
      return pairing.expiresAt > Date.now();
    }
    return false;
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, pairing] of this.codes) if (pairing.expiresAt <= now) this.codes.delete(code);
  }
}
