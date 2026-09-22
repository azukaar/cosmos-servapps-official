# LogForge Unicron on Cosmos

This package runs the Central appliance without access to the host Docker
socket. Install it, open `/unicron` on its Cosmos URL, and manually enroll an
agent from Settings for each Docker host you want to monitor. Use the remote
enrollment flow even for the Cosmos host, with a Central address and the
published mTLS port reachable from that host. Pull
`logforge/unicron-agent:latest` before running the generated enrollment command
so an older locally cached image is not reused. Enrollment is a separate,
explicit host-administrator action.

## Docker access and updates

**Agents with writable Docker socket access have root-equivalent control of
their Docker hosts.** Terminals, file access, and automations execute through
these agents. Restrict LogForge administrator access and enroll only trusted
hosts. Removing Central's socket is not a sandbox for an enrolled agent, nor
does it prevent an authorized Central session from issuing agent commands.

Central has no socket mount or Docker API proxy, and
`UNICRON_SELF_UPDATE_ENABLED=false` disables its self-updater. Update the
appliance through Cosmos. Automatic local agent deployment from Central is
unavailable; manual enrollment remains supported. The Cosmos host is not
monitored automatically.

The review suggested Tecnativa's Docker socket proxy with container allow-list
and token authentication. Its [documented configuration](https://github.com/Tecnativa/docker-socket-proxy)
controls Docker API sections and HTTP methods; it does not provide that
per-container/token policy. Central's updater and automatic local deployment
require container creation, which would undermine the proposed restriction.
This package therefore removes that host access entirely instead of granting
write access through a proxy. Maintainers should review this alternative
against their marketplace policy.

## Cosmos compatibility and readiness

The [Cosmos service schema](https://github.com/azukaar/Cosmos-Server/blob/master/src/docker/api_blueprint.go)
does not honor service-level `read_only` or `tmpfs`. This package uses supported
Docker mount objects for `/tmp` (256 MiB, mode 1777) and `/run` (64 MiB, mode
0755). Cosmos's Docker 26 mount schema cannot request executable tmpfs, so
`/run/pyinstaller` uses a separate named volume for executable extraction.
This is disposable runtime storage, not application data; unlike tmpfs it
persists across container restarts. Application data remains in the separate
volume at `/var/lib/unicron`. The container root filesystem is writable;
capability restrictions and `no-new-privileges` remain enabled.

Readiness invokes the image's compiled
`/usr/local/bin/unicron-appliance-manager healthcheck` directly, without a
shell. Cosmos healthcheck durations are integer seconds: 30-second interval,
10-second timeout, 120-second startup grace, and three retries.

## Image and build verification

The appliance tag remains `logforge/unicron:3.0.0`. Agent enrollment explicitly
uses `logforge/unicron-agent:latest`. As of September 22, 2026, Docker Hub's
`latest` and `3.0.0` agent tags both resolve to
`sha256:328adfef3bb1efc02a26390591b2c68d282d4c0b6c1b5034ffda1d5aa3fea197`,
published September 15 for AMD64 and ARM64. A floating tag follows future
published builds; it does not update already-running agents automatically.

The appliance packages Python services with PyInstaller. The
[source repository](https://github.com/log-forge/unicron-source) includes build
recipes. This listing does not attest reproducible builds, source-to-image
equivalence, or SBOM availability. Verify release provenance, image digests,
and any SBOM supplied by the publisher independently.
