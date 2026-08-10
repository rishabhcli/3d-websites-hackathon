# Assumptions

This file records decisions made without user input and the cheapest later verification. Entries are append-only.

## 2026-08-09 — Conflicting foreign-port instructions

- **Decision:** implement the stricter reading of GOAL.md §0A: every listener anywhere in 4100-4109 makes preflight fail unless exact repository ownership is proved. Do not silently remap while the foreign listener remains.
- **Reason:** §0A.4 requires preflight to fail on any foreign holder in the whole block, while §0A.2.5 permits remapping inside the block. Both cannot be green simultaneously. Failing closed better protects sibling sessions.
- **Cheapest verification:** an ADR or user instruction can resolve the conflict; until then, the foreign-listener integration test protects the stricter interpretation.

## 2026-08-09 — Trust-policy exception for semver 6.3.1

- **Decision:** exclude only exact `semver@6.3.1` from pnpm's provenance trust-downgrade rule while retaining lock integrity, maturity, audit, peer, exotic-subdependency, and lifecycle-script policies.
- **Reason:** it is a longstanding transitive build-tool dependency reached through Babel/ESLint; registry metadata for that historical release predates current provenance evidence, so the general rule otherwise makes the locked toolchain unresolvable.
- **Cheapest verification:** remove the exception on every dependency upgrade and run a fresh `pnpm install`; retain it only while the exact dependency is still required and `pnpm audit --audit-level high` is green.
