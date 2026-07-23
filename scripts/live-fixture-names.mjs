export function disposableTag(prefix, runId) {
  if (!/^rnc-[a-z0-9-]+$/.test(prefix) || !/^__rnc_[a-z0-9_]+__-[a-z0-9]+$/.test(runId)) {
    throw new Error("Live fixture tags require a disposable RemNoteConnect run ID.");
  }
  return `${prefix}-${runId}`;
}
