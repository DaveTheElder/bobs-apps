# Bob's Apps — code conventions

Not a legal doc. These are the rules this repo actually runs on; match them in
every file you touch, and when a rule is new here, it was already the house
style before it was written down.

## 1. File header — every source file

First thing in the file (after shebang) states what the file is FOR, its
contract with the outside world, and anything surprising about it. One to four
lines for small files; more only if there are real invariants to warn about.

```js
// src/db.js — single source for DB connection, paths, and schema init.
// Every route module takes this object as a parameter (dependency injection),
// so tests can point DOCS_DIR/DB_PATH at temp dirs via env before requiring it.
```

Python uses a module docstring instead of `#` lines; same content rules.

## 2. Comments explain WHY, never re-read the code

Good: constraints, tradeoffs, bug history, upstream provenance, "this looks
wrong on purpose because X". Bad: `// increment i`. If a name needs a comment
to make sense, fix the name.

## 3. Lengthy files carry a current TABLE OF CONTENTS

Any file over ~250 lines gets (or already has) a header block with:

- **FILE SUMMARY** — what the module does, key capabilities, architecture in
  numbered steps, dependencies and coordinate/time conventions if relevant.
- **TABLE OF CONTENTS** — one entry per `── §N:` section marker with its line
  range.

The TOC is part of the code. If you add, remove, or move a section, update the
TOC in the same commit — an anchor that points at the wrong lines is worse than
no anchor. The inline `── §N: Title ───` markers are the source of truth; the
header TOC is generated from them (grep `── §` and compare).

## 4. Keep files short; split before they bloat

~250 lines is a smell, ~600 is a problem. Route groups, UI components, and
tooling scripts each get their own module — the src/routes/ and frontend/src/apps/
splits exist for this reason. When you add a feature to a 900-line file, the
expected diff is "new module + wiring", not "+200 lines here".

## 5. Section markers inside big files

Files with several distinct jobs separate them visibly:

```js
// ── §6: Aspect Analysis ──────────────────────────────────────
```

Number sections once; don't renumber on every edit (append new ones).

## 6. Shared helpers get a docblock

Exported functions and anything non-obvious gets JSDoc (`@param`/`@returns`,
plus failure behavior) or a Python docstring with the same coverage. Private
one-liners don't need ceremony.
