// FC06-AS-010: synthetic local claim/clock controls, never provider evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { runFixtureClaimWithRetry, retryStartCutoffViolations } from "./fixture-claim-retry.mjs";

const busy = () => Object.assign(new Error("storage_busy"), { code: "storage_busy" });
function clock(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
async function successfulReport() {
  return runFixtureClaimWithRetry({
    claim: async () => ({ claimed: true }),
    retryStorageBusy: { deadlineMs: 20, delayMs: 1 },
    now: clock([0, 1, 2, 3, 4])
  });
}
async function retryReport() {
  let calls = 0;
  return runFixtureClaimWithRetry({
    claim: async () => { if (++calls === 1) throw busy(); return { claimed: false }; },
    retryStorageBusy: { deadlineMs: 20, delayMs: 1 },
    now: clock([0, 1, 2, 3, 4, 5, 6, 7]),
    pause: async () => {}
  });
}

test("fractional cutoff does not round a late start into permission", async () => {
  let calls = 0;
  const report = await runFixtureClaimWithRetry({
    claim: async () => { calls++; return { claimed: true }; },
    retryStorageBusy: { deadlineMs: 0.0004, delayMs: 0 },
    now: clock([0, 0, 0.00044, 0.00044])
  });
  assert.equal(calls, 0);
  assert.equal(report.failure?.code, "fixture_retry_deadline");
  assert.deepEqual(retryStartCutoffViolations(report), []);
});

test("rounding does not refuse a start strictly before the cutoff", async () => {
  const report = await runFixtureClaimWithRetry({
    claim: async () => ({ claimed: true }),
    retryStorageBusy: { deadlineMs: 1, delayMs: 0 },
    now: clock([0, 0.9996, 0.9997, 1.2, 1.3])
  });
  assert.equal(report.result?.claimed, true);
  assert.equal(report.attempts[0].startOffsetMs, 0.9997);
  assert.deepEqual(retryStartCutoffViolations(report), []);
});

test("start exactly at cutoff sends nothing; an already started claim may finish later", async () => {
  let calls = 0;
  const report = await runFixtureClaimWithRetry({
    claim: async () => { calls++; return { claimed: true }; },
    retryStorageBusy: { deadlineMs: 1, delayMs: 0 },
    now: clock([0, 0, 1, 1])
  });
  assert.equal(calls, 0);
  assert.deepEqual(retryStartCutoffViolations(report), []);
  const later = await runFixtureClaimWithRetry({
    claim: async () => ({ claimed: true }),
    retryStorageBusy: { deadlineMs: 1, delayMs: 0 },
    now: clock([0, 0, 0.5, 5, 5])
  });
  assert.equal(later.result.claimed, true);
  assert.deepEqual(retryStartCutoffViolations(later), []);
});

test("fractional remaining delay uses raw completion time", async () => {
  let nowMs = 0;
  let calls = 0;
  const report = await runFixtureClaimWithRetry({
    claim: async () => { calls++; nowMs = 0.0003; throw busy(); },
    retryStorageBusy: { deadlineMs: 0.0004, delayMs: 10 },
    now: () => nowMs,
    pause: async (delay) => {
      assert.equal(delay, 0.0004 - 0.0003);
      nowMs = 0.0004;
    }
  });
  assert.equal(calls, 1);
  assert.equal(report.retryControl.stopReason, "retry_deadline_before_attempt");
  assert.deepEqual(retryStartCutoffViolations(report), []);
});

for (const [name, samples, expectedCalls] of [
  ["decision", [10, 9], 0],
  ["start", [10, 12, 11], 0],
  ["success completion", [10, 11, 12, 11], 1],
  ["final measurement", [10, 11, 12, 13, 12], 1]
]) {
  test(`backward clock at ${name} invalidates the run without another claim`, async () => {
    let calls = 0;
    await assert.rejects(runFixtureClaimWithRetry({
      claim: async () => { calls++; return { claimed: true }; },
      now: clock(samples)
    }), { code: "fixture_clock_invalid" });
    assert.equal(calls, expectedCalls);
  });
}

test("backward completion after storage_busy never becomes a retry", async () => {
  let calls = 0;
  await assert.rejects(runFixtureClaimWithRetry({
    claim: async () => { calls++; throw busy(); },
    retryStorageBusy: { deadlineMs: 20, delayMs: 0 },
    now: clock([10, 11, 12, 11, 30]),
    pause: async () => { throw new Error("must not pause"); }
  }), { code: "fixture_clock_invalid" });
  assert.equal(calls, 1);
});

for (const value of [NaN, Infinity, -Infinity, -1, "1"]) {
  test(`invalid clock reading ${String(value)} rejects before claim`, async () => {
    let calls = 0;
    await assert.rejects(runFixtureClaimWithRetry({
      claim: async () => { calls++; return { claimed: true }; }, now: () => value
    }), { code: "fixture_clock_invalid" });
    assert.equal(calls, 0);
  });
}

test("same-instant readings and one-shot outcomes retain their existing behavior", async () => {
  for (const claimed of [true, false]) {
    const r = await runFixtureClaimWithRetry({ claim: async () => ({ claimed }), now: () => 0 });
    assert.equal(r.result.claimed, claimed);
    assert.deepEqual(retryStartCutoffViolations(r), []);
  }
  const r = await runFixtureClaimWithRetry({ claim: async () => { throw busy(); }, now: () => 0 });
  assert.equal(r.failure.code, "storage_busy");
  assert.deepEqual(retryStartCutoffViolations(r), []);
});

test("same claim closure retries only storage_busy and bounds pause", async () => {
  let nowMs = 0;
  let calls = 0;
  const record = Object.freeze({ identity: "synthetic-same-claim" });
  const seen = [];
  const report = await runFixtureClaimWithRetry({
    claim: async () => { seen.push(record); if (++calls === 1) throw busy(); return { claimed: true }; },
    retryStorageBusy: { deadlineMs: 20, delayMs: 2, jitterMs: 5 }, childIndex: 3,
    now: () => nowMs,
    pause: async (delay) => { assert.ok(delay >= 2 && delay < 7); nowMs += delay; }
  });
  assert.equal(calls, 2);
  assert.ok(seen.every((r) => r === record));
  assert.deepEqual(retryStartCutoffViolations(JSON.parse(JSON.stringify(report))), []);
});

test("nonbusy errors and zero deadlines never acquire retry authority", async () => {
  const error = Object.assign(new Error("denied"), { code: "denied" });
  const report = await runFixtureClaimWithRetry({
    claim: async () => { throw error; }, retryStorageBusy: { deadlineMs: 20, delayMs: 0 }, now: () => 0
  });
  assert.equal(report.failure, error);
  assert.deepEqual(retryStartCutoffViolations(report), []);
  const zero = await runFixtureClaimWithRetry({
    claim: () => { throw new Error("must not claim"); }, retryStorageBusy: { deadlineMs: 0, delayMs: 0 }, now: () => 0
  });
  assert.equal(zero.attempts.length, 0);
  assert.deepEqual(retryStartCutoffViolations(zero), []);
});

test("deliberately broken cutoff hook remains detectable by the independent validator", async () => {
  let calls = 0;
  let nowMs = 0;
  const report = await runFixtureClaimWithRetry({
    claim: async () => { if (++calls === 1) { nowMs = 201; throw busy(); } return { claimed: true }; },
    retryStorageBusy: { deadlineMs: 200, delayMs: 10 }, now: () => nowMs,
    pause: async (delay) => assert.equal(delay, 0), attemptWithinDeadlineForTests: () => true
  });
  assert.equal(calls, 2);
  assert.match(retryStartCutoffViolations(report).join("\n"), /attempt 2 .* at or after cutoff/);
});

const corruptions = {
  "negative decision": (r) => { r.attempts[0].decisionOffsetMs = -1; },
  "negative start": (r) => { r.attempts[0].startOffsetMs = -1; },
  "negative completion": (r) => { r.attempts[0].completionOffsetMs = -1; },
  "decision after start": (r) => { r.attempts[0].decisionOffsetMs = 2.5; },
  "fabricated elapsed": (r) => { r.attempts[0].elapsedMs = 99; },
  "incorrect ordinal": (r) => { r.attempts[0].attempt = 2; },
  "stop before completion": (r) => { r.retryControl.stoppedAtOffsetMs = 2; },
  "negative stop": (r) => { r.retryControl.stoppedAtOffsetMs = -1; },
  "negative overall elapsed": (r) => { r.elapsedMs = r.retryControl.elapsedMs = -1; },
  "overall elapsed before stop": (r) => { r.elapsedMs = r.retryControl.elapsedMs = 2.5; },
  "overall elapsed disagreement": (r) => { r.elapsedMs = 5; },
  "missing overall elapsed": (r) => { delete r.elapsedMs; },
  "missing control elapsed": (r) => { delete r.retryControl.elapsedMs; },
  "incorrect busy count": (r) => { r.busyAttempts = 1; },
  "wrong final outcome": (r) => { r.attempts[0].outcome = "unknown"; },
  "outcome and error together": (r) => { r.attempts[0].errorCode = "storage_busy"; },
  "wrong stop reason": (r) => { r.retryControl.stopReason = "one_shot_storage_busy"; },
  "wrong attempt count": (r) => { r.retryControl.attemptCount = 2; },
  "missing attempt row": (r) => { r.attempts = new Array(1); },
  "null attempt row": (r) => { r.attempts[0] = null; }
};
for (const [name, mutate] of Object.entries(corruptions)) {
  test(`diagnostic validator rejects ${name}`, async () => {
    const r = await successfulReport();
    mutate(r);
    assert.notDeepEqual(retryStartCutoffViolations(r), []);
  });
}

test("diagnostic validator rejects overlapping attempts and nonbusy intermediate errors", async () => {
  const good = await retryReport();
  assert.deepEqual(retryStartCutoffViolations(good), []);
  for (const mutate of [
    (r) => { r.attempts[1].decisionOffsetMs = 2.5; },
    (r) => { r.attempts[0].errorCode = "denied"; r.busyAttempts = 0; },
    (r) => { r.attempts[0].outcome = "claimed"; delete r.attempts[0].errorCode; r.busyAttempts = 0; }
  ]) {
    const r = structuredClone(good); mutate(r);
    assert.notDeepEqual(retryStartCutoffViolations(r), []);
  }
});

test("raw precision remains consistent through JSON at a nonzero clock origin", async () => {
  const r = await runFixtureClaimWithRetry({
    claim: async () => ({ claimed: true }), now: clock([1000.1, 1000.1234, 1000.2345, 1000.8765, 1001.1234])
  });
  assert.equal(r.attempts[0].elapsedMs, r.attempts[0].completionOffsetMs - r.attempts[0].startOffsetMs);
  assert.deepEqual(retryStartCutoffViolations(JSON.parse(JSON.stringify(r))), []);
});

test("real monotonic timer and bounded busy recovery produce consistent evidence", async () => {
  let calls = 0;
  const r = await runFixtureClaimWithRetry({
    claim: async () => { if (++calls === 1) throw busy(); return { claimed: true }; },
    retryStorageBusy: { deadlineMs: 5000, delayMs: 1 }
  });
  assert.equal(calls, 2);
  assert.deepEqual(retryStartCutoffViolations(JSON.parse(JSON.stringify(r))), []);
});

test("invalid retry settings reject before clock or claim execution", async () => {
  for (const options of [
    { retryStorageBusy: { deadlineMs: -1, delayMs: 0 } },
    { retryStorageBusy: { deadlineMs: 1, delayMs: NaN } },
    { retryStorageBusy: { deadlineMs: 1, delayMs: 0, jitterMs: Infinity } },
    { retryStorageBusy: { deadlineMs: 1, delayMs: 0, jitterMs: -1 } },
    { childIndex: -1 }, { childIndex: 0.5 }, { childIndex: Infinity },
    { attemptWithinDeadlineForTests: true }, { pause: null }
  ]) {
    let calls = 0;
    let reads = 0;
    await assert.rejects(runFixtureClaimWithRetry({
      claim: async () => { calls++; return { claimed: true }; },
      now: () => { reads++; return 0; }, ...options
    }), TypeError);
    assert.equal(calls, 0);
    assert.equal(reads, 0);
  }
});

test("nonfinite completion invalidates both fulfilled and rejected claims without retry", async () => {
  for (const failed of [false, true]) {
    let calls = 0;
    await assert.rejects(runFixtureClaimWithRetry({
      claim: async () => { calls++; if (failed) throw busy(); return { claimed: true }; },
      retryStorageBusy: { deadlineMs: 20, delayMs: 0 },
      now: clock([0, 1, 2, NaN, 30]), pause: async () => { throw new Error("must not pause"); }
    }), { code: "fixture_clock_invalid" });
    assert.equal(calls, 1);
  }
});
