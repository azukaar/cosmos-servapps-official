# LogForge Unicron on Cosmos

This package runs the Central appliance with Docker socket access for automatic
local agent deployment and appliance self-update. Install it, open `/unicron`
on its Cosmos URL, and add agents from Settings for the Docker hosts you want
to manage. Remote agents need a Central address and published mTLS port
reachable from their host. For manual enrollment, pull
`logforge/unicron-agent:latest` before running the generated enrollment command
so an older locally cached image is not reused.

## Docker access and updates

**Writable Docker socket access grants the Central appliance root-equivalent
control of the Cosmos Docker host. Enrolled agents also have root-equivalent
control of their Docker hosts.** Only grant LogForge administrator access to
trusted users. Authentication, reduced container capabilities, and
`no-new-privileges` do not constrain the authority of the host Docker daemon.

LogForge is a Docker administration application with monitoring and interactive
operations. Its access requirements differ by component:

- Central deploys local agents by pulling an image, creating a container with
  the required socket and host mounts, and starting it. Replacement enrollment
  can remove the previous agent container and reset its identity volume.
- The appliance updater inspects the running container, pulls an updated image,
  and creates a replacement preserving its mounts, networks, labels, ports,
  and security settings. It uses a handoff container to stop the old appliance
  and start the replacement; rollback also needs lifecycle access.
- Agents list and inspect containers, collect logs and metrics, start/stop/
  restart/remove containers, create and attach Docker exec sessions for
  terminals and scripts, and read container files through the archive API.

A read-only proxy would support some monitoring but prevent deployment,
updates, terminals, and write operations. A proxy can still deny unrelated API
sections; we do not claim that every Docker endpoint is needed or that a proxy
has no value. However, preserving local deployment and self-update requires
container creation with host mounts. Allowing that operation through an
API-section proxy retains a path to host-level control. Exec access to
privileged or socket-mounted containers can also reach host capabilities.

The [Tecnativa proxy](https://github.com/Tecnativa/docker-socket-proxy) controls
API sections and methods. Those controls do not validate the safety of a
container's requested mounts, privileges, or exec commands. Therefore, simply
inserting that proxy would not remove the root-equivalent trust requirement
while preserving the supported feature set. This package uses direct socket
access and discloses that requirement prominently. A narrower product mode or
request-aware authorization policy would be a separate design and validation
effort. Marketplace acceptance of this trust model remains the maintainers'
decision.

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
