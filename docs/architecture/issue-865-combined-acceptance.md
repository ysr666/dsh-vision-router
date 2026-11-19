# Issue #865 combined acceptance candidate

This disposable test branch combines the exact reviewed source contributions of
B native control, C transparent twin delegation, and D history-stability opt-in.
It does not merge any PR, change main, change a formal version, publish npm or
create a release. Separate PRs remain the owners of their changes.

- Base main: fdba08e062923ab0c230bce71f9d0a16254c8705
- B (#872): 2ae8cc60ac0bfdbc6ad6afbfc52c6530aabccea0
- C (#868, includes #867): 2ec419c4632cffe91d20b99fac9cbc8514ecb47d
- D (#871, includes #870): ad63018dbb171d8d835cbc82b00fa6ad3eae77a0

Overlapping files use verified base-coordinate nonoverlapping edits, with the
workflow checks and explicit npm test list combined rather than overwritten.
All individual real Host tests must run together on this candidate. In
particular, keep OFF admission denial, native image passthrough, durable
original attachment, replay provenance, provider usage, and opt-in history
projection semantics. Stable image history remains OFF by default.

This is a combined regression candidate, not an approval to ship and not
evidence of live provider cache-hit rate or billing.
