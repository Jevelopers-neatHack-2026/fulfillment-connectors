// Offline supplementary replay for PR50, not a native-suite or approval gate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { registerRetryControlCases } from "./cases.mjs";

if (process.argv.length !== 3) {
  throw new Error("Usage: node review/fc06-as010-supplemental/run.mjs /path/to/tests/fixture-claim-retry.mjs");
}
const bytes = await readFile(process.argv[2]);
assert.equal(createHash("sha256").update(bytes).digest("hex"),
  "43cf7ec11ce9e8ae74ee133a94a3887756b9b2f3e3d6e185a6bc95d4d6fbfe10",
  "Source differs from PR50 c1717e09; no candidate code was imported");
assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
  "edafa5aa053d2c183eef13f68d1fd2408fd2f83c", "Unexpected source Git blob");
// Import exactly the verified in-memory bytes, not a reread of the mutable path.
// This pinned pure module has no relative imports or external service calls.
const helpers = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
registerRetryControlCases(test, helpers);
