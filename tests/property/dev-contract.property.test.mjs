import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_NAME,
  REPOSITORY_ROOT,
  interpretLsofListenerResult,
  isOwnershipRecord,
  parseLsofListeners,
  parsePortConfiguration,
} from '../../scripts/lib/dev-contract.mjs';

const service = { id: 'vite-dev', port: 4100 };
const validRecord = {
  schemaVersion: 1,
  project: PROJECT_NAME,
  repositoryRoot: REPOSITORY_ROOT,
  service: service.id,
  host: '127.0.0.1',
  port: service.port,
  pid: 4242,
  runId: '00000000-0000-4000-8000-000000000000',
  commandMarker: 'scripts/vite-service.mjs',
  processStartedAt: 'Sun Aug  9 21:00:00 2026',
};

describe('development contract property boundaries', () => {
  it('rejects every unsafe PID class across 256 cases', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: Number.MIN_SAFE_INTEGER, max: 1 }),
          fc.integer({ min: Number.MAX_SAFE_INTEGER + 1, max: Number.MAX_SAFE_INTEGER + 10_000 }),
          fc.double({ noNaN: false }),
        ),
        (pid) => {
          expect(isOwnershipRecord({ ...validRecord, pid }, service, String(pid))).toBe(false);
        },
      ),
      { numRuns: 256, seed: 4100 },
    );
  });

  it('rejects duplicate, missing, and out-of-block port declarations', () => {
    expect(() =>
      parsePortConfiguration('PORT_0=4100\nPORT_0=4101\nPORT_1=4101\nPORT_2=4102\nPORT_3=4103\n'),
    ).toThrow(/exactly once/u);
    expect(() => parsePortConfiguration('PORT_0=4100\nPORT_1=4101\nPORT_2=4102\n')).toThrow(
      /exactly once/u,
    );
    expect(() =>
      parsePortConfiguration('PORT_0=5173\nPORT_1=4101\nPORT_2=4102\nPORT_3=4103\n'),
    ).toThrow(/outside/u);
  });

  it('keeps listener address provenance instead of collapsing to a PID', () => {
    expect(
      parseLsofListeners('p42\ncnode\nf14\nn*:4100\np43\ncnode\nf16\nn127.0.0.1:4100\n'),
    ).toEqual([
      { pid: 42, command: 'node', address: '*:4100' },
      { pid: 43, command: 'node', address: '127.0.0.1:4100' },
    ]);
  });

  it('accepts only the exact lsof no-match exit and fails closed on tool failures', () => {
    expect(
      interpretLsofListenerResult({ status: 1, signal: null, stdout: '', stderr: '' }),
    ).toEqual([]);
    expect(() =>
      interpretLsofListenerResult({
        status: null,
        signal: null,
        error: Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }),
        stdout: '',
        stderr: '',
      }),
    ).toThrow(/could not execute \(ENOENT\)/u);
    expect(() =>
      interpretLsofListenerResult({ status: 0, signal: null, stdout: '', stderr: '' }),
    ).toThrow(/no parseable output/u);
    expect(() =>
      interpretLsofListenerResult({ status: 1, signal: null, stdout: '', stderr: 'denied' }),
    ).toThrow(/exit 1/u);
    expect(() =>
      interpretLsofListenerResult({
        status: 0,
        signal: null,
        stdout: 'xnot-a-supported-field\n',
        stderr: '',
      }),
    ).toThrow(/unexpected field/u);
  });

  it('rejects every unexpected nonzero lsof exit status', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 255 }), (status) => {
        expect(() =>
          interpretLsofListenerResult({ status, signal: null, stdout: '', stderr: '' }),
        ).toThrow(new RegExp(`exit ${status}`, 'u'));
      }),
      { numRuns: 256, seed: 4101 },
    );
  });
});
