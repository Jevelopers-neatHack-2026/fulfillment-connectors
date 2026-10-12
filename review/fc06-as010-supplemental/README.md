# FC06-AS-010: supplemental replay for PR50

This is an executable handoff of the supplemental checks for [PR50](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/pull/50), not a second implementation of its fix. The implementation remains on its author's branch. No production source, package scripts, workflows, dependency pins or author-owned branch is changed here. Refs #11.

## Exact target and replay

Use the complete pure `tests/fixture-claim-retry.mjs` from commit `c1717e09f2d933782ef3a4b41205899fb9dceae1`. Its Git blob is `edafa5aa053d2c183eef13f68d1fd2408fd2f83c`; its SHA-256 is `43cf7ec11ce9e8ae74ee133a94a3887756b9b2f3e3d6e185a6bc95d4d6fbfe10` (10,988 bytes). The source is not duplicated into this publication.

With that commit available in an existing repository checkout:

```sh
# Preparation example; Git network acquisition is separate from the offline check.
git show c1717e09f2d933782ef3a4b41205899fb9dceae1:tests/fixture-claim-retry.mjs > /tmp/fc-pr50-helper.mjs
# From a checkout containing these review files:
env -i PATH="$PATH" node review/fc06-as010-supplemental/run.mjs /tmp/fc-pr50-helper.mjs
```

The runner verifies both source digests **before importing the candidate** and imports those exact in-memory bytes, not a subsequent reread of a mutable path. The pinned module has no relative imports. A different source revision is refused, not silently recertified. This is a local review harness, not a trusted-host sandbox launcher, credentials boundary or permission to execute a provider request.

The 43 synthetic controls exercise raw fractional cutoffs, invalid/backward clocks, start/completion/stop chronology, elapsed/count consistency, one-shot and storage-busy behavior, and a deliberately broken cutoff policy. A timely-started claim may finish after the cutoff; this remains a next-outer-attempt-start policy. A clock fault after a claim invalidates the evidence; it does not prove the claim had no effect or grant a retry.

## Results and preserved failures

[receipt.json](receipt.json) distinguishes the historical checks from this publication's execution. The historical archive is the conversation handoff `PR50-supplemental-evidence.zip`, SHA-256 `259bcef9331f77c8e857672c5a933e0caca529faf0f795434382c0c501581b65`; it is not claimed to be a publicly hosted artifact. Its 61 manifest entries were reverified before preparing this publication.

The old main helper failed 34 of these 43 controls. The first cross-check of PR50 failed 11 test assertions because the supplemental suite expected `fixture_invalid_clock`, while PR50 declares `fixture_clock_invalid`. Only those two repeated assertion literals were adapted; the PR50 helper was unchanged. The adapted check passed 43/43, the inherited cutoff control passed 1/1, and a historical socket-denied run passed 44/44 (the same 43 plus one actual EPERM control, not 44 additional cases). The author of PR50 has a different 43-test suite and baseline; do not combine their counts.

For this publication, the first Node launch failed because a constructed PATH omitted the installed nvm directory; no tests ran in that attempt. With only the actual existing PATH passed, the new runner passed 43/43 with no skips and empty stderr on Node22.16.0. Both JavaScript syntax checks passed. A source prefixed with a synthetic file-marker side effect was rejected with exit1 and no marker creation, proving that candidate code was not imported after a digest mismatch. The earlier failure is retained in the receipt, not counted as a pass.

## Limits and integration

Node22.16.0 is **not** the repository's pinned Node24.21.0/npm11.19.0 profile. No full native storage/concurrency/restart suite, package build, entire-PR review, canonical consumer conformance or provider operation was run locally in this publication. Existing foundation CI is independent; it does not automatically run this manual replay harness. These checks do not stand in for that CI or certify a different merge candidate.

Required next steps are the owning maintainer's review, actual candidate correspondence and required checks, independent whole-PR review under repository policy, an eligible normal merge, and verification of actual main. This publication neither grants that approval nor broadens PR50's scope. FC-06.1-4, FUL-03, issue11, gate16 and epic1 remain unresolved by this evidence. No public schema, API, production state, financial authority or live/sandbox grant is changed.
