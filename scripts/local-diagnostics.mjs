const DEFAULT_PLUGIN_ID = "remnoteconnect-local-dev";

function versionString(version) {
  if (!version || typeof version !== "object") return undefined;
  const { major, minor, patch } = version;
  if (![major, minor, patch].every(Number.isInteger)) return undefined;
  return `${major}.${minor}.${patch}`;
}

async function readManifest(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    const manifest = await response.json();
    return {
      ok: true,
      status: response.status,
      id: typeof manifest?.id === "string" ? manifest.id : undefined,
      name: typeof manifest?.name === "string" ? manifest.name : undefined,
      version: versionString(manifest?.version),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function probePluginBundle({
  pluginPort = Number(process.env.REMNOTE_CONNECT_PLUGIN_PORT ?? 8081),
  expectedId = DEFAULT_PLUGIN_ID,
  expectedVersion,
  fetchImpl = fetch,
} = {}) {
  const url = `http://127.0.0.1:${pluginPort}/manifest.json`;
  const localhostUrl = `http://localhost:${pluginPort}/manifest.json`;
  const [exact, localhost] = await Promise.all([
    readManifest(fetchImpl, url),
    readManifest(fetchImpl, localhostUrl),
  ]);
  const exactIdentityMatches =
    exact.ok &&
    exact.id === expectedId &&
    (expectedVersion === undefined || exact.version === expectedVersion);
  const sameBundle =
    localhost.ok &&
    exact.ok &&
    localhost.id === exact.id &&
    localhost.version === exact.version;
  const warnings = [];
  if (!sameBundle) {
    warnings.push(`localhost:${pluginPort} does not serve the same plugin bundle as 127.0.0.1:${pluginPort}.`);
  }
  let error;
  if (!exact.ok) {
    error = `Unable to read ${url}: ${exact.error ?? "unknown error"}`;
  } else if (!exactIdentityMatches) {
    error = `Expected ${expectedId}${expectedVersion ? ` v${expectedVersion}` : ""}, received ${exact.id ?? "unknown"}${exact.version ? ` v${exact.version}` : ""}.`;
  } else if (!sameBundle) {
    error = `RemNote development mode requires http://localhost:${pluginPort}, but that origin does not serve the expected local bundle.`;
  }
  return {
    ok: Boolean(exactIdentityMatches && sameBundle),
    url,
    expectedId,
    expectedVersion,
    id: exact.id,
    name: exact.name,
    version: exact.version,
    status: exact.status,
    error,
    localhost: {
      url: localhostUrl,
      status: localhost.status,
      id: localhost.id,
      version: localhost.version,
      sameBundle,
      error: localhost.error,
    },
    warnings,
  };
}
