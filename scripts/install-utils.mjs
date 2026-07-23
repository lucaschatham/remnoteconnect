export function nodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version));
  return match ? Number(match[1]) : undefined;
}

export function chooseNodeRuntime(candidates) {
  const supported = candidates
    .map((candidate) => ({ ...candidate, major: nodeMajor(candidate.version) }))
    .filter((candidate) => candidate.major === 22 || candidate.major === 24)
    .sort((left, right) => right.major - left.major);
  if (supported.length === 0) {
    throw new Error("RemNoteConnect requires Node.js 22 or 24 LTS. Set NODE_BIN to a supported Node binary.");
  }
  return supported[0];
}

export function pnpmInvocation({ explicit, pnpmPath, npxPath }) {
  if (explicit) return { command: explicit, prefix: [] };
  if (pnpmPath) return { command: pnpmPath, prefix: [] };
  if (npxPath) return { command: npxPath, prefix: ["--yes", "pnpm@11.7.0"] };
  throw new Error("pnpm was not found and npx is unavailable. Install pnpm 11.7.0 or set PNPM_BIN.");
}

export function validateBuildPair(daemonBuild, pluginBuild, expectedVersion) {
  if (!daemonBuild || !pluginBuild || daemonBuild.buildHash !== pluginBuild.buildHash || daemonBuild.commit !== pluginBuild.commit) {
    throw new Error("Staged daemon and plugin build identities do not match.");
  }
  if (daemonBuild.clean !== true || pluginBuild.clean !== true) {
    throw new Error("Staged runtime must come from a clean source build.");
  }
  if (daemonBuild.version !== expectedVersion || pluginBuild.version !== expectedVersion) {
    throw new Error(`Staged runtime version does not match package version ${expectedVersion}.`);
  }
  if (!/^v\d+\.\d+\.\d+\+git\.[a-f0-9]{12}$/i.test(daemonBuild.buildHash)) {
    throw new Error(`Staged build hash is not Git-derived: ${daemonBuild.buildHash ?? "missing"}.`);
  }
  return daemonBuild;
}
