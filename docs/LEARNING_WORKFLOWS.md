# Learning Workflows With RemNoteConnect

RemNoteConnect is most useful when it becomes a repeatable learning loop:

1. Capture material.
2. Extract ideas.
3. Link concepts.
4. Create flashcards.
5. Review and clean up.

The tool is not meant to let an LLM dump unlimited notes into RemNote. It is meant to help you keep a useful, connected, reviewable knowledge base.

## Principles

- Prefer atomic concepts over long pasted notes.
- Preserve source context so cards and concepts can be traced back.
- Create flashcards only from material worth remembering.
- Link new concepts to existing Rem whenever possible.
- Use dry-runs for cleanup and bulk changes.
- Keep weak, duplicate, empty, and orphaned Rem visible until you decide what to do with them.

## Workflow: Learn A New Topic

Use this when you are starting a new domain such as biology, finance, programming, philosophy, or history.

1. Create a source document from reading notes.

   ```sh
   node scripts/rnc.mjs create-document --md ./chapter-notes.md --parent "Sources" --confirm
   ```

2. Ask an LLM to identify:

   - key terms
   - prerequisite ideas
   - claims worth remembering
   - examples or counterexamples
   - likely connections to things already in your graph

3. Create concept Rem for durable ideas, not every sentence.

4. Create flashcards only after the source notes are clear.

5. Run a map or search before adding more notes.

   ```sh
   node scripts/rnc.mjs map --depth 3
   node scripts/rnc.mjs search 'text:photosynthesis'
   ```

## Workflow: Create Better Flashcards

Good cards are small, unambiguous, and connected to source context.

Default to front/back cards:

```json
{
  "front": "What is spaced repetition optimizing for?",
  "back": "Review timing: it schedules recall just before forgetting is likely.",
  "tags": ["learning", "memory"]
}
```

Use cloze or multi-line cards when they better match the material:

- cloze for formulas, definitions, and missing terms
- multi-line prompts for procedures or compare/contrast questions
- image occlusion for diagrams, anatomy, maps, architecture, or visual systems, once verified in your RemNote setup

Avoid:

- vague prompts
- trivia with no future use
- duplicate cards
- cards that require too much context to answer
- cards generated from unreviewed source notes

## Workflow: Clean Up A Messy Graph

Start read-only:

```sh
node scripts/rnc.mjs readonly on
node scripts/rnc.mjs search 'text:"TODO"'
node scripts/rnc.mjs map --depth 2
```

Then dry-run the cleanup:

```sh
node scripts/rnc.mjs find-duplicates --by text
node scripts/rnc.mjs bulk-delete --query 'text:"edit later"'
```

Only execute after checking exact counts:

```sh
node scripts/rnc.mjs readonly off
node scripts/rnc.mjs bulk-delete --query 'text:"edit later"' --confirm --confirm-count 12
node scripts/rnc.mjs readonly on
```

Soft deletes preserve Rem IDs by moving targets into the RemNoteConnect trash area. Do not empty trash until you are certain references, portals, and reviews are safe to lose.

## Workflow: Research And Writing

Before writing, ask RemNoteConnect for the map around a topic:

```sh
node scripts/rnc.mjs search 'text:"behavior change"'
node scripts/rnc.mjs map --depth 4
```

Use the results to:

- find prior notes you forgot existed
- identify duplicate concepts
- collect source notes
- build an outline
- create follow-up questions

The strongest pattern is to let the LLM read and synthesize, then require explicit approval before it writes or reorganizes.

## Suggested Agent Policy

For an LLM agent using RemNoteConnect:

- Default to read-only.
- Ask before creating many Rem or cards.
- Use dry-runs for cleanup.
- Echo exact counts before bulk writes.
- Prefer edits that improve search, review, or linking.
- Do not mass-rename personal notes without approval.
- Never treat snapshot restore as true undo.

## What To Measure

Track whether the system is improving learning:

- fewer duplicate notes
- fewer empty placeholders
- better recall on high-value cards
- faster writing and research prep
- more useful links between domains
- less time spent manually cleaning imports

The goal is not a large graph. The goal is a graph that helps you think and remember.
