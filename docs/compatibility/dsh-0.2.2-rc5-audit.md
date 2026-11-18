# DSH 0.2.2-rc.5 source audit (qualification pending)

- Official [immutable release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5): 2026-11-18 12:51:39 UTC, `9c2670d3bce5275e0d1610272958121af87787bb`.
- DVR baseline: `e278b7ca1f305d27b11cb987c004d0632bf43633`.

The five upstream commits include a liveshare test-clock correction, [web search default selection (#8707)](https://github.com/deepseek-ai/deepseek-harness/pull/8707), and release metadata/merge. The search feature selects native Messages search for native DeepSeek model routes and Search API for other routes when usable and no provider is configured. Explicit selection, readiness, credentials and dispatch remain Host-owned.

DVR default tool-only mode does not alter the text route. Optional whole-turn routing selects an actual visual provider before Host tool admission; reverse routing restores the text route. RC5 does not justify spoofing the selected route or overriding Host search policy. Source inspection identifies no required DVR runtime change or new DVR-owned contract. This is not proof of live credentialed search.

Reuse the existing current exact Host gate, with unchanged jobs and assertions. No search-specific tests, duplicate version-specific test suite, or new execution lane. RC4 historical replay remains available at the baseline commit rather than maintaining a second copy. Keep the protected contract names, minimum and recommended lanes, and Doctor's existing exactVerified evidence until RC5 qualification actually passes. No product version, support range, merge or release changes. Local execution is unavailable; CI evidence is pending.
