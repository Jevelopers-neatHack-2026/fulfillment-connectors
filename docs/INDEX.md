# Documentation index

Local tests make no provider calls. The authenticated Prodigi smoke command makes one request and requires separate explicit owner approval.

## Runtime and operations
- [Runtime and test commands](runtime.md) documents package exports, injected ports, modes, verification suites and gates.
- [Provider matrix](provider-matrix.md) is the source of truth for selection and sandbox/live readiness.
- [Simulator](simulator.md), [catalog](catalog.md), [quotes](quotes.md), [comparison](comparison.md), [attempt store](attempt-store.md), and [status](status.md) describe offline behavior and recovery limits.

## Authorization and artifacts
- [ProductionBundle consumer](production-bundle.md) describes bundle pin and inspection requirements.
- [Order authorization](order-authorization.md) distinguishes the fixture-tested simulated consumer from app-server conformance and acceptance.
- [Key management](key-management.md) documents owner-delegated secret handling. Do not store credentials in repository files or fixtures.
- [Security](security.md), [metering](metering.md), and [PNG inspection](png-inspection.md) describe safe data and evidence boundaries.

## Prodigi guides
[Product Details](prodigi-product-details.md) describes the offline decoder. [Prodigi sandbox](prodigi-sandbox.md) is owner-gated; do not run its one-request smoke command without the separate approval and decision evidence it specifies. [Callbacks](prodigi-callbacks.md) describes offline validation; fixtures do not establish authentic callbacks or account testing.

See [ownership](architecture/OWNERSHIP.md) and [acceptance allocation](architecture/ACCEPTANCE.md).
