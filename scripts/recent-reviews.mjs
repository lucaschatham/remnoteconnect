#!/usr/bin/env node
import { call, requireBridge } from "./live-helpers.mjs";

function numericFlag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number.`);
  }
  return value;
}

function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return undefined;
}

const hours = numericFlag("hours", 24);
const limit = Math.min(Math.floor(numericFlag("limit", 250)), 1000);
const now = Date.now();
const cutoff = now - hours * 60 * 60 * 1000;

await requireBridge();
const result = await call("recentReviews", { since: cutoff, limit });
const recent = (result.items ?? [])
  .map(({ card, rem }) => {
    const lastRepetitionTime = timestamp(card?.lastRepetitionTime);
    if (lastRepetitionTime === undefined) return undefined;
    return {
      remId: rem?.id,
      cardId: card.id,
      path: rem?.path,
      front: rem?.text,
      back: rem?.backText,
      tags: (rem?.tags ?? []).map((tag) => tag.text).filter(Boolean),
      lastReviewedAt: new Date(lastRepetitionTime).toISOString(),
      timesWrongInRow: card.timesWrongInRow,
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.lastReviewedAt.localeCompare(a.lastReviewedAt));

console.log(JSON.stringify({
  status: "ok",
  signal: "RemNote card lastRepetitionTime (answered/reviewed, not merely opened)",
  generatedAt: new Date(now).toISOString(),
  cutoff: new Date(cutoff).toISOString(),
  windowHours: hours,
  source: "RemNoteConnect recentReviews read primitive",
  recentReviews: result.count,
  truncated: result.truncated,
  items: recent,
}, null, 2));
