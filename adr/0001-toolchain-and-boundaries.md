# ADR-0001: Toolchain, application composition, and repository isolation

- **Status:** accepted
- **Date:** 2026-08-09

## Context

The gallery needs a static CDN artifact, deterministic geometric domain code, React/Three composition, browser tests, and four concurrent local verification services without colliding with fifteen sibling repositories. The repository started with specifications only.

## Options considered

1. Framework-hosted full stack application. Rejected: no persistent server is required for the declared product and it adds operational state.
2. Direct Three.js with bespoke DOM orchestration. Rejected: it gives tighter rendering control but increases accessibility/application integration work without improving the current static deployment boundary.
3. Vite, React, React Three Fiber, typed domain modules, and native Node lifecycle scripts. Selected.

## Decision

- Pin Node 24.19.0 LTS, pnpm 11.20.0, TypeScript 6.0.3, Vite 8.2.1, React 19.2.8, Three 0.182.0, and React Three Fiber 9.7.0. Three 0.182.0 is the newest release before the r183 `Clock` deprecation: React Three Fiber 9.7.0 still constructs and exposes the legacy `Clock` API, while its declared Three peer range is `>=0.156`. This exact compatible runtime pair avoids a browser warning without suppressing diagnostics or adopting the unstable React Three Fiber 10 alpha. Use the nearest TypeScript 6-compatible definitions, `@types/three` 0.184.0: the 0.182 and 0.183 definitions import duplicate WebGPU globals, while 0.184 is the first release to rely on TypeScript's native DOM declarations.
- Use `src/gallery` only as the application composition layer. Domain packages under `src/scenes`, `src/solver`, `src/sculpture`, `src/camera`, and `src/quality` cannot import React, React Three Fiber, gallery code, or accessibility UI.
- Bind four direct Node/Vite processes to literal `127.0.0.1` ports 4100-4103. Ownership requires PID, start fingerprint, cwd, exact argv marker, bound address, UUID, and readiness UUID. Lifecycle tasks never kill by discovery.
- Resolve the conflicting GOAL.md §0A remap and whole-block exclusivity clauses fail closed: preflight inspects every port from 4100 through 4109 and aborts on any listener whose exact repository ownership cannot be proved. It never signals that process or silently remaps around it. Remapping remains unavailable unless a later contract change preserves whole-block exclusivity or explicitly replaces it.
- Keep local runtime state, browser binaries, reports, PIDs, logs, caches, and profiles below git-ignored `.dev/`.
- Emit static content-hashed assets with a build manifest and bundled third-party licence output. Source maps remain disabled until a private upload-and-delete path exists.
- Bind each static build to a canonical SHA-256 digest of its source, toolchain, and configuration inputs; exact Node 24.19.0 and pnpm 11.20.0; and the platform-neutral `browser`/`es2022` target. The production `VITE_BUILD_REF` is the first 40 hexadecimal characters of that input digest, not an ambient Git or CI value. Arbitrary overrides fail closed.
- Write the actual builder OS, CPU architecture, Git `HEAD`, and dirty flag only to git-ignored `.dev/reports/build-attestation.json`. These facts are useful run provenance but cannot be inputs to canonical tracked evidence: host identity would make macOS and Linux regenerate different evidence, while embedding `HEAD` in an artifact committed by that same `HEAD` creates an unsatisfiable self-reference. The attestation therefore does not claim byte-for-byte cross-host reproducibility; that requires a separate clean-build comparison.

## Consequences

The project has a larger verification dependency set than a demo scaffold. In exchange, the production artifact remains static, domains remain testable without UI, and local services can coexist safely. Browser binaries and platform-specific build binaries are development-only. Canonical evidence is reproducible from the same declared inputs without pretending that different native builders have already produced identical bytes. A new persistent store, external service, or top-level ownership area requires another ADR.

## Failure and rollback

If React Three Fiber becomes unsuitable, the gallery composition layer can be replaced with direct Three.js without changing domain contracts. If a lifecycle process cannot prove ownership, it refuses to signal it; manual investigation is safer than collateral termination. Reverting this ADR means reverting its package/config/lifecycle changes together and restoring the previous documentation-only commit.
