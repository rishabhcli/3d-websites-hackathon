# Direct dependency register

The machine-readable register is regenerated offline by `pnpm run evidence:generate` into [`evidence/tier0/dependency-register.json`](../evidence/tier0/dependency-register.json). The generator refuses version ranges, an installed version that differs from `package.json`, a stale package/lockfile review, a licence mismatch, an unreviewed direct dependency, or a runtime dependency without a measured build-cost mapping.

## What each direct dependency records

- **Licence:** the SPDX expression in both the installed manifest and the selected-version manifest from the primary npm registry. They must match.
- **Maintenance observation:** the selected and `latest` publication timestamps, locked-release age on the dated review, dist-tag relationship, deprecation notice, and primary metadata URL. `selected-version-is-latest-dist-tag-at-review` is a publication fact, not a promise of maintainer responsiveness or future support.
- **Security history:** all package-level advisory IDs returned by OSV, exact-selected-version matches returned by OSV, and the resolved-lockfile `pnpm audit` response. A zero count is described only as a dated query result; it is never restated as “no vulnerabilities” or “no security history.”
- **Native/binary implications:** direct manifest executable, lifecycle, OS, CPU, and gyp signals; measured direct binary/font payload counts; and reviewed deployment implications. Vite's transitive platform Rolldown binding and Playwright's test browser are called out explicitly.
- **Cost:** measured installed direct-package bytes. Runtime packages also receive measured emitted artifacts: exact WOFF2 assets for fonts, or a whole shared JavaScript/CSS chunk as a deliberately conservative upper bound. Development-only entries state that no per-package deployed-byte attribution was attempted rather than fabricating a zero.

The dated source snapshot is [`scripts/evidence/dependency-review.snapshot.json`](../scripts/evidence/dependency-review.snapshot.json). It is bound to SHA-256 digests of `package.json` and `pnpm-lock.yaml`; changing either makes evidence generation fail closed until review is refreshed. Generated evidence binds its complete input list with the unambiguous `sha256-path-nul-body-nul-v1` framing (portable relative path, NUL, file bytes, NUL for each sorted input), rather than concatenating file bodies.

## Commands and network boundary

| Command                              |                             Network | Purpose                                                                                                                                                    |
| ------------------------------------ | ----------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run dependency-review:refresh` |                            Required | Query primary npm publication metadata, OSV package/exact-version advisory history, and the primary npm audit endpoint; write a normalized dated snapshot. |
| `pnpm run build`                     | Not required after locked bootstrap | Produce the Vite manifest and byte/gzip measurements consumed by the register.                                                                             |
| `pnpm run evidence:generate`         |                        Not required | Validate the committed snapshot against the package manifest, lockfile, install, and build; regenerate the dependency register and evidence manifest.      |
| `pnpm audit --audit-level high`      |                            Required | Blocking current-resolved-graph advisory gate in `verify-all`; distinct from historical review.                                                            |

The snapshot deliberately stores normalized evidence instead of raw registry documents. Its `reviewedAt`, source URLs, commands, limitations, package/lock digests, publication timestamps, and advisory IDs retain the provenance needed to review or repeat the network observation. Refreshing changes evidence and must be reviewed like a dependency change.

## Supply-chain policy

- Node and pnpm are pinned by `.node-version`, `packageManager`, and `engines`.
- The deployable build context records the exact pinned Node/pnpm pair, platform-neutral browser target, complete build-input digest, and digest-derived build reference. Actual Git and builder-platform facts live in the ignored `.dev/reports/build-attestation.json`; they are intentionally excluded from canonical artifact hashes for the self-reference and cross-platform reasons documented in ADR-0001.
- The lockfile is regenerated only through pnpm's trust, maturity, integrity, exotic-subdependency, peer, and lifecycle-script policies in `pnpm-workspace.yaml`.
- `semver@6.3.1` is the only trust-downgrade exception. It is an exact transitive build-tool dependency; the exception and removal condition are recorded in `ASSUMPTIONS.md`.
- Runtime deployables are static browser assets. Playwright's Chromium is test-only and remains in `.dev/cache/`.
- React Three Fiber 9.7.0 is paired with Three 0.182.0 because the stable renderer still requires the legacy `Clock` API and Three r183+ emits a deprecation warning on construction. The compatibility choice is recorded in ADR-0001 and remains inside Fiber's declared `three >=0.156` peer range. The nearest TypeScript 6-compatible definitions are `@types/three` 0.184.0; earlier definitions import WebGPU globals that now duplicate TypeScript's DOM library.
- `pnpm audit --audit-level high` is blocking in `verify-all`; it is current-advisory evidence, not proof of a package's entire history.
