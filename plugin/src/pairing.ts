export const TOKEN_STORAGE_KEY = "remnoteconnect.daemonToken";

const PAIRING_CODE_PATTERN = /^pair-[a-f0-9]{32}$/i;

export function normalizePairingCode(value: string): string {
  const code = value.trim();
  if (!PAIRING_CODE_PATTERN.test(code)) {
    throw new Error("Paste the short-lived code beginning with pair- that was printed by `node scripts/rnc.mjs pair`.");
  }
  return code;
}

export function storePairingCode(storage: Storage, value: string): string {
  const code = normalizePairingCode(value);
  storage.setItem(TOKEN_STORAGE_KEY, code);
  return code;
}
