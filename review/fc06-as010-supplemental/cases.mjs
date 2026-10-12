import assert from "node:assert/strict";

// Private synthetic clock/claim controls for the hash-pinned manual replay.
// These do not register themselves in native suites or authorize dispatch.
export function registerRetryControlCases(test, { runFixtureClaimWithRetry: run, retryStartCutoffViolations: violations }) {
  const clock = (readings) => {
    let index = 0;
    return () => readings[Math.min(index++, readings.length - 1)];
  };
  const busy = () => Object.assign(new Error("synthetic contention"), { code: "storage_busy" });
  const policy = (deadlineMs) => ({ deadlineMs, delayMs: 1 });
  const validReport = () => ({
    attempts: [
      { attempt: 1, errorCode: "storage_busy", decisionOffsetMs: 0, startOffsetMs: 1, completionOffsetMs: 2, elapsedMs: 1 },
      { attempt: 2, outcome: "claimed", decisionOffsetMs: 3, startOffsetMs: 4, completionOffsetMs: 5, elapsedMs: 1 }
    ],
    busyAttempts: 1,
    elapsedMs: 6,
    retryControl: {
      deadlineMs: 10, cutoffAtOffsetMs: 10, cutoffKind: "next_outer_attempt_start",
      stopReason: "claim_result", stoppedAtOffsetMs: 5, attemptCount: 2, elapsedMs: 6
    }
  });

  test("AS010: a raw start below cutoff is not rounded into refusal", async () => {
    let calls = 0;
    const report = await run({
      now: clock([0, 0.9996, 0.9996, 1.1, 1.1]), retryStorageBusy: policy(1),
      claim: async () => { calls++; return { claimed: true }; }
    });
    assert.equal(calls, 1);
    assert.equal(report.attempts[0].startOffsetMs, 0.9996);
    assert.deepEqual(violations(report), []);
  });
  for (const [label, decision, start] of [
    ["at fractional cutoff", 1.0004, 1.0004],
    ["after fractional cutoff", 1.00049, 1.00049],
    ["second clock read reaches cutoff", 1, 1.0004]
  ]) {
    test(`AS010: ${label} permits no claim`, async () => {
      let calls = 0;
      const report = await run({
        now: clock([0, decision, start, 2, 2]), retryStorageBusy: policy(1.0004),
        claim: async () => { calls++; return { claimed: true }; }
      });
      assert.equal(calls, 0);
      assert.equal(report.failure?.code, "fixture_retry_deadline");
      assert.deepEqual(violations(report), []);
    });
  }
  test("AS010: zero deadline starts no claim", async () => {
    let calls = 0;
    const report = await run({ now: () => 0, retryStorageBusy: policy(0), claim: async () => { calls++; return { claimed: true }; } });
    assert.equal(calls, 0);
    assert.deepEqual(violations(report), []);
  });
  test("AS010: a claim started in time may finish beyond cutoff", async () => {
    const report = await run({ now: clock([0, 1, 2, 11, 12]), retryStorageBusy: policy(10), claim: async () => ({ claimed: true }) });
    assert.equal(report.result.claimed, true);
    assert.equal(report.retryControl.stopReason, "claim_result");
    assert.deepEqual(violations(report), []);
  });
  test("AS010: busy completion at fractional cutoff never pauses or retries", async () => {
    let pauses = 0;
    let calls = 0;
    const report = await run({
      now: clock([0, 0, 0, 1.0004, 2, 2]), retryStorageBusy: policy(1.0004),
      claim: async () => { calls++; throw busy(); }, pause: async () => { pauses++; }
    });
    assert.equal(calls, 1);
    assert.equal(pauses, 0);
    assert.equal(report.retryControl.stopReason, "retry_deadline_after_storage_busy");
    assert.deepEqual(violations(report), []);
  });
  test("AS010: pause is capped by the unrounded remaining duration", async () => {
    const pauses = [];
    const report = await run({
      now: clock([0, 0, 0, 1.0001, 2, 2]), retryStorageBusy: policy(1.0004),
      claim: async () => { throw busy(); }, pause: async (ms) => { pauses.push(ms); }
    });
    assert.equal(pauses.length, 1);
    assert.equal(pauses[0], 1.0004 - 1.0001);
    assert.deepEqual(violations(report), []);
  });
  test("AS010: ordinary busy retry retains one successful result and consistent JSON evidence", async () => {
    let calls = 0;
    let time = 0;
    const report = await run({
      now: () => time, retryStorageBusy: policy(10), pause: async (ms) => { time += ms; },
      claim: async () => { if (++calls === 1) throw busy(); return { claimed: true }; }
    });
    assert.equal(calls, 2);
    assert.equal(report.busyAttempts, 1);
    assert.deepEqual(violations(JSON.parse(JSON.stringify(report))), []);
  });
  for (const [label, claim, expected] of [
    ["one-shot conflict", async () => ({ claimed: false }), "claim_result"],
    ["one-shot busy", async () => { throw busy(); }, "one_shot_storage_busy"],
    ["nonbusy error", async () => { throw Object.assign(new Error("synthetic error"), { code: "denied" }); }, "nonbusy_error"]
  ]) {
    test(`AS010: ${label} semantics stay unchanged`, async () => {
      const report = await run({ now: clock([0, 1, 2, 3, 4]), claim });
      assert.equal(report.attempts.length, 1);
      assert.equal(report.retryControl.stopReason, expected);
      assert.deepEqual(violations(report), []);
    });
  }
  test("AS010: deliberately broken start policy remains detectable", async () => {
    const report = await run({
      now: clock([0, 2, 2, 3, 4]), retryStorageBusy: policy(1),
      attemptWithinDeadlineForTests: () => true, claim: async () => ({ claimed: true })
    });
    assert.ok(violations(report).some((message) => message.includes("cutoff")));
  });
  for (const [label, value] of [["negative", -1], ["NaN", NaN], ["infinite", Infinity], ["negative infinite", -Infinity], ["string", "0"], ["null", null]]) {
    test(`AS010: ${label} initial clock fails before claiming`, async () => {
      let calls = 0;
      await assert.rejects(run({ now: () => value, claim: async () => { calls++; return { claimed: true }; } }), { code: "fixture_clock_invalid" });
      assert.equal(calls, 0);
    });
  }
  for (const [phase, readings, expectedCalls] of [
    ["decision", [10, 9, 10, 11, 12], 0],
    ["start", [10, 11, 10.5, 12, 13], 0],
    ["completion", [10, 11, 12, 11.5, 13], 1],
    ["final observation", [10, 11, 12, 13, 12.5], 1],
    ["next decision", [10, 11, 12, 13, 12.5, 14, 15, 16], 1]
  ]) {
    test(`AS010: clock regression at ${phase} cannot produce passing evidence`, async () => {
      let calls = 0;
      await assert.rejects(run({
        now: clock(readings), retryStorageBusy: policy(20), pause: async () => {},
        claim: async () => { calls++; if (phase === "next decision" && calls === 1) throw busy(); return { claimed: true }; }
      }), { code: "fixture_clock_invalid" });
      assert.equal(calls, expectedCalls);
    });
  }
  test("AS010: complete internally consistent synthetic timing evidence is accepted", () => {
    assert.deepEqual(violations(validReport()), []);
  });
  const corruptions = [
    ["negative decision", (r) => { r.attempts[0].decisionOffsetMs = -1; }],
    ["negative start", (r) => { r.attempts[0].startOffsetMs = -1; r.attempts[0].elapsedMs = 3; }],
    ["decision after start", (r) => { r.attempts[0].decisionOffsetMs = 1.5; }],
    ["overlapping attempts", (r) => { r.attempts[1].decisionOffsetMs = 1.5; }],
    ["inconsistent attempt elapsed", (r) => { r.attempts[0].elapsedMs = 0.5; }],
    ["inconsistent ordinal", (r) => { r.attempts[1].attempt = 7; }],
    ["inconsistent busy count", (r) => { r.busyAttempts = 0; }],
    ["elapsed before stop", (r) => { r.elapsedMs = r.retryControl.elapsedMs = 4; }],
    ["mismatched elapsed fields", (r) => { r.retryControl.elapsedMs = 7; }],
    ["missing elapsed", (r) => { delete r.elapsedMs; }],
    ["negative stop", (r) => { r.retryControl.stoppedAtOffsetMs = -1; }],
    ["missing final outcome", (r) => { delete r.attempts[1].outcome; }],
    ["outcome and error together", (r) => { r.attempts[1].errorCode = null; }],
    ["retry after success", (r) => { delete r.attempts[0].errorCode; r.attempts[0].outcome = "claimed"; r.busyAttempts = 0; }],
    ["wrong terminal reason", (r) => { r.retryControl.stopReason = "nonbusy_error"; }],
    ["one-shot with retries", (r) => { r.retryControl.deadlineMs = r.retryControl.cutoffAtOffsetMs = null; r.retryControl.cutoffKind = "none"; }],
    ["claim result without attempts", (r) => { r.attempts = []; r.busyAttempts = r.retryControl.attemptCount = 0; }],
    ["stop later than terminal completion", (r) => { r.retryControl.stoppedAtOffsetMs = 5.5; }]
  ];
  for (const [label, corrupt] of corruptions) {
    test(`AS010: evidence rejects ${label}`, () => {
      const report = validReport();
      corrupt(report);
      assert.ok(violations(report).length > 0, label);
    });
  }
}
