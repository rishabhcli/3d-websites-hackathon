.PHONY: bootstrap build check test test-integration test-e2e eval run-local release-check verify-all dev-preflight dev-up dev-health dev-down

bootstrap:
	pnpm run bootstrap

build:
	pnpm run build

check:
	pnpm run check

test:
	pnpm run test

test-integration:
	pnpm run test:integration

test-e2e:
	pnpm run test:e2e

eval:
	pnpm run eval

run-local: dev-up

release-check: verify-all

verify-all:
	pnpm run verify-all

dev-preflight:
	pnpm run dev:preflight

dev-up:
	pnpm run dev:up

dev-health:
	pnpm run dev:health

dev-down:
	pnpm run dev:down

