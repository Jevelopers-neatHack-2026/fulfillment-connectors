// Private fixture helpers, not provider retry policy or spending authority.
// FC06-AS-010: preserve raw timing; rounding must never grant/refuse an attempt.
export async function runFixtureClaimWithRetry({
  claim,
  retryStorageBusy,
  childIndex = 0,
  now = () => performance.now(),
  pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)),
  attemptWithinDeadlineForTests
}) {
  if (typeof claim !== "function") throw new TypeError("claim must be a function");
  if (typeof now !== "function" || typeof pause !== "function") {
    throw new TypeError("now and pause must be functions");
  }
  if (attemptWithinDeadlineForTests !== undefined && typeof attemptWithinDeadlineForTests !== "function") {
    throw new TypeError("attemptWithinDeadlineForTests must be a function");
  }
  const deadlineMs = retryStorageBusy?.deadlineMs;
  const jitterMs = retryStorageBusy?.jitterMs ?? 0;
  if (retryStorageBusy !== undefined &&
      (!Number.isFinite(deadlineMs) || deadlineMs < 0 ||
       !Number.isFinite(retryStorageBusy.delayMs) || retryStorageBusy.delayMs < 0 ||
       !Number.isFinite(jitterMs) || jitterMs < 0)) {
    throw new TypeError("retryStorageBusy must have finite nonnegative durations");
  }
  if (!Number.isSafeInteger(childIndex) || childIndex < 0) {
    throw new TypeError("childIndex must be a nonnegative safe integer");
  }
  const clockError = () => Object.assign(new RangeError("fixture_clock_invalid"), { code: "fixture_clock_invalid" });
  const startedAt = now();
  if (!Number.isFinite(startedAt) || startedAt < 0) throw clockError();
  let lastReading = startedAt;
  const offset = () => {
    const reading = now();
    if (!Number.isFinite(reading) || reading < lastReading) throw clockError();
    const value = reading - startedAt;
    if (!Number.isFinite(value) || value < 0) throw clockError();
    lastReading = reading;
    return value;
  };
  const isWithinDeadline = (attemptOffsetMs) => {
    if (deadlineMs === undefined) return true;
    // The existing negative control deliberately breaks only the cutoff policy.
    if (attemptWithinDeadlineForTests !== undefined) {
      return attemptWithinDeadlineForTests(attemptOffsetMs, deadlineMs);
    }
    return attemptOffsetMs < deadlineMs;
  };
  const deadlineError = () => Object.assign(new Error("fixture_retry_deadline"), { code: "fixture_retry_deadline" });
  const attempts = [];
  let result;
  let failure;
  let stopReason;
  let stoppedAtOffsetMs;
  const finish = (reason, observedOffsetMs) => {
    stopReason = reason;
    stoppedAtOffsetMs = observedOffsetMs;
  };

  for (;;) {
    const decisionOffsetMs = offset();
    if (!isWithinDeadline(decisionOffsetMs)) {
      failure = deadlineError();
      finish("retry_deadline_before_attempt", decisionOffsetMs);
      break;
    }
    const startOffsetMs = offset();
    if (!isWithinDeadline(startOffsetMs)) {
      failure = deadlineError();
      finish("retry_deadline_before_attempt", startOffsetMs);
      break;
    }

    let claimError;
    let outcome;
    let claimFailed = false;
    try {
      result = await claim();
      outcome = result.claimed ? "claimed" : "conflict";
    } catch (error) {
      claimFailed = true;
      claimError = error;
    }
    // Clock faults must invalidate the fixture, never be caught as storage_busy
    // or erase an already attempted claim. No subsequent claim is authorized.
    const completionOffsetMs = offset();
    const code = claimFailed && typeof claimError?.code === "string" ? claimError.code : null;
    attempts.push({
      attempt: attempts.length + 1,
      ...(claimFailed ? { errorCode: code } : { outcome }),
      decisionOffsetMs,
      startOffsetMs,
      completionOffsetMs,
      elapsedMs: completionOffsetMs - startOffsetMs
    });
    if (!claimFailed) {
      finish("claim_result", completionOffsetMs);
      break;
    }
    if (retryStorageBusy === undefined || code !== "storage_busy") {
      failure = claimError;
      finish(code === "storage_busy" ? "one_shot_storage_busy" : "nonbusy_error", completionOffsetMs);
      break;
    }
    if (!isWithinDeadline(completionOffsetMs)) {
      failure = deadlineError();
      finish("retry_deadline_after_storage_busy", completionOffsetMs);
      break;
    }
    const remainingMs = deadlineMs - completionOffsetMs;
    const jitter = jitterMs === 0 ? 0 : (childIndex * 7 + attempts.length * 11) % jitterMs;
    await pause(Math.max(0, Math.min(retryStorageBusy.delayMs + jitter, remainingMs)));
  }

  const elapsedMs = offset();
  return {
    result,
    failure,
    attempts,
    busyAttempts: attempts.filter((attempt) => attempt.errorCode === "storage_busy").length,
    elapsedMs,
    retryControl: {
      deadlineMs: deadlineMs ?? null,
      cutoffAtOffsetMs: deadlineMs ?? null,
      cutoffKind: deadlineMs === undefined ? "none" : "next_outer_attempt_start",
      stopReason,
      stoppedAtOffsetMs,
      attemptCount: attempts.length,
      elapsedMs
    }
  };
}

export function retryStartCutoffViolations(report) {
  const control = report?.retryControl;
  if (control === undefined || control === null) return ["retry control evidence is missing"];
  const duration = (value) => Number.isFinite(value) && value >= 0;
  const hasDeadline = control.deadlineMs !== null && control.deadlineMs !== undefined;
  if (hasDeadline && !duration(control.deadlineMs)) return ["retry cutoff is not a finite nonnegative duration"];
  if (hasDeadline &&
      (control.cutoffAtOffsetMs !== control.deadlineMs || control.cutoffKind !== "next_outer_attempt_start")) {
    return ["retry cutoff evidence does not match the configured start cutoff"];
  }
  if (!hasDeadline && (control.cutoffAtOffsetMs !== null || control.cutoffKind !== "none")) {
    return ["one-shot control unexpectedly reports a retry cutoff"];
  }
  if (!Array.isArray(report.attempts)) return ["retry attempt log is missing"];
  const issues = [];
  const stopReasons = new Set([
    "claim_result", "one_shot_storage_busy", "nonbusy_error",
    "retry_deadline_after_storage_busy", "retry_deadline_before_attempt"
  ]);
  if (!stopReasons.has(control.stopReason)) issues.push("retry stop reason is missing or unknown");
  let previousCompletion = 0;
  let busyAttempts = 0;
  for (const [index, attempt] of report.attempts.entries()) {
    const label = "attempt " + (index + 1);
    if (attempt === null || typeof attempt !== "object") {
      issues.push(label + " is missing or malformed");
      continue;
    }
    if (attempt.attempt !== index + 1) issues.push(label + " has an inconsistent ordinal");
    const hasOutcome = Object.hasOwn(attempt, "outcome");
    const hasError = Object.hasOwn(attempt, "errorCode");
    if (hasOutcome === hasError ||
        (hasOutcome && attempt.outcome !== "claimed" && attempt.outcome !== "conflict") ||
        (hasError && attempt.errorCode !== null && typeof attempt.errorCode !== "string")) {
      issues.push(label + " has an invalid result or error");
    }
    if (attempt.errorCode === "storage_busy") busyAttempts++;
    if (index < report.attempts.length - 1 && (!hasError || attempt.errorCode !== "storage_busy")) {
      issues.push(label + " retried a nonbusy or completed claim");
    }
    if (!duration(attempt.decisionOffsetMs)) {
      issues.push(label + " has no finite nonnegative cutoff-decision offset");
    } else {
      if (attempt.decisionOffsetMs < previousCompletion) issues.push(label + " decision predates the previous completion");
      if (hasDeadline && attempt.decisionOffsetMs >= control.deadlineMs) {
        issues.push(label + " decision was at or after cutoff (" + attempt.decisionOffsetMs + "ms)");
      }
    }
    if (!duration(attempt.startOffsetMs)) {
      issues.push(label + " has no finite nonnegative start offset");
    } else {
      if (attempt.startOffsetMs < attempt.decisionOffsetMs) issues.push(label + " started before its cutoff decision");
      if (hasDeadline && attempt.startOffsetMs >= control.deadlineMs) {
        issues.push(label + " started at or after cutoff (" + attempt.startOffsetMs + "ms)");
      }
    }
    if (!duration(attempt.completionOffsetMs) || !duration(attempt.elapsedMs)) {
      issues.push(label + " has invalid completion timing");
    } else if (attempt.completionOffsetMs < attempt.startOffsetMs) {
      issues.push(label + " completed before its measured start");
    } else if (attempt.elapsedMs !== attempt.completionOffsetMs - attempt.startOffsetMs) {
      issues.push(label + " elapsed duration does not match its raw offsets");
    }
    previousCompletion = attempt.completionOffsetMs;
  }
  if (control.attemptCount !== report.attempts.length) issues.push("retry attempt count does not match its log");
  if (report.busyAttempts !== busyAttempts) issues.push("retry busy count does not match its log");
  if (!hasDeadline && report.attempts.length !== 1) issues.push("one-shot control must contain exactly one attempt");
  if (!duration(control.stoppedAtOffsetMs)) issues.push("retry stop offset is not finite and nonnegative");
  if (duration(control.stoppedAtOffsetMs) && duration(previousCompletion) && control.stoppedAtOffsetMs < previousCompletion) {
    issues.push("retry stop offset predates the final attempt completion");
  }
  if (!duration(report.elapsedMs) || !duration(control.elapsedMs) || report.elapsedMs !== control.elapsedMs) {
    issues.push("retry elapsed totals are invalid or inconsistent");
  } else if (control.elapsedMs < control.stoppedAtOffsetMs) {
    issues.push("retry elapsed total predates its stop");
  }
  const last = report.attempts.at(-1);
  if (control.stopReason === "retry_deadline_before_attempt" || control.stopReason === "retry_deadline_after_storage_busy") {
    if (!hasDeadline || control.stoppedAtOffsetMs < control.deadlineMs) issues.push("retry stopped for elapsed deadline before cutoff");
    if ((last !== undefined && last?.errorCode !== "storage_busy") ||
        (control.stopReason === "retry_deadline_after_storage_busy" && last?.errorCode !== "storage_busy")) {
      issues.push("retry deadline stop does not follow storage_busy");
    }
  }
  if (control.stopReason !== "retry_deadline_before_attempt" &&
      (last === undefined || control.stoppedAtOffsetMs !== last?.completionOffsetMs)) {
    issues.push("retry terminal stop does not match the final completion");
  }
  if (control.stopReason === "claim_result" && last?.outcome !== "claimed" && last?.outcome !== "conflict") {
    issues.push("claim_result stop has no claim outcome");
  }
  if (control.stopReason === "one_shot_storage_busy" && (hasDeadline || last?.errorCode !== "storage_busy")) {
    issues.push("one-shot busy stop is inconsistent");
  }
  if (control.stopReason === "nonbusy_error" &&
      (last === undefined || !Object.hasOwn(last ?? {}, "errorCode") || last?.errorCode === "storage_busy")) {
    issues.push("nonbusy stop has no nonbusy error");
  }
  return issues;
}
