# 3D Websites Hackathon

> A polished gallery of static multi-view anamorphic sculptures that resolve into different silhouettes by viewpoint.

> **Production intent:** this repository is for the complete, reliable system described below. It is not an MVP, disposable demo, or thin hackathon facade. No product name has been assigned; the hackathon title remains the repository heading until the user chooses one.

## Repository status

Implementation is underway at Tier 0. The repository now contains an exact Node/pnpm toolchain contract, a Vite/React calibration surface with a WebGL2-gated semantic fallback, immutable calibration geometry and view stations, ownership-checked local services, and unit, property, integration, and browser verification surfaces. This is foundation evidence, not production: no production deployment has occurred, no release gate below is complete, and the three authored hero scenes, solver, quality governor, lighting/audio, and full device/accessibility matrix remain outstanding.

| Document | Authority |
|---|---|
| [HACKATHON.md](./HACKATHON.md) | Eligibility, mandatory submission fields, judging criteria, deadlines, links |
| [WINNING_IDEA.md](./WINNING_IDEA.md) | Selected concept, hard technical core, validation, build order, demo and risk analysis |
| [README.md](./README.md) | Product contract, architecture, production and release expectations |
| [AGENTS.md](./AGENTS.md) | Binding implementation rules for every coding agent working in this repository |
| [GOAL.md](./GOAL.md) | Standing execution order, production milestone, and evidence contract |

If these documents disagree, preserve the external requirements in HACKATHON.md, then the product intent in WINNING_IDEA.md, and resolve the conflict explicitly in an ADR instead of guessing.

## Product contract

Ship a memorable, production-quality immersive site where static authored geometry produces distinct, regression-tested silhouettes from marked viewpoints, remains beautiful between them, performs across supported devices, and provides equivalent navigation and meaning for reduced-motion and non-canvas users.

### Intended users

- Visitors exploring a short visual art experience
- Touch, keyboard, reduced-motion, and low-power users
- Artists experimenting with bounded three-view silhouette generation

### Canonical workflow

1. Load a curated sculpture within a strict first-reveal budget
2. Navigate along a camera rail or direct viewpoint controls
3. Resolve three different silhouettes without moving geometry
4. Manipulate light and move through the off-axis sculpture
5. Optionally draw bounded masks and generate an honestly scored approximate sculpture
6. Share a viewpoint and access a semantic 2D interpretation

### Explicit non-goals

- A 3D portfolio room or product showroom
- A generic WebGL engine/editor
- Morphing geometry between viewpoints
- Accounts, social feed, or cloud gallery
- VR requirement or photorealistic character pipeline
- Generator work that reduces curated-scene polish

A non-goal may become part of the product only after the core release gates pass and an ADR explains why the additional surface does not weaken correctness, safety, usability, or schedule.

## Production architecture

Static CDN deployment with immutable assets, compressed scene payloads, WebGL2 fallback, capability detection, and graceful semantic fallback rather than a blank canvas.

### Component boundaries

| Area | Production responsibility | Current implementation |
|---|---|---|
| `src/scenes` | Curated masks, solved geometry, camera stations, art direction | Deterministic calibration-scene state only; authored hero scenes remain outstanding |
| `src/solver` | Back-projection, soft occupancy, optimization, sparsification | Not created; generator work remains gated behind curated-scene polish |
| `src/sculpture` | Instancing, fragment placement, materials, LOD | Immutable deterministic calibration geometry only |
| `src/camera` | Rail, snap assistance, framing, URL state | Immutable calibration view stations only |
| `src/gallery` | React and React Three Fiber application composition | Calibration canvas, viewpoint controls, capability routing, and semantic fallback composition |
| `src/lighting-audio` | Interactive light, projection-error sound, lifecycle | Not created |
| `src/quality` | Capability, dynamic resolution, thermal/frame budget | Not created |
| `src/accessibility` | HTML semantic mirror, 2D gallery, reduced motion, controls | Semantic meaning contract for the calibration slice; full gallery equivalent remains outstanding |

Dependencies should flow from applications/adapters toward typed domain packages. Domain logic must remain testable without UI, network, cloud credentials, or third-party services. Infrastructure code may assemble components but must not become the only place where product invariants are enforced.

### Target technology foundation

- TypeScript, Vite, React
- Three.js/React Three Fiber with custom GLSL/WGSL
- Web Workers and optional WebGPU compute for occupancy optimization
- Instanced geometry and adaptive quality governor
- Web Audio
- Playwright and fixed-camera screenshot/projection regression

Technology choices are constraints, not decorations. A dependency is accepted only when its operational behavior, license, failure modes, supply-chain risk, and replacement boundary are understood.

## Non-negotiable invariants

1. Curated sculpture geometry is static across viewpoints
2. Each authored view passes a target projection threshold at supported aspect ratios
3. An outline cannot be required to recognize a hero silhouette
4. Off-axis composition remains intentional and performant
5. Generator error is reported per view and never hidden
6. Capability loss degrades effects before silhouette-defining geometry
7. All canvas meaning has a semantic and reduced-motion equivalent

Any change that can violate an invariant requires a written design review, tests demonstrating preservation under failure, and an explicit update to this README and AGENTS.md.

## Security, privacy, and safety

- No arbitrary public uploads in the initial release
- Bundle only licensed/original assets and audio
- Respect reduced motion and explicit audio consent
- Avoid GPU lockups with bounded jobs, cancellation, and quality limits

Common controls required across the system:

- secrets come from an approved secret store or local ignored environment file and are never committed, rendered, or logged;
- untrusted files, prompts, provider output, repository content, and external responses are treated as data, never instructions;
- authorization is enforced at the data/action boundary, not only in the UI;
- logs, traces, fixtures, screenshots, and demo assets are scrubbed of credentials and sensitive user data;
- destructive or externally visible actions are previewable, idempotent where possible, auditable, and fail closed;
- dependency and container scanning, lockfiles, least privilege, and an incident/rollback path are release requirements.

## Reliability and operations

Production behavior includes failures, retries, restarts, partial responses, stale data, duplicate delivery, and resource exhaustion. The implementation must therefore provide:

- typed error classes and user-visible failure states rather than catch-all success fallbacks;
- bounded timeouts, cancellation, retry budgets, and backoff for every external or long-running operation;
- idempotency and reconciliation wherever the same work may be delivered twice or its external outcome may be unknown;
- structured, redacted logs; metrics for throughput, latency, error and abstention/refusal; and traces across meaningful boundaries;
- health/readiness checks that validate dependencies without mutating user data;
- documented SLOs and alerts before public production use;
- backup, restore, migration, retention, and cleanup procedures for every persistent store;
- graceful degradation that preserves truth and safety before convenience or visual effects.

## Verification strategy

Project-specific required test surfaces:

- Fixed-camera projection IoU/screenshot regression
- Responsive framing across viewport/aspect ratios
- Frame-time, memory, load, and quality scaling
- Worker cancellation and incompatible-mask behavior
- WebGPU/WebGL2/mobile fallback
- Keyboard, touch, screen-reader mirror, reduced motion, mute

Every production path also needs unit tests, property or fuzz tests where state space matters, integration tests at real boundaries, end-to-end tests of the user outcome, accessibility checks, performance budgets, security regression tests, and failure-injection coverage. Mocks belong in test fixtures; the shipped runtime must not depend on a fake service or hardcoded winning example.

Evaluation datasets and fixtures are versioned, provenance-aware, and isolated from tuning when described as held out. A number may appear in the README or submission only when a committed script regenerates it from a committed manifest.

## Performance and accessibility

Performance budgets must be set before optimization and enforced in CI for supported environments. Measure latency distributions, memory, CPU/GPU, network or storage volume, cold start, cancellation, and degraded-device behavior relevant to this product. Do not replace measurements with “feels fast.”

Accessibility is a release gate, not a polish task. The production interface must include semantic structure, keyboard support, visible focus, sufficient contrast, non-color status cues, reduced-motion behavior where relevant, zoom/reflow, readable errors, and an equivalent representation for information conveyed through canvas, charts, audio, maps, camera, or animation.

## Repository layout

Current non-generated source and verification layout:

```text
/
├── .github/workflows/ci.yml  # Clean-checkout verification
├── AGENTS.md                 # Binding implementation rules for coding agents
├── GOAL.md                   # Standing execution and production contract
├── HACKATHON.md              # External rules and submission facts
├── README.md                 # Product and operating contract
├── WINNING_IDEA.md           # Selected product/technical blueprint
├── Makefile                  # Stable contributor command surface
├── package.json              # Exact scripts and dependencies
├── pnpm-lock.yaml            # Locked dependency graph
├── pnpm-workspace.yaml       # Install and supply-chain policy
├── ports.env                 # Reserved local-service assignments
├── adr/                      # Accepted architecture decisions
├── docs/                     # Dependency and operating documentation
├── evidence/                 # Regenerable, committed Tier 0 evidence
├── scripts/                  # Build, verification, and owned-service lifecycle
├── src/
│   ├── accessibility/
│   ├── camera/
│   ├── gallery/
│   ├── scenes/
│   └── sculpture/
└── tests/
    ├── e2e/
    ├── integration/
    └── property/
```

The planned ownership areas `src/solver`, `src/lighting-audio`, `src/quality`, and `infra` are deliberately absent until they own working code, tests, and documentation. Directory presence is not accepted as progress.

## Development command contract

With the exact Node 24.19.0 and pnpm 11.20.0 versions selected by `.node-version`, `.nvmrc`, and `package.json`, the checked-in Makefile and package scripts expose this current command surface:

| Make target | Equivalent package command | Current behavior |
|---|---|---|
| `make bootstrap` | `pnpm run bootstrap` | Verify exact tool versions, install the frozen lockfile, and install Chromium below ignored `.dev/` state |
| `make check` | `pnpm run check` | Check formatting, lint, TypeScript, domain boundaries, and dead code |
| `make test` | `pnpm run test` | Run the deterministic Vitest unit, property, and integration suites with coverage, starting and cleaning up only owned services |
| `make test-integration` | `pnpm run test:integration` | Run the isolated owned-service contract tests |
| `make test-e2e` | `pnpm run test:e2e` | Run Playwright user, semantic fallback, and reduced-motion paths on the owned projection harness |
| `make eval` | `pnpm run eval` | Regenerate the current Tier 0 dependency register and evidence manifest; it is not a projection-quality evaluation |
| `make build` | `pnpm run build` | Type-check, emit the static artifact, enforce bundle budgets, and generate build integrity and licence evidence |
| `make run-local` | `pnpm run dev:up` | Preflight and start the four owned services on literal `127.0.0.1:4100-4103` |
| `make dev-health` | `pnpm run dev:health` | Prove process ownership and exact readiness for all four services |
| `make dev-down` | `pnpm run dev:down` | Stop only processes whose recorded identity and ownership still match |
| `make release-check` | `pnpm run verify-all` | Run the current Tier 0 preflight, services, checks, tests, build, audit, evidence, browser, final-health, and owned-cleanup sequence |

`pnpm run dev:preflight` is also available as the fail-closed port and ownership check. These commands establish only the current Tier 0 foundation contract; they do not establish production deployment or any of the six product release gates.

A new contributor should be able to move from a clean checkout to a verified local system without tribal knowledge.

## Environment model

- **Local:** isolated developer data, safe fixtures, no real-world side effects by default.
- **Test:** deterministic automated environment with controlled boundary services.
- **Staging:** production-shaped deployment, synthetic/de-identified data, real observability and rollback.
- **Production:** least-privilege credentials, audited configuration, SLOs, incident ownership, backups and change controls.

Configuration is typed, validated at startup, documented, and separated from secrets. Environment-specific branches or code paths are prohibited; behavior changes through validated configuration and capability boundaries.

## Release gates

1. Three curated scenes meet projection and art review
2. First meaningful reveal meets load budget
3. Supported device matrix meets frame/memory targets
4. Generator reports honest error and cannot block main render
5. Accessibility fallback covers all authored meaning
6. No external asset/license uncertainty remains

Common blocking gates also include:

- clean build from a fresh checkout with locked dependencies;
- no critical/high unresolved security findings and no committed secrets;
- migration/rollback and backup/restore rehearsal where state exists;
- passing accessibility and supported-environment matrix;
- complete observability, runbook, known-limitations, privacy, and threat-model documentation;
- no placeholder copy, dead controls, fake metrics, hardcoded demo results, or production TODO paths;
- submission assets and claims generated from the same tested release commit.

## Production milestone policy

Work proceeds in complete vertical slices, but every merged slice must use the final architecture, schemas, security boundaries, telemetry, error model, tests, and documentation expected in production. A smaller completed surface is acceptable; a throwaway implementation that will be replaced later is not.

A feature is not complete when it works once. It is complete when supported inputs, invalid inputs, retries, cancellation, restart, privacy, accessibility, observability, performance, deployment, rollback, and documentation are all accounted for.

## Hackathon delivery

HACKATHON.md contains the live form links and exact requirements. WINNING_IDEA.md contains the selected demo and judging strategy. Production engineering must strengthen that submission, not create a separate demo path. The video, screenshots, hosted build, evaluation numbers, and repository documentation must all describe the same release artifact.

## Contributing

Read AGENTS.md before changing code. Keep changes narrowly scoped, add or update tests with behavior, record architecture/security decisions in ADRs, and never weaken an invariant to make a demo pass. No product name, logo, pricing claim, medical/legal claim, partner claim, or benchmark result should be invented without explicit evidence and user approval.
