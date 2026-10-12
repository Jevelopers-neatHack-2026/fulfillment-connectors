// Derives tests/fixtures/production-bundle/provenance.json PROGRAMMATICALLY from the real producer artifact bytes.
// Nothing in the output is typed by hand: every hash, size, ref and pin is computed or read from the artifact.
// usage: node tests/production-bundle-provenance-tool.mjs <artifactDir> <artifactZip> <custodyReceipt.json> <runId> <artifactId> <outFile>
//          [--supersedes <oldProvenance.json> <oldArtifactDir> <supersededFixtureDir> <oldSourceDescription>]
// With --supersedes the previous preferred input is recorded BY DIGEST AND SOURCE (never deleted from history), the per-path delta between the two
// corpora is computed from bytes, and it is cross-checked against the producer receipt's own `changesFromEarlierCorpus` claim.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [artifactDir, artifactZip, receiptPath, runId, artifactId, outFile, ...rest] = process.argv.slice(2);
const supersedeArgs = rest[0] === "--supersedes" ? rest.slice(1) : null;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const files = Object.fromEntries(walk(artifactDir).map((path) => {
  const bytes = readFileSync(path);
  return [relative(artifactDir, path), { size: bytes.length, sha256: sha(bytes) }];
}));
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
const receiptEntries = receipt.entries.map((entry) => ({ path: entry.path.replace(/^/, ""), size: entry.size, sha256: entry.sha256 }));
const mismatches = receiptEntries.filter((entry) => files[entry.path]?.sha256 !== entry.sha256 || files[entry.path]?.size !== entry.size).map((entry) => entry.path);
const unlisted = Object.keys(files).filter((path) => !receiptEntries.some((entry) => entry.path === path));
if (mismatches.length !== 0 || receiptEntries.length !== 64 || Object.keys(files).length !== 65 || unlisted.join() !== "CORPUS.json") {
  throw new Error(`artifact does not match custody receipt: ${JSON.stringify({ mismatches, entries: receiptEntries.length, files: Object.keys(files).length, unlisted })}`);
}
const corpus = JSON.parse(readFileSync(join(artifactDir, "CORPUS.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(artifactDir, "bundle/manifest.json"), "utf8"));
const commitment = JSON.parse(readFileSync(join(artifactDir, "bundle/trusted-commitment.json"), "utf8"));
const kind = (path) => path === "CORPUS.json" ? "corpus-json" : path === "bundle/trusted-commitment.json" ? "control" : path.startsWith("bundle/") ? "baseline" : "variant";
const pins = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, value]) => ({ path, kind: kind(path), size: value.size, sha256: value.sha256 }));
const counts = pins.reduce((acc, pin) => ({ ...acc, [pin.kind]: (acc[pin.kind] ?? 0) + 1 }), {});
const refs = Object.fromEntries(["spec_ref", "capability_ref", "composition_ref", "facts_ref", "template_ref", "approval_ref", "handoff_ref", "renderer_ref", "lineage_ref"].map((key) => [key, manifest[key]]));
const extra = readFileSync(join(artifactDir, "variants/extra-file/extra.bin"));
const out = {
  schema: "fulfillment-production-bundle-fixture-provenance/1",
  note: "Synthetic, unaccepted producer diagnostic corpus. Not an approved ProductionBundle, no approval, no supplier eligibility, no order authority.",
  synthetic: corpus.synthetic,
  accepted: corpus.accepted,
  handoffEligible: corpus.handoffEligible,
  finance_receipt: corpus.finance_receipt,
  canonical_usage_intake: corpus.canonical_usage_intake,
  usage_refs: corpus.usage_refs,
  producer: {
    repository: "Jevelopers-neatHack-2026/print-production",
    revision: corpus.production_revision,
    linuxRun: Number(runId),
    artifactId: Number(artifactId),
    artifactName: "pp16-bundle-handoff-1",
    artifactZipSha256: sha(readFileSync(artifactZip)),
    corpusJsonSha256: files["CORPUS.json"].sha256,
    runtime: corpus.runtime
  },
  sharedContractsPin: corpus.shared_contracts_pin,
  counts: { regularFiles: Object.keys(files).length, receiptEntries: receiptEntries.length, byKind: counts },
  bundle: { id: commitment.bundle_ref.id, revision: commitment.bundle_ref.revision, hash: commitment.bundle_ref.content_hash, schemaVersion: manifest.schema_version },
  scope: { tenant_id: manifest.tenant_id, project_id: manifest.project_id },
  trustedCommitment: { name: "trusted-commitment.json", ...files["bundle/trusted-commitment.json"] },
  manifestRefs: refs,
  composedPreviewHash: manifest.composition.composed_preview_hash,
  rowScope: manifest.row_scope,
  extraBin: { literal: new TextDecoder().decode(extra), length: extra.length, sha256: sha(extra) },
  pins
};
if (supersedeArgs !== null) {
  const [oldProvenancePath, oldArtifactDir, supersededFixtureDir, oldSource] = supersedeArgs;
  const oldBytes = readFileSync(oldProvenancePath);
  const old = JSON.parse(oldBytes.toString("utf8"));
  const oldFiles = Object.fromEntries(walk(oldArtifactDir).map((path) => [relative(oldArtifactDir, path), sha(readFileSync(path))]));
  const oldMatches = old.pins.every((pin) => oldFiles[pin.path] === pin.sha256) && old.pins.length === Object.keys(oldFiles).length;
  if (!oldMatches) throw new Error("the superseded artifact directory does not match the superseded provenance");
  const paths = [...new Set([...Object.keys(oldFiles), ...Object.keys(files)])].sort();
  const changed = paths.filter((path) => oldFiles[path] !== files[path]?.sha256);
  const unchanged = paths.filter((path) => oldFiles[path] === files[path]?.sha256);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const claimed = [...(receipt.changesFromEarlierCorpus ?? [])].sort();
  const keptFiles = walk(supersededFixtureDir).map((path) => ({ path: relative(supersededFixtureDir, path), size: readFileSync(path).length, sha256: sha(readFileSync(path)) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const kept of keptFiles) {
    const original = oldFiles[kept.path === "trusted-commitment.json" ? "bundle/trusted-commitment.json" : `bundle/${kept.path}`];
    if (original !== kept.sha256) throw new Error(`kept superseded file ${kept.path} is not a byte copy of the superseded artifact`);
  }
  out.supersedes = {
    note: "The previous preferred input, recorded by digest and source. Its bytes remain in the superseded artifact directory and in git history; only the files in keptFiles are kept in-tree, for anchor/bundle cross-binding negatives.",
    source: oldSource,
    provenanceSha256: sha(oldBytes),
    producerRevision: old.producer.revision,
    linuxRun: old.producer.linuxRun,
    artifactId: old.producer.artifactId,
    artifactZipSha256: old.producer.artifactZipSha256,
    corpusJsonSha256: old.producer.corpusJsonSha256,
    bundle: old.bundle,
    trustedCommitment: old.trustedCommitment,
    sharedContractsPinUnchanged: JSON.stringify(old.sharedContractsPin) === JSON.stringify(corpus.shared_contracts_pin) || (old.sharedContractsPin.archive_sha256 === corpus.shared_contracts_pin.archive_sha256 && old.sharedContractsPin.integrity === corpus.shared_contracts_pin.integrity),
    delta: { changed, unchanged },
    deltaMatchesReceiptChangesFromEarlierCorpus: JSON.stringify(changed) === JSON.stringify(claimed),
    keptFiles
  };
  if (!out.supersedes.deltaMatchesReceiptChangesFromEarlierCorpus) throw new Error("the computed delta differs from the producer receipt's changesFromEarlierCorpus");
}
writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ wrote: outFile, pins: pins.length, counts }));
