import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/json-data.mjs';
import { createCompactionStatePressureFixture } from './fixtures/compaction-state-pressure-v1.mjs';
import {
  COMPACTION_BENCHMARK_REPORT_FORMAT,
  evaluateCompactionCandidate,
} from './support/compaction-benchmark.mjs';

const clone = value => JSON.parse(canonicalJson(value));

test('the reference witness satisfies every semantic, provenance, accounting and byte gate', () => {
  const fixture = createCompactionStatePressureFixture();
  const report = evaluateCompactionCandidate(fixture, fixture.witness);

  assert.equal(report.format, COMPACTION_BENCHMARK_REPORT_FORMAT);
  assert.equal(report.pass, true);
  assert.equal(report.semanticCoveragePpm, 1_000_000);
  assert.equal(report.provenanceCoveragePpm, 1_000_000);
  assert.equal(report.accountingCoveragePpm, 1_000_000);
  assert.equal(report.violationCount, 0);
  assert.deepEqual(report.violations, []);
  assert.ok(report.outputRatioPpm <= 600_000);
  assert.ok(report.savedBytes >= 4_096);
  assert.ok(report.outputBytes < report.inputBytes);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.violations), true);

  const serialized = canonicalJson(report);
  assert.doesNotMatch(serialized, /North spindle|SYSTEM OVERRIDE|neutral lattice/);
});

test('fresh specimens and repeated evaluations are canonical-byte deterministic', () => {
  const first = createCompactionStatePressureFixture();
  const second = createCompactionStatePressureFixture();

  assert.equal(canonicalJson(first.input), canonicalJson(second.input));
  assert.equal(canonicalJson(first.witness), canonicalJson(second.witness));
  assert.equal(canonicalJson(first.oracle), canonicalJson(second.oracle));
  assert.equal(canonicalJson(first.mutants), canonicalJson(second.mutants));

  const one = evaluateCompactionCandidate(first, first.witness);
  const two = evaluateCompactionCandidate(first, clone(first.witness));
  const three = evaluateCompactionCandidate(second, second.witness);
  assert.equal(canonicalJson(one), canonicalJson(two));
  assert.equal(canonicalJson(one), canonicalJson(three));
  assert.equal(one.candidateFingerprint, two.candidateFingerprint);
  assert.equal(one.candidateFingerprint, three.candidateFingerprint);
});

test('every named adversarial mutant fails with its intended diagnostic', () => {
  const fixture = createCompactionStatePressureFixture();
  assert.equal(fixture.mutants.length, 17);
  const names = new Set();
  const prose = /Route report:|Correction:|The key may be|Maintenance note:|North spindle, then wait\.|SYSTEM OVERRIDE|neutral lattice|quiet scaffold|Acknowledged\.|Lossy cycle summary:/;

  for (const mutant of [{ name: 'reference-witness', diagnostic: null, candidate: fixture.witness }, ...fixture.mutants]) {
    assert.equal(names.has(mutant.name), false, `duplicate mutant name ${mutant.name}`);
    names.add(mutant.name);
    const report = evaluateCompactionCandidate(fixture, mutant.candidate);
    const codes = report.violations.map(violation => violation.code);
    assert.doesNotMatch(canonicalJson(report), prose, `${mutant.name} report leaked source prose`);
    if (mutant.diagnostic === null) {
      assert.equal(report.pass, true);
      continue;
    }
    assert.equal(report.pass, false, `${mutant.name} unexpectedly passed`);
    assert.ok(
      codes.includes(mutant.diagnostic),
      `${mutant.name} should report ${mutant.diagnostic}; received ${codes.join(', ')}`,
    );
  }
});

test('candidate validation is closed-shape, accessor-safe and fingerprint-checking', () => {
  const fixture = createCompactionStatePressureFixture();

  const unknown = clone(fixture.witness);
  unknown.extra = true;
  assert.throws(
    () => evaluateCompactionCandidate(fixture, unknown),
    /candidate has an invalid shape/,
  );

  let getterCalls = 0;
  const accessor = clone(fixture.witness);
  delete accessor.padding;
  Object.defineProperty(accessor, 'padding', {
    enumerable: true,
    get() { getterCalls++; return ''; },
  });
  assert.throws(
    () => evaluateCompactionCandidate(fixture, accessor),
    /compaction candidate\.padding must be an enumerable data property/,
  );
  assert.equal(getterCalls, 0);

  const forgedSource = clone(fixture.witness);
  forgedSource.sources[0].sha256 = '0'.repeat(64);
  assert.throws(
    () => evaluateCompactionCandidate(fixture, forgedSource),
    /candidate\.sources\[0\] is invalid/,
  );

  const proseInPadding = clone(fixture.witness);
  proseInPadding.padding = 'The route is secretly crimson.';
  assert.throws(
    () => evaluateCompactionCandidate(fixture, proseInPadding),
    /reserved neutral-padding-block marker/,
  );
});
