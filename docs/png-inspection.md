# Bounded PNG byte inspection

`inspectPngBytes` is a pure, read-only observer for an intentionally small PNG profile. It snapshots a genuine `Uint8Array`, computes the byte length and SHA-256 from that snapshot, checks the PNG signature and chunk CRCs, validates the supported chunk ordering, and bounds zlib inflation before reporting limited image facts. It never changes the caller’s bytes and never returns the byte contents.

The inspected profile is a static, noninterlaced RGB PNG with 8-bit samples, PNG compression/filter method 0, and only `IHDR`, contiguous `IDAT`, and terminal `IEND` chunks plus optional `sRGB` and `pHYs`. The observer checks that the concatenated IDAT stream inflates to the expected filtered scanline length and that each scanline filter byte is in the PNG-defined range 0–4. It does not reverse filters or reconstruct pixel values. Other valid PNG profiles and chunks return `unsupported`; unsupported results do not claim complete file validation.

The result reports raw `pHYs` pixels-per-unit values and computes a DPI equivalent only when the PNG unit is metres. A unit value of zero remains “unknown.” These are file observations, not print-resolution requirements. Optional expected content type, byte length, and `sha256:<hex>` arguments compare only those primitive values against the inspected bytes. They do not represent an approval, canonical binding, production bundle, or provider payload.

The module has fixed private resource limits: 20 MiB input, 4,096 chunks, 8,192 pixels per dimension, 16,777,216 total pixels, and at most 64 MiB of inflated scanline data. Oversized inputs and inflation are returned as typed resource-limit outcomes. The parser does not use an external image decoder or execute fixture-producing code.

The six pinned PNG fixtures are synthetic diagnostic renderer outputs copied from the print-production draft artifact recorded in `tests/fixtures/png-inspection/provenance.json`. They are useful as real byte samples for parser development, but they are not an approved fulfillment bundle; the provenance explicitly sets `handoffEligible` to `false`. No fixture or result establishes production eligibility or satisfies the broader FC-08 package-validation requirements.

The `package` suite reuses this decoder unchanged for the PNG print outputs of an owner-verified ProductionBundle ([ProductionBundle consumer](production-bundle.md)). The implementation targets the repository’s pinned Node.js 24.21.0 runtime and uses its synchronous zlib `maxOutputLength` option. The format rules are based on the [W3C PNG Third Edition](https://www.w3.org/TR/png-3/), including its chunk CRC and ordering rules, contiguous but arbitrarily split IDAT stream, and permitted unused trailing bytes in the final IDAT data. Node API behavior is documented in the [Node.js 24.21.0 zlib reference](https://nodejs.org/download/release/v24.21.0/docs/api/zlib.html).

The package root exports `inspectPngBytes`, `PNG_INSPECTION_LIMITS`, and the readonly result types. The focused suite imports the compiled module and emits a newline-terminated JSON report with one stable ID for each semantic case. The strict runner rejects malformed, partial, duplicate, extra, reordered, inconsistent, failed, skipped, signaled, nonzero, or stderr-producing child runs. Run it through the package script after installation:

```sh
npm run test:png-inspection
npm run verify:png-inspection
```

The verifier runs only in `simulated` mode and writes its result to the fixed, git-ignored `evidence/FC-08-10-PNG/result.json` destination under the checkout root. Relative and absolute destination arguments resolve to that same repository path regardless of the caller's working directory; a path outside the checkout is rejected. It rejects a substituted or symlinked destination and fails if the evidence write fails, while retaining the executed case records in its stdout failure result. This is a local observer test only; it does not run a provider or the legacy integration suites. It cannot validate an approved bundle, accepted canonical binding, print eligibility, or dispatch.
