# Progress journal

This journal is append-only. Each entry records what was actually run and what the resulting evidence proves.

## 2026-08-09 — Tier 0 executable contract and first semantic calibration slice (in progress)

### Behaviour delivered

- Anchored the repository to exact Node 24.19.0 and pnpm 11.20.0 toolchains, an exact lockfile, strict TypeScript projects, zero-warning lint/format rules, dependency-boundary checks, and local-only caches.
- Implemented the §0A lifecycle contract for four direct, repository-owned services on literal `127.0.0.1:4100-4103`. Preflight audits every port in `4100-4109`; health validates PID, process fingerprint, bound address, run ID, readiness schema, and served content; down signals only a revalidated ownership record.
- Added a real React/Vite calibration surface with one immutable geometry reference, three camera stations, an explicit unqualified status, keyboard-operable controls, a semantic HTML equivalent, reduced-motion direct cuts, and a no-WebGL semantic fallback.
- Added deterministic unit/property coverage, lifecycle integration tests, Playwright accessibility/fallback tests, reproducible build/dependency evidence, an ADR, dependency register, support matrix, assumptions journal, and external-blocker journal.

### Commands run and observed results

- `npm run dev:preflight`, `npm run dev:up`, and `npm run dev:health` initially failed because no local package or scripts existed. This established the first §10.1 failure rather than a passing baseline.
- Using the repository-local pinned runtime, `pnpm run bootstrap` completed with the frozen lockfile and installed the pinned Chromium under `.dev/cache/ms-playwright`.
- `pnpm run dev:preflight && pnpm run dev:up && pnpm run dev:health` passed. The latest explicit health check reported all four services ready at `4100`, `4101`, `4102`, and `4103`; `lsof` showed each listener bound only to `127.0.0.1` and its recorded PID.
- `pnpm exec vitest run src tests/property --coverage` passed 19 tests across five files and reported 100% statements, branches, functions, and lines for the selected Tier 0 domain/configuration modules.
- `pnpm run test:integration` passed two real lifecycle tests: exact owned listeners and a foreign listener on reserved port `4104` that caused fail-closed preflight while surviving unchanged.
- `pnpm run build` produced content-hashed JavaScript and font assets, a Vite manifest, and `third-party-licenses.json` with source maps disabled. `evidence/tier0/build-budget.json` recorded 390,611 compressed bytes against the initial 6 MiB payload ceiling.
- `pnpm run test:e2e` exercised the real browser surface but did **not** pass: it correctly rejected an upstream `THREE.Clock` deprecation warning and Chromium OpenGL `ReadPixels` diagnostics. No passing E2E or full-verify claim is made by this entry. Isolated browser probes identified an exact compatible Three.js version and the macOS ANGLE Metal backend as fixes; verification is still pending.
- A later strict typecheck exposed two dataset properties that violated `noPropertyAccessFromIndexSignature`; the properties were corrected to bracket access. A fresh complete static gate remains pending after the dependency/configuration correction.

### Evidence emitted

- `evidence/tier0/manifest.json`
- `evidence/tier0/dependency-register.json`
- `evidence/tier0/build-budget.json`
- `.dev/reports/coverage/`
- `.dev/reports/playwright-results/` (retained failing diagnostic evidence)
- `.dev/logs/` and `.dev/pids/` (ignored runtime ownership evidence)

### What is now true

The repository can start and identify its own four local services without adopting or killing foreign processes, and it serves a truthful semantic calibration experience rather than an empty scaffold. It is still **not in production yet**: Tier 0 has not exited until a clean checkout runs the full zero-warning verification contract in CI, and release gates G1-G6 remain unqualified.

### Risks, migration, and rollback

- The foreign-port remap language conflicts with the all-ten-port fail rule; the stricter fail-closed interpretation and later verification path are recorded in `ASSUMPTIONS.md` and ADR-0001.
- Browser dependency compatibility is being corrected by exact version selection, not warning suppression. The rollback is the prior exact package/lock pair, but that pair is known to fail the zero-warning browser gate and therefore is not releasable.
- All runtime artifacts are disposable under ignored `.dev/`. `pnpm run dev:down` removes only verified owned processes; deleting `dist/` and `.dev/` after a verified down rolls back generated local state without touching source or foreign listeners.

### Next item selected by §10.1

Make the browser suite zero-warning without filtering diagnostics, rerun `dev:health`, then run every static, unit/property, integration, build, audit, evidence, and E2E step through `make verify-all`. After local proof, reproduce the same command from a clean committed checkout in CI.
