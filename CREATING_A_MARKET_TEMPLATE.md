# Creating a Cosmos Market Template (a "Servapp")

This guide explains how to add an application to the official Cosmos store
(`azukaar/cosmos-servapps-official`) — and by extension to any third-party
Cosmos store. It documents the template format, every field the installer
understands, and **which minimum Cosmos version each field requires**
(`minVersion` semantics), cross-checked against the
[`azukaar/Cosmos-Server`](https://github.com/azukaar/Cosmos-Server) source.

> What Cosmos calls a **market template** is the per-application definition
> that appears in the marketplace. In this repository each application lives
> in its own folder under `servapps/<AppName>/` and is commonly called a
> **servapp**.

---

## 1. Repository layout

```
cosmos-servapps-official/
├── index.js                    # build script → generates index.json / servapps.json
├── config.json                 # points at the published market manifest
├── .github/
│   ├── scripts/validate-servapps.js   # CI validator (schema authority)
│   └── workflows/                    # Pages deploy + validation CI
└── servapps/
    └── <AppName>/
        ├── description.json          # REQUIRED — marketplace metadata
        ├── cosmos-compose.json       # REQUIRED — the template (or docker-compose.yml)
        ├── icon.png                  # REQUIRED — store icon (deploy hardcodes this path)
        ├── screenshots/              # REQUIRED — 1..n screenshots (missing dir crashes the build)
        │   ├── 1.png
        │   └── ...
        └── artefacts/                # OPTIONAL — extra files served verbatim (configs, etc.)
```

**Every servapp must have the full required layout** — `description.json`,
a compose file, `icon.png` and a `screenshots/` directory. The Pages build
script (`index.js`) hardcodes these paths; a missing `screenshots/`
directory crashes the whole deploy (e.g. ROMarr). The CI validator enforces
this on every pull request.

When both compose formats are present, **`cosmos-compose.json` wins**:
`index.js` first assigns the YAML URL, then overwrites it with the JSON URL
if the JSON file exists.

---

## 2. `description.json`

The marketplace card metadata. Valid JSON, no templating.

| Field | Required | Type | Notes |
|---|---|---|---|
| `name` | ✅ | string | Display name, e.g. `"Jellyfin"` |
| `description` | ✅ | string | Short tagline shown in the store |
| `longDescription` | ✅ | string | HTML renderable; supports `<p>`, `<br>`, links |
| `tags` | ✅ | string[] | Search keywords / category tags |
| `repository` | ✅ | string | Project source URL (validated against GitHub API for `github.com` URLs) |
| `image` | ✅ | string | Docker Hub page or image reference of the **primary** service |
| `supported_architectures` | ✅ | string[] | e.g. `["amd64", "arm64"]`; CI cross-checks against the real image manifest |
| `translation` | ❌ | object | Per-locale `{description, longDescription}` overrides |

Example:

```json
{
  "name": "Jellyfin",
  "description": "Free Software Media System that puts you in control...",
  "longDescription": "<p>Jellyfin is an open-source media system...</p>",
  "tags": ["media", "server", "streaming"],
  "repository": "https://github.com/jellyfin/jellyfin",
  "image": "https://hub.docker.com/r/linuxserver/jellyfin",
  "supported_architectures": ["amd64", "arm64"],
  "translation": {
    "de": { "description": "...", "longDescription": "<p>...</p>" },
    "fr": { "description": "...", "longDescription": "<p>...</p>" }
  }
}
```

Supported translation locales (from `src/market/update.go` in Cosmos-Server):
`en`, `de`, `de-CH`, `en-GB`, `cn`, `cn-TW`, `es`, `fr`, `hi`, `it`, `jp`,
`kr`, `nl`, `pl`, `pt`, `ru`, `tr`, `ar`, `en-FUNNYSHAKESPEARE`.

> CI checks `repository`/`image`/`supported_architectures` **live**: the
> repository URL must not 404 and the announced architectures must actually
> exist in the image manifest. Keep them accurate.

---

## 3. The compose template

This is the heart of a servapp. There are two supported formats:

1. **`cosmos-compose.json`** — a JSON document (with whiskers templating) natively
   understood by Cosmos. **Preferred.**
2. **`docker-compose.yml`** — a standard Compose YAML (with whiskers templating)
   converted by the client at install time (supported since 0.14.0).

Both are rendered with the **whiskers** templating engine
(`client/src/pages/servapps/containers/docker-compose.jsx`) **before** parsing,
so they can contain `{variables}` and `{if}…{/if}` conditionals — which is why
most real `cosmos-compose.json` files are *not* valid JSON on disk but become
valid JSON after rendering. CI renders each template with a test context before
parsing it.

### 3.1 Top-level keys

| Key | Required | Type | Notes |
|---|---|---|---|
| `cosmos-installer` | ✅ | object | Installer configuration (form, messages, i18n). May be `{}`. |
| `minVersion` | ✅ | string | **Minimum Cosmos version** required by this template. |
| `services` | ✅ | object | Map of service name → service definition. Normally a single `{ServiceName}` key. |
| `networks` | ❌ | object | Custom networks (auto-created). |
| `volumes` | ❌ | object | Named volumes (mostly auto-created from service volumes). |
| `version` | ❌ | string | Compose version string (ignored). |

### 3.2 `minVersion` — the version gate

`minVersion` is **mandatory** (the CI validator hard-fails without it) and is
checked **client-side** against the running Cosmos version at install time:

```js
// docker-compose.jsx
const isNewerVersion = (minver) => cmp(version, minver) === -1;
...
{(installerInit && service.minVersion && isNewerVersion(service.minVersion)) ?
  <Alert severity="error">{t('mgmt.servApps.newContainer.cosmosOutdatedError')}</Alert>
```

If the installed Cosmos version is *older* than `minVersion`, the install
button is replaced by an error: *"This service requires a newer version of
Cosmos. Please update Cosmos to install this service."*

**Rule of thumb:** set `minVersion` to the **highest** version required by any
feature you use (see the support matrix in §5). When in doubt, check what the
field needs — using a feature on an older Cosmos silently ignores it or breaks
installation.

> ⚠️ `minVersion` is compared against the **Cosmos** version — read from
> `client/package.json` — not against a template or app version.

### 3.3 The `services` object

The service map keys are template variables referenced by the rest of the
template. The canonical pattern is a single service under `{ServiceName}`:

```jsonc
"services": {
  "{ServiceName}": {
    "image": "owner/app:latest",             // REQUIRED
    "container_name": "{ServiceName}",       // REQUIRED
    "labels": {                              // REQUIRED
      "cosmos-force-network-secured": "true",
      "cosmos-auto-update": "true",
      "cosmos-icon": "https://azukaar.github.io/cosmos-servapps-official/servapps/MyApp/icon.png"
    },
    "restart": "unless-stopped",
    "environment": ["KEY=value", "OTHER={Context.fieldName}"],
    "volumes": [
      { "source": "{ServiceName}-data", "target": "/data", "type": "volume" },
      { "source": "{Context.hostPath}", "target": "/media", "type": "bind" }
    ],
    "routes": [
      {
        "name": "{ServiceName}",
        "description": "Expose {ServiceName} to the web",
        "useHost": true,
        "target": "http://{ServiceName}:8080",
        "mode": "SERVAPP"
      }
    ]
  }
}
```

Per-service keys supported by Cosmos-Server
(`ContainerCreateRequestContainer` in `src/docker/api_blueprint.go` + client
conversions in `docker-compose.jsx`):

| Key | Required | Since | Notes |
|---|---|---|---|
| `image` | ✅ | all | Docker image reference. Validated live by CI. |
| `container_name` | ✅ | all | Usually `{ServiceName}`. Client auto-fills if missing (0.22.19+). |
| `labels` | ✅ | all | Docker labels; `cosmos-*` labels drive Cosmos features (icon, auto-update, force-secured). |
| `environment` | ❌ | all | Array of `KEY=value` strings (or map in YAML — converted). |
| `volumes` | ❌ | all | Array of `{source, target, type}` objects; `type` ∈ `volume`, `bind`, `tmpfs`. |
| `ports` | ❌ | all | Array of `host:container[/proto]` strings. |
| `networks` | ❌ | all | Map of network name → config; or array (converted). |
| `routes` | ❌ | all | Array of route objects (see below). |
| `restart` | ❌ | all | Restart policy. |
| `devices` | ❌ | all | Device mappings. |
| `expose` | ❌ | all | Exposed ports. |
| `depends_on` | ❌ | all | Map/array of dependencies. |
| `tty` / `stdin_open` | ❌ | all | Interactive flags (bool). |
| `command` / `entrypoint` | ❌ | all | String or array (converted). |
| `working_dir` | ❌ | all | |
| `user` | ❌ | all | |
| `hostname` / `domainname` | ❌ | all | |
| `mac_address` | ❌ | all | |
| `privileged` | ❌ | all | bool |
| `network_mode` | ❌ | all | `host`, `service:x`, etc. |
| `stop_signal` / `stop_grace_period` | ❌ | all | |
| `healthcheck` | ❌ | all | `{test, interval, timeout, retries, start_period}` (durations converted from `30s`/`30`). |
| `dns` / `dns_search` | ❌ | all | |
| `extra_hosts` | ❌ | all | |
| `security_opt` | ❌ | all | |
| `storage_opt` / `sysctls` | ❌ | all | |
| `isolation` | ❌ | all | |
| `cap_add` / `cap_drop` | ❌ | all | |
| `uid` / `gid` | ❌ | 0.7.0 | Numeric UID/GID for the container user. |
| `runtime` | ❌ | 0.16.0 | Container runtime (e.g. `nvidia`). Added in PR #299. |
| `mem_limit` / `mem_reservation` | ❌ | 0.20.0 | Memory constraints. |
| `cpus` / `cpu_shares` / `cpuset_cpus` | ❌ | 0.20.0 | CPU constraints. |
| `post_install` | ❌ | 0.7.0 | Service-level post-install (less used than installer-level `post-install`). |
| `init` / `logging` / `shm_size` / `group_add` / `deploy` | ❌ | ⚠️ | Used by existing store apps but **not** in Cosmos-Server's struct; accepted by CI validator as legacy but not guaranteed honored. |

The CI validator enforces the *exact set* of supported keys
(`COMPOSE_SERVICE_MANDATORY` / `COMPOSE_SERVICE_OPTIONAL`) and flags unknown
fields. It **warns on non-canonical casing** (`CapAdd` → `cap_add`) and
**errors** on service-level `tmpfs`/`read_only`/`readonly` (they are only
honored as volume mount types).

### 3.4 `cosmos-installer` — the install wizard

Optional (may be `{}`), but when present it drives the interactive install
dialog. All sub-keys and their support versions:

| Key | Required | Since | Notes |
|---|---|---|---|
| `form` | ❌ | 0.7.0 | Array of form field definitions shown before install. |
| `post-install` | ❌ | 0.7.0 | Array of messages shown after successful install (rendered in `newService.jsx` since 0.7.0). |
| `translation` | ❌ | 0.16.0 | UI-string overrides per locale (i18next, PR #303). |
| `frozen-volumes` | ❌ | 0.7.0 | Volume sources the user cannot customize in the form. |
| `skip-default-network` | ❌ | 0.14.0 | Skip auto-creating the default `cosmos-<name>-default` network. |

#### Form fields

Each entry in `form`:

| Key | Required | Type | Notes |
|---|---|---|---|
| `name` | ✅ | string | Context key → referenced as `{Context.<name>}`. |
| `label` | ✅ | string | Shown to the user. Can embed variables. |
| `type` | ✅ | string | See form types below. Missing → treated as text. |
| `initialValue` | ❌ | any | Default value. Usually a string; supports `{DefaultDataPath}`, `{Passwords.N}`, etc. |
| `options` | ❌ | [string,string][] | For `type: "select"` — `[value, label]` pairs. |
| `name-container` | ❌ | string | For `type: "container"`/`container-full` — secondary context key that receives the selected container name. |

Supported form types (verified against docker-compose.jsx at each tag):

| Type | Since | Renders as | Notes |
|---|---|---|---|
| `text` | 0.7.0 | Text field | Default. |
| `password` | 0.7.0 | Password field | Value stays available as `{Context.<name>}`. |
| `email` | 0.7.0 | Email field | |
| `checkbox` | 0.7.0 | Checkbox | Combine with `{if Context.<name>}` conditionals. |
| `warning` | 0.7.0 | Warning alert | `label` shown; no input. |
| `info` | 0.7.0 | Info alert | |
| `error` | 0.7.0 | Error alert | |
| `select` | 0.7.0 | Dropdown | `options: [[value,label],…]`. |
| `hostname` | 0.7.0 | Text + hostname checker | |
| `container` | 0.7.0 | Container picker (name) | Writes to `name-container` key too. |
| `container-full` | 0.7.0 | Container picker (full) | |
| `path` | 0.17.0 | Folder picker + text | |
| `success` | 0.7.0 | Success alert | *Not a form type* — it is a valid `post-install` message severity (MUI Alert), rendered via `Alert severity={m.type}` in `newService.jsx` since 0.7.0. |

> ✅ **Correcting a common misconception:** `select`, `container`,
> `container-full`, `hostname`, `name-container` and `frozen-volumes` all
> existed **already in v0.7.0** (the first release with the market and
> `cosmos-installer`). Only `path` is newer (0.17.0); `skip-default-network`
> arrived in 0.14.0.

### 3.5 `post-install` messages

```jsonc
"post-install": [
  {
    "type": "warning",        // "info" | "warning" | "success" | "error"
    "name": "accessData",     // optional key for translations
    "label": "Your app is at {RootProtocol}://{RootHostname}/ ..."
  }
]
```

Shown as `Alert` banners after the container is created. Localizable via
`cosmos-installer.translation.<locale>["post-install.<name>.label"]`.

### 3.6 Translations inside the template

```jsonc
"translation": {
  "de": {
    "form.myField.label": "Wie heißt Ihr Pfad?",
    "post-install.accessData.label": "Ihre Zugangsdaten: ..."
  },
  "fr": { "form.myField.label": "Quel est votre chemin ?" }
}
```

The client resolves `translation?.[resolvedLanguage]?.[key]` first, then
`translation?.[resolvedLanguage.substr(0,2)]?.[key]`, falling back to the
hardcoded `label`. This is supported in the template and in `description.json`
**since 0.16.0** (i18next, PR #303).

### 3.7 Template variables (whiskers context)

The client renders templates with this context (`docker-compose.jsx`):

| Variable | Value | Since |
|---|---|---|
| `{ServiceName}` | Chosen service name | 0.7.0 |
| `{Context.<name>}` | Form field values | 0.7.0 |
| `{Passwords.0}` … `{Passwords.4}` | Auto-generated strong passwords | 0.7.0 |
| `{DefaultDataPath}` | Cosmos data path (config `DockerConfig.DefaultDataPath`, default `/cosmos-storage`) | 0.7.6 |
| `{RootHostname}` | Server hostname / config `HTTPConfig.Hostname` | 0.22.23 |
| `{RootProtocol}` | `http` or `https` (from `HTTPSCertificateMode`) | 0.22.23 |
| `{Hostnames}` | Computed route hostnames (`{Hostnames.<svc>.<route>.host}`) | 0.7.0 |
| `{CPU_ARCH}` | Client CPU architecture | 0.7.0 |
| `{CPU_AVX}` | Whether CPU supports AVX | 0.7.0 |

`{if Context.<name>}` / `{if Context.<name> == 'value'}` / `{/if}` conditionals
work throughout the template:

```jsonc
{if Context.enableAdmin}
, { "source": "{Context.adminPath}", "target": "/admin", "type": "bind" }
{/if}
```

> 💡 Use `{Passwords.N}` for database/app secrets: strong passwords are
> generated per install and surfaced to the user in `post-install` labels.

### 3.8 Routes

Each route mirrors `utils.ProxyRouteConfig` in Cosmos-Server:

| Key | Required | Notes |
|---|---|---|
| `name` | ✅ | Route identifier (`{ServiceName}`, or `{ServiceName}-2`, …) |
| `target` | ✅ | Upstream URL, e.g. `http://{ServiceName}:8080` |
| `description` | ❌ | Shown in the UI |
| `useHost` | ❌ | `true` → adds a hostname input in the install dialog |
| `mode` | ❌ | `SERVAPP` (default for apps), `AUTH`, `HIDDEN`, `LOCAL`, `STREAM`, `BLOCK` |
| `Timeout` | ❌ | ms, e.g. `14400000` (Jellyfin transcodes) |
| `ThrottlePerMinute` | ❌ | Requests/min limit |
| `BlockCommonBots` | ❌ | bool |
| `SmartShield` | ❌ | `{Enabled: bool, PerUserRequestLimit: int, …}` |
| `AuthEnabled` | ❌ | bool |

All route fields shown above are supported by Cosmos-Server **since 0.5.x**;
newer proxy features (LB, tunnels, OIDC, extra headers) map to newer fields in
`ProxyRouteConfig` — check the target Cosmos release if you use them.

All route fields shown above are supported by Cosmos-Server **since 0.5.x**;
newer proxy features (LB, tunnels, OIDC, extra headers) map to newer fields in
`ProxyRouteConfig` — check the target Cosmos release if you use them.

> 🔑 **Route keys use PascalCase** (`SmartShield`, `BlockCommonBots`,
> `ThrottlePerMinute`, `Timeout`), **not** `smart_shield` / `block_common_bots`.
> The route struct (`ProxyRouteConfig`) only declares `yaml` tags, and the
> create-service endpoint decodes the request with Go's `encoding/json`, which
> falls back to matching the **Go field names** (case-insensitively) when no
> `json` tag exists. Service-level fields, by contrast, carry `json` tags and
> are spelled lowercase snake_case (`container_name`, `cap_add`, ...).

> `useHost: true` routes get a hostname field automatically during install and
> Cosmos fills `{Hostnames}` for you; `useHost: false` with a fixed `host` is
> also fine, but then all users share that hostname.

---

## 4. `docker-compose.yml` (alternative format)

If you prefer YAML, ship `docker-compose.yml` instead of
`cosmos-compose.json`. The client imports and **converts** it
(`convertDockerCompose()` in `docker-compose.jsx`): short volume/port/device
syntaxes → object form, durations → seconds, environment maps → arrays, YAML
`labels` arrays → maps, etc. The same whiskers variables, `cosmos-installer`
(with `x-cosmos-installer` or a `x-post-install` service extension) and route
objects apply.

Supported since **0.14.0**. CI supports it too (renders + parses both kinds),
and validates that `description.image` matches the primary service image.

---

## 5. `minVersion` decision table

**How to choose `minVersion`:** find every feature your template uses in the
table below, take the **highest** version, and use that. The installed Cosmos
version is read from `client/package.json` and compared with `semver-compare`.

| If your template uses… | minimum Cosmos version |
|---|---|
| Only basic `services` + one route | **0.7.0** (market launch) |
| `cosmos-installer` with `form` (text/password/email/checkbox/warning/info/error/select/hostname/container/container-full), `initialValue`, `frozen-volumes`, `post-install`, `{Passwords.N}`, `{Context.*}`, `{ServiceName}`, `{CPU_ARCH}`, `{CPU_AVX}` | **0.7.0** |
| `description.translation` / store-level translations | **0.16.0** |
| `docker-compose.yml` templates | **0.14.0** |
| `skip-default-network` | **0.14.0** |
| `cosmos-installer.translation` (form label i18n) | **0.16.0** |
| `runtime` service field | **0.16.0** |
| `path` (and `{DefaultDataPath}`=0.7.6) | **0.17.0** |
| `{RootHostname}` / `{RootProtocol}` | **0.22.23** |
| `mem_limit` / `mem_reservation` / `cpus` / `cpu_shares` / `cpuset_cpus` | **0.20.0** |
| Any newer `ProxyRouteConfig` field (LB, tunnels, OIDC, extra headers…) | Check the exact release that introduced it; when unsure, use a recent version (≥ 0.22.x) |

> The **store currently runs on Cosmos ≥ 0.23.x** (see `changelog.md`). Old
> templates still pin low values (e.g. `0.8.0`) because that's the highest
> version their features need — that's the correct approach; **don't** bump
> `minVersion` to the latest just because it's new. Only bump when you actually
> use a newer feature.

### Usage frequency in the official store

A scan of all 151 apps shows the actual `minVersion` values in use:

```
0.4.0 ██          0.7.6 ███████████████████  0.8.0 ████████████████████████████████████
0.9.0 ██████████████  0.10.3 █████  0.13.0 ████████████  0.16.0 ████████████
0.18.0 █  0.22.4 ████████  ...
```

The most common single value is `0.8.0`; `0.7.6`, `0.9.0`, `0.13.0`,
`0.16.0` and `0.22.4` are also frequent. For new templates, **the safest floor
is `0.8.0`** unless you need a newer feature.

---

## 6. The install flow (how templates are consumed)

1. User clicks **Install** in the market → `DockerComposeImport` opens with
   `dockerComposeInit` = the template URL; the client fetches the raw template.
2. The template is rendered with whiskers using the context from §3.7
   (`{ServiceName}`, `{Context.*}`, `{Passwords.*}`, `{DefaultDataPath}`,
   `{RootHostname}`, `{RootProtocol}`, `{Hostnames}`, `{CPU_ARCH}`,
   `{CPU_AVX}`).
3. JSON templates are parsed; YAML templates are converted via
   `convertDockerCompose()`.
4. If `cosmos-installer` is present, the install dialog renders its `form`
   fields (+ generated hostname fields for `useHost: true` routes) and the
   `minVersion` gate is checked — install is blocked if Cosmos is too old.
5. `cosmos-installer.post-install` messages are queued; volumes are
   auto-created; the default `cosmos-<name>-default` network is created
   unless `skip-default-network`.
6. On confirm, the client `POST /api/docker-service` with the rendered
   compose; the server (`api_blueprint.go`) creates networks, volumes,
   containers and routes, streaming progress logs.

---

## 7. CI validation & local checks

`.github/workflows/validate.yml` runs `.github/scripts/validate-servapps.js`
on every PR touching `servapps/**` (and on push to `master`/`unstable`, plus
`workflow_dispatch` for full validation). It checks:

1. **Structure** — every servapp dir has `description.json`, `icon.png`,
   `screenshots/` and a compose file (missing `screenshots/` is a hard error).
2. **description.json schema** — required fields, valid JSON, no unknown keys.
3. **Live checks** — `repository` URL not 404; image exists; announced
   `supported_architectures` ⊆ image manifest; primary compose service image
   matches `description.image`.
4. **Compose rendering** — whiskers-render with the same context Cosmos uses,
   then `JSON.parse` must succeed (for JSON templates).
5. **Compose schema** — top-level `services`/`cosmos-installer`/`minVersion`
   mandatory; every service has `image`/`container_name`/`labels`; all service
   fields in the supported vocabulary; canonical (lowercase) spellings.
6. **URL hygiene** — `cosmos-icon` + artifact URLs must be on the official
   store (or raw.githubusercontent.com) bases — catches copy-paste from other
   stores.
7. **Extra files** — non-mandatory files (e.g. `artefacts/` scripts) warn
   unless referenced by the compose file.
8. **`minVersion` vs used fields** — the validator detects every feature a
   template uses (form types, template variables, service/installer fields)
   and computes the minimum Cosmos version that honors them (see §9). If the
   template's `minVersion` is **lower** than what its own features require, it
   is a hard error: the app would be installable on a Cosmos that silently
   ignores those fields. A `minVersion` *higher* than required is **not**
   flagged — that is the author's choice (intentional feature floor).

Run locally:

```bash
npm install
npm run validate                  # all apps
node .github/scripts/validate-servapps.js MyApp   # single app
node index.js                     # regenerate index.json/servapps.json
```

---

## 8. Step-by-step checklist for a new servapp

- [ ] Create `servapps/<MyApp>/`.
- [ ] Add `icon.png` (square, e.g. 256×256).
- [ ] Add at least one image in `screenshots/` (1.png, 2.png, …).
- [ ] Add `description.json` with all 8 fields (see §2).
- [ ] Add `cosmos-compose.json` (preferred) with:
  - `cosmos-installer` (+ `form`, `post-install`, `translation` as needed),
  - `minVersion` (see §5 — use the highest required version),
  - `services` with `{ServiceName}`, `image`, `container_name`, `labels`
    (including `cosmos-icon`), volumes, routes.
- [ ] Use `{Passwords.N}` for secrets; surface them via `post-install`.
- [ ] Point `cosmos-icon` at the official store URL (or use a raw
  `raw.githubusercontent.com` URL — CI checks it).
- [ ] `npm install && npm run validate MyApp` passes.
- [ ] Test install in an actual Cosmos instance (optional but recommended).
- [ ] Open a PR; CI will validate the diff. Once merged, the Pages workflow
  auto-rebuilds the store.

---

## 9. Field support matrix — full reference

This is the complete data, verified against Cosmos-Server git history
(`src/docker/api_blueprint.go`, `src/utils/types.go`,
`client/src/pages/servapps/containers/docker-compose.jsx`, `changelog.md`).

> ⚙️ **Enforced by CI.** The validator's `FEATURE_MINVERSION` table in
> `.github/scripts/validate-servapps.js` mirrors this matrix and **fails CI**
> when a template's `minVersion` is lower than the highest version any used
> feature requires. Keep `minVersion` ≥ the largest "Min Cosmos" in the rows
> that apply to your template.

### description.json

| Field | Min Cosmos |
|---|---|
| `name`, `description`, `longDescription`, `tags`, `repository`, `image`, `supported_architectures` | 0.7.0 |
| `translation` | 0.7.0 |

### cosmos-compose.json top level

| Field | Min Cosmos | Required |
|---|---|---|
| `services` | 0.7.0 | ✅ |
| `cosmos-installer` | 0.7.0 | ✅ |
| `minVersion` | 0.7.0 | ✅ |
| `networks` / `volumes` / `version` | 0.7.0 | ❌ |

### cosmos-installer

| Field | Min Cosmos |
|---|---|
| `form`, `form[].name/label/type/initialValue/options/name-container` | 0.7.0 |
| `frozen-volumes` | 0.7.0 |
| `skip-default-network` | 0.14.0 |
| `translation` | 0.16.0 |
| `post-install` | 0.7.0 |

### Form types

| Type | Min Cosmos |
|---|---|
| `text` (default), `password`, `email`, `checkbox`, `warning`, `info`, `error`, `select`, `hostname`, `container`, `container-full` | 0.7.0 |
| `path` | 0.17.0 |
| `success` (post-install message severity) | 0.7.0 |

### services.* (container)

| Field(s) | Min Cosmos |
|---|---|
| `image`, `container_name`, `labels`, `environment`, `volumes`, `ports`, `networks`, `routes`, `restart`, `devices`, `expose`, `depends_on`, `tty`, `stdin_open`, `command`, `entrypoint`, `working_dir`, `user`, `hostname`, `domainname`, `mac_address`, `privileged`, `network_mode`, `stop_signal`, `stop_grace_period`, `healthcheck`, `dns`, `dns_search`, `extra_hosts`, `security_opt`, `storage_opt`, `sysctls`, `isolation`, `cap_add`, `cap_drop` | 0.5.x |
| `uid`, `gid` | 0.7.0 |
| `post_install` (service-level) | 0.7.0 |
| `runtime` | 0.16.0 |
| `mem_limit`, `mem_reservation`, `cpus`, `cpu_shares`, `cpuset_cpus` | 0.20.0 |
| `container_name` auto-fill when missing | 0.22.19 |
| `init`, `logging`, `shm_size`, `group_add`, `deploy` | ⚠️ not guaranteed (accepted by validator only) |

### Volume mount types

| Type | Min Cosmos |
|---|---|
| `volume` | 0.5.x |
| `bind` | 0.5.x |
| `tmpfs` | 0.5.x (as mount type only — not as a service field) |

### Template variables

| Variable | Min Cosmos |
|---|---|
| `{ServiceName}`, `{Context.*}`, `{Passwords.0..4}`, `{Hostnames.*}` | 0.7.0 |
| `{DefaultDataPath}` | 0.7.6 |
| `{CPU_ARCH}`, `{CPU_AVX}` | 0.7.0 |
| `{RootHostname}`, `{RootProtocol}` | 0.22.23 |

### Routes

| Field(s) | Min Cosmos |
|---|---|
| `name`, `description`, `useHost`, `host`, `usePathPrefix`, `pathPrefix`, `timeout`, `throttlePerMinute`, `corsOrigin`, `stripPathPrefix`, `authEnabled`, `adminOnly`, `target`, `mode`, `blockCommonBots`, `smartShield` | 0.5.x |
| `maxBandwidth`, `acceptInsecureHTTPSTarget`, `hideFromDashboard`, `disableHeaderHardening`, `spoofHostname`, `additionalFilters`, `restrictToConstellation`, `overwriteHostHeader`, `whitelistInboundIPs`, `icon`, `tunnel`, `extraHeaders`, `disableLegacyHTTPHeaders`, `skipURLClean`, `useH2C`, `lbMode`, `lbStickyMode`, `additionalTargets` | later (proxy evolution) — verify on target release |

---

## 10. Troubleshooting / common mistakes

| Symptom | Cause / Fix |
|---|---|
| CI: `field "x" is not documented` | Unknown service key. Use only the supported vocabulary (see §9) or remove. |
| CI: `field "X" should be spelled "x"` | Non-canonical casing. Go matches case-insensitively, but CI wants lowercase. |
| CI: `tmpfs/read_only` service field error | These only work as `volumes` mount types, not as service-level fields. |
| CI: `minVersion "x" is too low: ... requires at least Cosmos "y"` | Your template uses a feature that needs Cosmos ≥ `y` (e.g. `translation`/`runtime` = 0.16.0, `path` = 0.17.0, `mem_limit`/`cpus` = 0.20.0). Bump `minVersion` to ≥ `y`. See §9. |
| Install blocked: "requires a newer version of Cosmos" | `minVersion` too high (or Cosmos outdated). Set `minVersion` to the highest *needed* version, not latest. |
| CI render fail | Template isn't valid after whiskers render — check `{if}`/`{/if}` balance and JSON commas around conditionals. |
| Missing `screenshots/` crashes deploy | Every servapp dir must have `screenshots/` with ≥1 image. |
| `cosmos-icon` copy-paste error | Icon URL points at another store; use the official base. |
| Volume not created | Use object form `{source, target, type}`; named volumes are auto-created, but absolute/bind paths are not. |

---

*This document is maintained alongside the CI validator
(`.github/scripts/validate-servapps.js`); if you change the accepted schema,
update both.*
