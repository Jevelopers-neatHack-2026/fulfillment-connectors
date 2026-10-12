// Child process for the package suite. Run with `--max-old-space-size=256 --expose-gc`.
//   snapshot40  : a 40 MiB dense view is snapshotted; heap must stay tiny (enumerating its own keys would cost ~1.3 GiB and abort).
//   late-bytes  : a port that answers AFTER its deadline must not leave its bytes retained by the gate.
//   bounds-*    : the public pure API must reject a hostile file list BEFORE the first byte is copied. `bounds-control-one-copy` is the
//                 baseline: one accepted 40 MiB entry costs a 40 MiB ArrayBuffer and ~40 MiB of sampled resident-set growth (every source page is touched first).
//                 The rejections must cost almost nothing, where the old copy-first code cost one extra 40 MiB per repeated entry.
import { snapshotProductionBundleView } from "../dist/production-bundle.js";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import * as f from "./production-bundle-fixtures.mjs";
import { issuedAnchor, validateFiles } from "./production-bundle-cases-core.mjs";

const MiB = 1048576;
const mode = process.argv[2];
const memory = () => { globalThis.gc(); const usage = process.memoryUsage(); return { heapUsed: usage.heapUsed, arrayBuffers: usage.arrayBuffers }; };
const mib = (value) => Math.round((value / MiB) * 100) / 100;

if (mode === "snapshot40") {
  const view = new Uint8Array(40 * MiB);
  for (let index = 0; index < view.length; index += 4096) view[index] = index & 255;
  const before = memory();
  const started = performance.now();
  const result = snapshotProductionBundleView(view, 64 * MiB);
  const elapsedMs = Math.round(performance.now() - started);
  const after = memory();
  let intact = result.ok;
  if (result.ok) for (let index = 0; index < view.length; index += 4096) if (result.bytes[index] !== (index & 255)) intact = false;
  process.stdout.write(`${JSON.stringify({
    ok: result.ok, length: result.ok ? result.bytes.length : null, intact, elapsedMs,
    heapDeltaMiB: mib(after.heapUsed - before.heapUsed), arrayBuffersDeltaMiB: mib(after.arrayBuffers - before.arrayBuffers),
    sameBuffer: result.ok ? result.bytes.buffer === view.buffer : null
  })}\n`);
} else if (mode === "late-bytes") {
  const world = f.createWorld();
  f.publishFromBaseline(world);
  let ref = null;
  world.hooks.read = (request, dflt) => {
    if (request.filename !== "output.svg") return dflt();
    return new Promise((resolve) => setTimeout(() => {
      const late = new Uint8Array(4 * MiB);
      ref = new WeakRef(late);
      resolve({ status: "found", bytes: late });
    }, 150));
  };
  const gate = f.createGate(world, { limits: { readMs: 40, totalMs: 5000 } });
  const report = await gate.checkBeforeSubmit(f.gateRequest());
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (let round = 0; round < 6; round += 1) { globalThis.gc(); await new Promise((resolve) => setImmediate(resolve)); }
  process.stdout.write(`${JSON.stringify({ code: report.criteria.find((item) => item.id === "byte_custody").code, lateAnswered: ref !== null, retained: ref !== null && ref.deref() !== undefined })}\n`);
} else if (mode.startsWith("bounds-")) {
  // Touch every page of the caller's view so that any private copy of it is visible in the process's resident memory.
  const touched = (bytes) => { const view = new Uint8Array(bytes); for (let index = 0; index < view.length; index += 4096) view[index] = ((index >> 12) & 255) | 1; return view; };
  const MiBf = (bytes) => Math.round((bytes / MiB) * 100) / 100;
  const anchor = await issuedAnchor();
  const shared40 = mode === "bounds-payload-group" ? null : touched(40 * MiB);
  const shared8 = mode === "bounds-payload-group" ? touched(8 * MiB) : null;
  const lists = {
    "bounds-control-one-copy": () => [{ filename: "archive.zip", bytes: shared40 }],
    "bounds-repeat6-same-name": () => Array.from({ length: 6 }, () => ({ filename: "archive.zip", bytes: shared40 })),
    "bounds-repeat6-case-variants": () => ["archive.zip", "Archive.zip", "ARCHIVE.ZIP", "archive.ZIP", "aRCHIVE.zip", "ArChIvE.zIp"].map((filename) => ({ filename, bytes: shared40 })),
    "bounds-repeat6-distinct-unknown-names": () => Array.from({ length: 6 }, (_, index) => ({ filename: `p${index}.bin`, bytes: shared40 })),
    "bounds-payload-group": () => Array.from({ length: 5 }, (_, index) => ({ filename: `p${index}.bin`, bytes: shared8 }))
  };
  const build = lists[mode];
  if (build === undefined) { process.stdout.write(`${JSON.stringify({ error: "unknown_mode" })}\n`); process.exit(2); }

  // Two platform-independent signals of a private copy, both measured around ONE synchronous call:
  //  (1) the ArrayBuffer byte count of this isolate right after the call (a live private copy of a 40 MiB view is exactly 40 MiB; no GC is forced in between);
  //  (2) the PEAK of the process's CURRENT resident set, sampled by a worker thread that runs in parallel while the main thread is inside the call. Unlike the
  //      kernel's lifetime high-water mark (`maxRSS`, which on Linux can already include what a parent had resident at fork/exec), this peak starts at the
  //      value just before the call, so a transient copy that is freed before the call returns is still visible.
  // `maxRSS` before and after is recorded as a DIAGNOSTIC only and is never asserted.
  const control = new SharedArrayBuffer(32);
  const flag = new Int32Array(control, 0, 2); // [0] command: 0 idle, 1 sample, 2 stop
  const peaks = new Float64Array(control, 8, 3); // [0] peak rss bytes, [1] samples taken, [2] first sample rss bytes
  const sampler = new Worker(`
    const { workerData } = require("node:worker_threads");
    const flag = new Int32Array(workerData, 0, 2); const peaks = new Float64Array(workerData, 8, 3);
    let previous = 0;
    for (;;) {
      const command = Atomics.load(flag, 0);
      if (command === 2) break;
      if (command === 1) {
        const rss = process.memoryUsage.rss();
        if (previous !== 1) { peaks[0] = rss; peaks[1] = 0; peaks[2] = rss; }
        if (rss > peaks[0]) peaks[0] = rss;
        peaks[1] += 1;
      } else Atomics.wait(flag, 1, 0, 1);
      previous = command;
    }`, { eval: true, workerData: control });
  await once(sampler, "online");
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the worker's own start-up memory settle before anything is measured
  const files = build();
  globalThis.gc();
  const snap = () => { const usage = process.memoryUsage(); return { rss: usage.rss, arrayBuffers: usage.arrayBuffers, external: usage.external, heapUsed: usage.heapUsed, maxRss: process.resourceUsage().maxRSS * 1024 }; };
  const before = snap();
  Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
  const started = performance.now();
  const report = validateFiles(files, anchor);
  const elapsedMs = Math.round(performance.now() - started);
  Atomics.store(flag, 0, 0);
  const after = snap();
  const sampledPeak = peaks[0], samples = peaks[1];
  Atomics.store(flag, 0, 2); Atomics.notify(flag, 0);
  await once(sampler, "exit");
  const custody = report.criteria.find((item) => item.id === "byte_custody");
  process.stdout.write(`${JSON.stringify({
    mode, platform: process.platform, arch: process.arch, node: process.version, entries: files.length, verdict: report.verdict,
    byteCustody: { state: custody.state, code: custody.code }, reasons: report.diagnostic?.reasons ?? [], elapsedMs,
    arrayBuffersDeltaMiB: MiBf(after.arrayBuffers - before.arrayBuffers), sampledPeakRssDeltaMiB: MiBf(sampledPeak - before.rss), samples,
    diagnosticOnly: {
      rssBeforeMiB: MiBf(before.rss), rssAfterMiB: MiBf(after.rss), rssAfterDeltaMiB: MiBf(after.rss - before.rss),
      arrayBuffersBeforeMiB: MiBf(before.arrayBuffers), arrayBuffersAfterMiB: MiBf(after.arrayBuffers), externalDeltaMiB: MiBf(after.external - before.external), heapUsedDeltaMiB: MiBf(after.heapUsed - before.heapUsed),
      maxRssBeforeMiB: MiBf(before.maxRss), maxRssAfterMiB: MiBf(after.maxRss), maxRssDeltaMiB: MiBf(after.maxRss - before.maxRss), maxRssHeadroomOverRssBeforeMiB: MiBf(before.maxRss - before.rss)
    }
  })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ error: "unknown_mode" })}\n`);
  process.exitCode = 2;
}
