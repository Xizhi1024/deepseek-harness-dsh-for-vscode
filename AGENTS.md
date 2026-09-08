# AGENTS.md

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

Project conventions: plain CommonJS, zero npm dependencies, DI factories with injected vscode facade, frozen value objects, fail-closed timeouts; verification via `npm run check:w0` (lint + unit tests + packaging gate + secrets gate).
