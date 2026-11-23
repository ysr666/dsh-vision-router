# Doctor retirement (Draft proposal; implementation deliberately deferred)

Status: **Proposal only**. This branch intentionally does not change the CLI, package entrypoint, tests, storage repair, or release artifacts.

## Goal

Retire the legacy `dsh-vision-router doctor` health/reporting surface without silently breaking supported installation, profile repair, or offline Session recovery.

## Out of scope for now

- No updates to Issue #865 runtime cache fixes, Usage analysis, image projection, replay, or permissions.
- No attempted repair of Doctor's existing downgrade-preflight (that experimental code is stacked on a separate unmerged Draft).
- No merge, Ready-for-review, version change, tag, npm/GitHub Release, or native package upload.

## Future implementation checklist (requires separate review)

1. Inventory CLI users and dependencies on `package.json` `bin`, `doctor`, `repair`, and `repair-sessions`; preserve necessary rescue functions or migrate to a separately documented repair entry.
2. Decide the final behavior for the public `doctor` command: a documented unsupported-command error or removal, while keeping the installer usable; avoid a silent exit-0.
3. Remove unused runtime diagnostic modules and tests only after proving no import or bundling dependencies remain.
4. Update README, Chinese README, install/update guidance, package contents and affected contract tests.
5. Run exact supported Host/Node/platform/installer checks and an explicit downgrade/recovery exercise.
6. Only merge if the owner separately authorizes the retirement after migration impact review.

**Safety rule:** existing Sessions are not rewritten/deleted by Doctor retirement. This is intentionally a parked Draft, not an implementation claim.
