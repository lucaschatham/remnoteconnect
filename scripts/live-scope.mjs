#!/usr/bin/env node
import { assert, call, requireBridge } from "./live-helpers.mjs";

try {
  await requireBridge();
  const doctor = await call("doctor");
  assert(doctor.ok === true, `doctor failed: ${JSON.stringify(doctor.checks?.scopeProbe ?? doctor)}`);
  assert(doctor.checks.scopeProbe.ok === true, "scopeProbe did not confirm All-scope graph access.");
  console.log(JSON.stringify({ status: "PASS", scopeProbe: doctor.checks.scopeProbe }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "FAIL", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
