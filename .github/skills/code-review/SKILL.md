---
name: code-review
description: Adversarial pull-request review for dsh-vision-router. Use for code review, security review, regression review, and compatibility review.
---

# Adversarial review workflow

Read the diff together with the nearest callers, persistence boundaries, lifecycle hooks, and existing tests. Do not review changed lines in isolation.

For each changed behavior, try at least one hostile counterexample from each relevant class:
1. malformed or oversized input;
2. duplicate/reordered lifecycle events;
3. cancellation or timeout during an awaited Host/provider operation;
4. restart/cold-resume with persisted state;
5. credential rotation or missing credential;
6. concurrent sessions/contexts sharing the same model or attachment;
7. Windows/macOS/Linux or Node 22/24 differences;
8. stable DSH versus exact preview verification boundaries.

Check whether errors fail closed, resources stay bounded, stale work cannot publish, secrets never become durable identifiers, and native Host ownership remains authoritative where intended.

Rank findings P0/P1/P2/P3. For each finding provide: exact trigger, actual behavior, expected behavior, impact scope, root cause, minimal fix direction, and the regression test that should fail before the fix.

If a claimed issue cannot be demonstrated from code, tests, or a concrete counterexample, do not report it as a vulnerability.
