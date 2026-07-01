# Anki Migration Runtime Probes

Generated: 2026-07-01T17:26:13.227Z

Run id: `__codex_anki_probe__-mr2cke12`

Overall: **PASS**

## P1 - Cloze Materialization

Status: **PASS**

- Single cloze card count: 1
- Single card types: `[{"clozeId":"13656969954166376"}]`
- Multi-cloze card count: 2
- Multi card types: `[{"clozeId":"6204807631638424"},{"clozeId":"9650274707715361"}]`
- Grouping observation: multiple cloze spans materialized as multiple cards

## P2 - HTML Fidelity

Status: **PASS**

- Descendant count after `parseAndInsertHtml`: 2
- Readback sample: `[{"id":"oTFhncqvZwSIZb114","text":"","html":"","markdown":""},{"id":"PeynAtgUEvR1ILf5O","text":"one","html":"one","markdown":"one"},{"id":"fkIxjZcMoV5ktHhEv","text":"two","html":"two","markdown":"two"}]`

## P3 - Media Reachability

Status: **PASS**

- Data URI URLs retained: `[]`
- Daemon URL: http://127.0.0.1:8766/media/<sha256>.png
- Daemon URLs retained: `[]`
- Caveat: SDK probe verifies rich-text serialization and URL retention, not visual rendering in every RemNote surface.

## P4 - Deck As Document

Status: **PASS**

- Document id: `iNT7jwusWZHjvIgDS`
- isDocument: true
- Card count inside document: 1

## Cleanup

- Mode: soft-delete
- Tombstone opId: `__codex_anki_probe__-mr2cke12-tombstone`

No hard delete was performed by this probe.
