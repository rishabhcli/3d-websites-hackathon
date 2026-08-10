# AGENTS.md

> **Repository:** 3D Websites Hackathon
> **Product-name status:** unassigned; do not invent one.

## Scope

These instructions apply to every file and subdirectory in this repository. They are binding for coding agents, review agents, automation, and human contributors unless the user gives a more specific instruction.

## Read order and authority

Before planning or editing, read in this order:

1. `HACKATHON.md` for external requirements and deadlines.
2. `WINNING_IDEA.md` for the selected concept, technical core, validation, and scope.
3. `README.md` for the production product and operating contract.
4. This file for implementation discipline.
5. `GOAL.md` for the standing goal-mode contract: the parallel-execution and dev-server port block (§0A), what "production has occurred" means here (§5), the Tier 0-13 ladder (§6), the perpetual epoch engine (§7), the ratchet table (§8), and the work-selection algorithm (§10). `GOAL.md` governs *how long* the work runs and *in what order*; this file governs *how* it is built. Neither overrides `HACKATHON.md`.

Do not infer missing requirements from another hackathon repository. If two documents conflict, stop the affected implementation path, identify the exact conflict, and resolve it in an ADR or user instruction. Do not silently choose the easier interpretation.

## Mission

Ship a memorable, production-quality immersive site where static authored geometry produces distinct, regression-tested silhouettes from marked viewpoints, remains beautiful between them, performs across supported devices, and provides equivalent navigation and meaning for reduced-motion and non-canvas users.

## Production posture: no MVP track

This repository does not permit an MVP, proof-of-concept, demo-only fork, or “make it work now, harden later” path. The target is a deployable, supportable product. Build in small vertical slices when useful, but every merged slice must already honor production boundaries.

The following are not acceptable in shipped code:

- placeholder implementations, no-op handlers, hardcoded success, fake metrics, canned model/provider results, or static hero data presented as live;
- runtime mocks, demo flags that bypass safety/correctness, or separate judging-only behavior;
- unbounded retries, swallowed exceptions, empty catch blocks, silent fallback to a different algorithm/data source, or success after partial failure;
- undocumented environment variables, secrets in source/logs, mutable global configuration, or production behavior selected by branch name;
- TODO/FIXME comments standing in for correctness, security, privacy, accessibility, migration, rollback, or test work;
- broad interfaces with unvalidated dictionaries/`any` values where a domain type or schema is possible;
- adding scope because it is visually impressive while a core invariant or release gate is still failing.

A temporary test double is allowed only inside tests and must model failure as well as success. A spike may exist on an explicitly disposable branch, but none of it is merged until rewritten to the production contract.

## Product boundaries

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

### Out of scope until explicitly approved

- A 3D portfolio room or product showroom
- A generic WebGL engine/editor
- Morphing geometry between viewpoints
- Accounts, social feed, or cloud gallery
- VR requirement or photorealistic character pipeline
- Generator work that reduces curated-scene polish

Do not create a product name, marketing identity, pricing promise, partnership claim, or new target user without explicit user approval. Use descriptive component names only.

## Domain invariants

Every change must preserve these rules:

1. Curated sculpture geometry is static across viewpoints
2. Each authored view passes a target projection threshold at supported aspect ratios
3. An outline cannot be required to recognize a hero silhouette
4. Off-axis composition remains intentional and performant
5. Generator error is reported per view and never hidden
6. Capability loss degrades effects before silhouette-defining geometry
7. All canvas meaning has a semantic and reduced-motion equivalent

Treat invariant violations as defects even when the happy-path demo still works. Encode invariants in types, database constraints, protocol schemas, assertions at trust boundaries, and tests. Do not rely on comments or UI copy alone.

## Architecture and ownership

Static CDN deployment with immutable assets, compressed scene payloads, WebGL2 fallback, capability detection, and graceful semantic fallback rather than a blank canvas.

| Area | Production responsibility |
|---|---|
| `src/scenes` | Curated masks, solved geometry, camera stations, art direction |
| `src/solver` | Back-projection, soft occupancy, optimization, sparsification |
| `src/sculpture` | Instancing, fragment placement, materials, LOD |
| `src/camera` | Rail, snap assistance, framing, URL state |
| `src/lighting-audio` | Interactive light, projection-error sound, lifecycle |
| `src/quality` | Capability, dynamic resolution, thermal/frame budget |
| `src/accessibility` | HTML semantic mirror, 2D gallery, reduced motion, controls |

Rules for boundaries:

- Domain packages may not import UI, transport, cloud SDK, or framework state.
- Adapters translate external formats into validated domain types and retain provenance.
- Applications orchestrate domain capabilities; they do not reimplement algorithms or policy.
- Persistent data has a single authoritative owner, explicit schema/version, migration, retention, and rollback story.
- External SDK/provider objects do not cross the adapter boundary.
- Cross-component communication uses typed, versioned contracts and idempotency where delivery can repeat.
- Avoid circular dependencies, catch-all `utils` modules, and business logic in controllers/components.
- New top-level components require an ADR explaining ownership, dependencies, failure model, and operational cost.

### Approved technical direction

- TypeScript, Vite, React
- Three.js/React Three Fiber with custom GLSL/WGSL
- Web Workers and optional WebGPU compute for occupancy optimization
- Instanced geometry and adaptive quality governor
- Web Audio
- Playwright and fixed-camera screenshot/projection regression

Do not substitute a stack merely because an agent knows it better. A change must improve the production requirements and include migration/operational analysis.

## Data, model, and algorithm rules

- Define schemas at ingestion and reject or quarantine invalid input; never let malformed data drift into domain logic.
- Retain provenance, units, timestamps/timezones, versions, and uncertainty needed to reproduce a result.
- Separate training/tuning, validation, and held-out evaluation by immutable manifest when ML/statistics are used.
- Keep deterministic baselines and ablations beside learned methods.
- Seed randomized tests/jobs and record seeds in artifacts.
- Never print a benchmark, accuracy, health, environmental, financial, or impact claim that a committed command cannot regenerate.
- Prefer explicit abstention/refusal over an invented value.
- Version algorithms, prompts, model identifiers, content packs, calibration, schemas, and policy that can change outputs.
- Treat external model/provider output as untrusted and validate it against a typed schema and deterministic rules.

Project-specific verification surfaces:

- Fixed-camera projection IoU/screenshot regression
- Responsive framing across viewport/aspect ratios
- Frame-time, memory, load, and quality scaling
- Worker cancellation and incompatible-mask behavior
- WebGPU/WebGL2/mobile fallback
- Keyboard, touch, screen-reader mirror, reduced motion, mute

## Security, privacy, and safety rules

- No arbitrary public uploads in the initial release
- Bundle only licensed/original assets and audio
- Respect reduced motion and explicit audio consent
- Avoid GPU lockups with bounded jobs, cancellation, and quality limits

Additionally:

- Run a threat analysis before adding a new external input, credential, file parser, network target, side effect, or public endpoint.
- Enforce authentication and authorization server-side and at data access; client checks are only UX.
- Use least-privilege service identities and short-lived credentials where available.
- Redact secrets and sensitive values structurally, not with best-effort string replacement.
- Set size, time, concurrency, memory, and rate limits at every untrusted boundary.
- Validate redirects, URLs, file types, decompression, archive contents, and callback/webhook authenticity as relevant.
- Any real-world side effect must be previewable or policy-authorized, idempotent where possible, auditable, cancellable when possible, and reconciled after uncertain outcomes.
- Security controls may fail closed; they may never silently disable themselves for a demo.

## Implementation standards

### Types and contracts

- Use the strictest practical compiler/type settings.
- Validate runtime boundaries even when compile-time types exist.
- Represent domain states with explicit enums/tagged unions; make invalid transitions unrepresentable where possible.
- Include units in type/name, and use explicit timezone-aware types for time.
- Version serialized contracts before compatibility matters, not afterward.

### Errors and cancellation

- Errors have stable codes, safe user messages, internal context, and retryability classification.
- Preserve root causes without leaking secrets.
- Propagate cancellation and deadlines across workers, network calls, model calls, and child processes.
- Cleanup is idempotent and tested after cancellation/crash.

### Concurrency and persistence

- State transitions are atomic at the authoritative store.
- At-least-once delivery is assumed unless the boundary proves otherwise.
- Use idempotency keys and reconciliation for external operations.
- Never solve a monetary, safety, or authority race with an eventually consistent cache.
- Schema migrations are forward/backward compatible over the declared rollout window and include rollback or roll-forward recovery.

### Observability

- Use structured logs, metrics, and traces with stable event names and correlation/run IDs.
- Record decisions, versions, durations, retries, refusals/abstentions, and terminal outcomes.
- Do not log raw user content, credentials, sensitive media, health data, private locations, or full third-party transcripts unless an approved encrypted retention policy requires it.
- Every alert links to a runbook and measures user impact, not merely infrastructure noise.

### Dependencies

- Pin direct and transitive dependencies with a lockfile.
- Check license, maintenance, security history, binary/native implications, and bundle/runtime cost.
- Wrap external SDKs behind adapters.
- Generate an SBOM/release manifest for deployable artifacts.

## Testing requirements

A change is incomplete until the relevant layers pass:

1. **Unit tests:** pure domain rules, parsing, transitions, math and errors.
2. **Property/fuzz tests:** serialization, state machines, geometry/signal/solver spaces, parser robustness, and invariants.
3. **Integration tests:** real database/filesystem/browser/device/cloud/provider boundary in an isolated environment.
4. **Contract tests:** schemas and adapters against recorded/versioned fixtures, including provider drift.
5. **End-to-end tests:** complete user outcome, invalid input, cancellation, retry, restart, and recovery.
6. **Evaluation:** held-out domain metrics, baselines, calibration/uncertainty and reproducible artifact.
7. **Security/privacy:** authorization, injection, secret/log redaction, malicious input, rate/size limits.
8. **Accessibility:** keyboard, screen reader semantics, focus, contrast, reduced motion and non-visual equivalents.
9. **Performance/resilience:** latency/memory/frame/bundle/job budgets, load, resource exhaustion, dependency outage and fault injection.

Do not weaken, skip, quarantine, or mark flaky a failing test to merge. Fix the cause or document a reviewed removal of an invalid test. Test the failure path with the same seriousness as success.

## User experience rules

- The primary user outcome must be reachable without developer narration.
- Loading, empty, partial, stale, offline, unsupported, permission-denied, canceled, failed, and recovered states are designed states.
- Never use a green/success state for unknown, partial, low-confidence, or unverified output.
- Accessibility and responsive behavior are implemented with the component, not after feature freeze.
- No dead controls, fake progress, optimistic success before durable completion, or hidden destructive action.
- Technical evidence and limitations must be visible where users act on the result.

## Operational readiness

Before a production deployment exists, implement and document:

- typed environment/configuration validation;
- health and readiness semantics;
- SLOs and error-budget indicators;
- redacted logs, metrics, traces and dashboards;
- backup/restore and data migration where state exists;
- deployment, rollback, and emergency-disable procedures;
- resource ownership/TTL/cleanup;
- incident severity, escalation, and post-incident evidence;
- support matrix and known limitations.

Local and test environments must make real-world side effects impossible by default. Staging is production-shaped with synthetic/de-identified data.

## Release gates

1. Three curated scenes meet projection and art review
2. First meaningful reveal meets load budget
3. Supported device matrix meets frame/memory targets
4. Generator reports honest error and cannot block main render
5. Accessibility fallback covers all authored meaning
6. No external asset/license uncertainty remains

No agent may waive a gate. If a gate is impossible or invalid, produce evidence, propose a replacement with equal or stronger protection, and wait for review before changing it.

## Prohibited shortcuts

- Using bloom/particles to disguise unreadable silhouettes
- Animating geometry to fake the multi-view result
- Adding scenes before performance and art direction hold
- Shipping a blank or unusable page on fallback hardware

Also prohibited: empty scaffolding presented as progress, mass-generated boilerplate without ownership, copying code from another project without license/provenance review, demo-only auth or secrets, fabricated user research, fabricated benchmark results, and screenshots that imply unimplemented functionality.

## Required agent workflow

1. **Inspect:** read all authoritative docs, repository state, tests, configs, and relevant dependencies before editing.
2. **State the slice:** define the production user outcome, boundaries touched, invariants, threats, data migrations, observability, and acceptance tests.
3. **Design:** add/update an ADR for a new architectural dependency, persistent schema, external side effect, model, security boundary, or major algorithm.
4. **Implement vertically:** domain logic, adapter, UI/API, error states, telemetry, migrations, and documentation together.
5. **Verify:** run formatting, static analysis, unit/property, integration, E2E, domain evaluation, security, accessibility, and performance checks that apply.
6. **Review:** inspect the diff for cross-project leakage, fake data, secrets, permissive fallbacks, dead code, and weakened claims.
7. **Handoff:** report behavior delivered, commands run, evidence/metrics, risks, migrations, rollback, and remaining blocked items.

Do not stop at a plan when the user asked for implementation. Do not claim completion based on compilation or a single happy-path screenshot.

## Definition of done

A task is done only when:

- the supported user outcome works end to end in the intended environment;
- domain invariants are encoded and tested;
- invalid, unsupported, low-confidence, and dependency-failure paths are correct;
- authorization, privacy, safety, accessibility and performance requirements pass;
- observability makes success and failure diagnosable without exposing sensitive data;
- migrations, deployment, rollback and cleanup are reproducible;
- documentation and architecture match the implementation;
- no placeholders, stubs, hidden demo paths, unverified claims, or production TODOs remain;
- release gates relevant to the change pass from a clean checkout.

## Commit and review hygiene

Keep commits coherent and reviewable. Never mix generated artifacts, unrelated formatting, or cross-repository changes into a feature commit. Do not rewrite public history unless explicitly instructed. Before push, verify the exact staged file list, inspect the diff, and ensure no credential or sensitive fixture is included.
