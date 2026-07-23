# RemNoteConnect

RemNoteConnect is a local-first bridge for people who want to use terminal tools, scripts, and LLM agents with RemNote.

It provides a small RemNote plugin plus a local daemon. The plugin runs inside RemNote and performs RemNote SDK reads/writes. The daemon runs on your Mac, exposes a token-gated local API, serves the plugin bundle, and provides the CLI used by automation tools.

## What it is for

- Mapping and searching your RemNote graph from a CLI.
- Creating study documents and flashcards from local workflows.
- Running cleanup workflows with dry-runs, exact-count confirmations, soft delete, and undo support.
- Building local learning systems that can read and write RemNote with explicit approval gates.

## Important safety notes

This plugin requests whole-knowledge-base read/create/modify/delete permission. Only install it if you understand that it is designed to control your local RemNote knowledge base through a local daemon.

The daemon binds to `127.0.0.1`, uses local pairing and bearer authentication, persists undo state before reversible writes, and requires an exact plan plus a one-time approval for irreversible operations. Even so, this is powerful local automation software, not a simple visual plugin.

Scheduler mutation and structural merge are disabled in v0.5 until they can be proven reversible.

Do not paste daemon tokens, private notes, Rem exports, or graph maps into public issues.

## Requirements

- RemNote desktop on macOS.
- Node.js 22 or 24 LTS and pnpm.
- The local RemNoteConnect daemon from the public GitHub repo.
- The daemon must be running for the plugin bridge to connect.

The iOS and iPadOS RemNote apps cannot run the local bridge daemon, so mobile is not supported.

## Setup

See the public repository for current setup, CLI, troubleshooting, and safe usage documentation:

https://github.com/lucaschatham/remnoteconnect
