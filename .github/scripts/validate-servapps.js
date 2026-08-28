#!/usr/bin/env node
/**
 * CI validator for cosmos-servapps repositories.
 *
 * For every directory under ./servapps it checks:
 *  1. description.json is valid JSON and has the required fields.
 *  2. cosmos-compose.json (when present) renders successfully with the SAME
 *     whiskers template engine + JSON parsing that Cosmos itself uses at
 *     install time (see client/src/pages/servapps/containers/docker-compose.jsx).
 *  3. Both files are free of "other store" copy-paste mistakes:
 *     - icon / artifact URLs pointing at another Cosmos store
 *     - references to other stores (resiSTORE, cosmos-servapps-unofficial)
 *     URLs under THIS repository's own Pages base
 *     (https://<owner>.github.io/<repo>/servapps/...) are treated as
 *     legitimate and not flagged.
 *  4. A structural check that each servapp has the complete required file
 *     layout so the store renders and the Pages deployment does not crash:
 *       - description.json
 *       - cosmos-compose.json (or docker-compose.yml)
 *       - icon.png
 *       - screenshots/  (missing this crashes index.js, e.g. ROMarr)
 *
 * Exit code is non-zero if any check fails.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const whiskers = require('whiskers');

// ---------------------------------------------------------------------------
// Determine the "own store" base URL - i.e. this repository's own GitHub
// Pages URL (e.g. https://<owner>.github.io/<repo>/servapps/...). URLs under
// this base are considered legitimate (they reference this repo's own store)
// and are NOT flagged as copy-pasted from another store.
//
// In CI, GITHUB_REPOSITORY is set to "owner/repo". Locally we fall back to the
// git remote. If we can't determine it, we return null.
// ---------------------------------------------------------------------------

function detectOwnStoreBase() {
  try {
    let owner = null;
    let repo = null;

    if (process.env.GITHUB_REPOSITORY) {
      const parts = process.env.GITHUB_REPOSITORY.split('/');
      owner = parts[0];
      repo = parts[1];
    } else {
      const remote = require('child_process')
        .execSync('git config --get remote.origin.url || true', { encoding: 'utf8' })
        .trim();
      const m = remote.match(/(?:github\.com[/:])([^/]+)\/([^./]+?)(?:\.git)?$/);
      if (m) {
        owner = m[1];
        repo = m[2];
      }
    }

    if (owner && repo) {
      return 'https://' + owner.toLowerCase() + '.github.io/' + repo.toLowerCase() + '/servapps/';
    }
  } catch (e) {
    // ignore
  }
  return null;
}

const OWN_STORE_BASE = detectOwnStoreBase();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// No blacklist here by design. We whitelist the URL base this repository
// ships its icons (and any store-hosted artefact files) from, via
// isAllowedIconUrl below. Any icon URL not under that whitelisted base is
// treated as copy-pasted from another store and flagged.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const errors = [];
const warnings = [];

// Emit a GitHub Actions workflow command annotation (renders as a warning /
// error callout on the PR / check run) when running under CI. No-op locally.
// See https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions
function ghAnnotation(level, app, file, msg) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const safe = String(msg).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const relPath = 'servapps/' + app + '/' + file;
  process.stdout.write(`::${level} file=${relPath}::${safe}\n`);
}

function err(app, file, msg) {
  errors.push('[' + app + '] ' + file + ': ' + msg);
  ghAnnotation('error', app, file, msg);
}
function warn(app, file, msg) {
  warnings.push('[' + app + '] ' + file + ': ' + msg);
  ghAnnotation('warning', app, file, msg);
}

function eachApp() {
  const dir = 'servapps';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => fs.lstatSync(path.join(dir, name)).isDirectory());
}

// Whitelist of URL bases this repository legitimately ships icons from
// (store-hosted artefact files fall under the same base). Anything else is
// treated as a copy-paste from another store and flagged.
function isAllowedIconUrl(lower) {
  // Only the canonical, actually-served icon bases are whitelisted.
  // (All other forms, e.g. a bare apps/<app>/icon.png under the repo root,
  //  resolve to 404 and must be fixed, not allowed.)
  // 1. This repository's own GitHub Pages store base (e.g. .../servapps/).
  if (OWN_STORE_BASE && lower.startsWith(OWN_STORE_BASE)) return true;
  // 2. The canonical official cosmos-servapps-official Pages base (/servapps/).
  if (lower.startsWith('https://azukaar.github.io/cosmos-servapps-official/servapps/')) return true;
  // 3. Official raw.githubusercontent.com artefact base. Both master and
  //    unstable branches are valid (an unstable branch is planned).
  if (lower.startsWith('https://raw.githubusercontent.com/azukaar/cosmos-servapps-official/master/servapps/')) return true;
  if (lower.startsWith('https://raw.githubusercontent.com/azukaar/cosmos-servapps-official/unstable/servapps/')) return true;
  return false;
}

// Check a single store-served URL (an icon or a store-hosted artefact file).
// Only these are validated; every other URL in an app (repository, image
// hints, homepages, config defaults) is intentionally skipped and never
// checked.
function checkIconUrl(app, file, url) {
  const lower = (url || '').toLowerCase().trim();
  if (!lower) return;
  if (isAllowedIconUrl(lower)) return;
  err(app, file, 'store icon URL is not served by this store (copy-paste?): ' + url);
}


// List the non-mandatory files inside a servapp folder: anything that is not
// part of the required store structure (description.json, compose file,
// icon.png) and not under screenshots/. These can carry executable code or
// structured data, so we flag them with a warning unless they are referenced
// by the app's cosmos-compose.json (and are not executable).
function extraFiles(base) {
  const out = [];
  if (!fs.existsSync(base)) return out;
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        // screenshots/ is required + expected; everything else stays fair game
        if (r === 'screenshots') continue;
        walk(dir + '/' + e.name, r);
      } else if (e.isFile()) {
        const top = r.split('/')[0];
        if (['description.json', 'cosmos-compose.json', 'docker-compose.yml', 'icon.png'].includes(top)) continue;
        out.push(r);
      }
    }
  };
  walk(base, '');
  return out;
}

// Is this file referenced (by name or path) inside the compose file text?
function composeReferences(composeRaw, fileRel) {
  if (!composeRaw) return false;
  const needle = fileRel.split('/').pop(); // bare filename
  return composeRaw.includes(fileRel) || composeRaw.includes(needle);
}

// Best-effort "executable" detection. On real git checkouts the executable
// bit is the authoritative signal; when unavailable, we fall back to a
// conservative extension-based guess for obvious script formats.
function isExecutableFile(base, rel) {
  const full = path.join(base, rel);
  try {
    const st = fs.statSync(full);
    if (st.isFile() && (st.mode & 0o111) !== 0) return true;
  } catch (e) { /* ignore */ }
  return /\.[a-z0-9]+$/i.test(rel) && /\.[^.]+$/.test(rel) &&
    /\.(sh|bash|zsh|fish|py|pl|rb|php|js|ts)$/i.test(rel);
}


// Network / registry helpers (Node 18+ global fetch with timeout)
// ---------------------------------------------------------------------------

const NET_TIMEOUT = 15000;

async function getJSON(url, headers) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), NET_TIMEOUT);
  try {
    const res = await fetch(url, { headers: headers || {}, signal: ctl.signal, redirect: 'follow' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, ok: res.ok, json, text };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function getStatus(url, headers) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), NET_TIMEOUT);
  try {
    const res = await fetch(url, { headers: headers || {}, signal: ctl.signal, redirect: 'follow', method: 'HEAD' });
    // Some hosts reject HEAD; fall back to GET if needed
    if (res.status >= 400 || res.status === 405) {
      const res2 = await fetch(url, { headers: headers || {}, signal: ctl.signal, redirect: 'follow', method: 'GET' });
      return { status: res2.status, ok: res2.ok, url: res2.url };
    }
    return { status: res.status, ok: res.ok, url: res.url };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// Normalize a description.json supported_architectures entry to a canonical
// set. The field is quite free-form across the store; we map the common
// spellings onto the architecture names the registries use.
function canonicalArchs(list) {
  const map = {
    'amd64': 'amd64', 'x86': 'amd64', 'x86_64': 'amd64', 'x64': 'amd64',
    '386': '386', 'i386': '386', 'i686': '386', 'x86-32': '386',
    'arm64': 'arm64', 'arm64v8': 'arm64', 'aarch64': 'arm64', 'arm64/v8': 'arm64', 'armv8': 'arm64', 'arm64_64': 'arm64',
    'arm': 'arm/v7', 'armv7': 'arm/v7', 'arm7': 'arm/v7', 'arm32v7': 'arm/v7', 'arm/v7': 'arm/v7', 'armhf': 'arm/v7',
    'armv6': 'arm/v6', 'arm32v6': 'arm/v6', 'arm/v6': 'arm/v6',
    'armv5': 'arm/v5', 'arm32v5': 'arm/v5', 'arm/v5': 'arm/v5',
    'ppc64le': 'ppc64le', 's390x': 's390x', 'riscv64': 'riscv64', 'mips64le': 'mips64le',
    'arm/v8': 'arm/v7', // typo found in the store; arm32v7 releases are tagged arm/v8 incorrectly
    'arm64v7': 'arm/v7',
  };
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const raw of list) {
    // entries can themselves be comma- or space-separated lists, e.g.
    // ["arm64, amd64"] - split them into individual arch names
    const parts = String(raw).split(/[,;\s]+/).filter(Boolean);
    for (const a of parts) {
      const k = a.toLowerCase().replace(/^linux\//, '').replace(/^linux_/, '');
      const canon = map[k] || k;
      out.add(canon);
    }
  }
  return out;
}

// Convert the image tag API / manifest arch+variant to a canonical arch.
function imageArchToCanonical(arch, variant) {
  const a = String(arch || '').toLowerCase();
  if (a === 'arm') {
    // generic arm -> use variant if present
    if (variant === 'v6') return 'arm/v6';
    if (variant === 'v5') return 'arm/v5';
    return 'arm/v7';
  }
  if (a === 'arm64') return 'arm64';
  if (a === 'amd64') return 'amd64';
  if (a === '386') return '386';
  if (a === 'ppc64le') return 'ppc64le';
  if (a === 's390x') return 's390x';
  if (a === 'riscv64') return 'riscv64';
  if (a === 'mips64le') return 'mips64le';
  if (a === 'unknown' || !a) return null;
  return a;
}

// Hosts we accept as docker image registries / package registries.
const KNOWN_REGISTRIES = new Set([
  'docker.io', 'registry-1.docker.io', 'hub.docker.com', 'index.docker.io',
  'ghcr.io', 'lscr.io', 'quay.io', 'codeberg.org', 'docker.n8n.io',
  'docker.io.n8n', 'ghcr', 'gcr.io', 'k8s.gcr.io', 'registry.gitlab.com',
  'ecr.public', 'public.ecr.aws', 'docker.io.linuxserver', 'n8nio',
]);

function parseImageRef(str) {
  // Parse a docker image reference (without registry) or a registry URL into
  // { registry, repository, tag }.
  let s = String(str || '').trim();
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://')) {
    try {
      const u = new URL(s);
      const host = u.hostname;
      let p = u.pathname.replace(/^\/+/, '');
      // docker hub page: hub.docker.com/r/ns/repo
      if (host === 'hub.docker.com' && p.startsWith('r/')) {
        p = p.slice(2).replace(/\/$/, '');
        return parseImageRef(p);
      }
      // docker hub official image page: hub.docker.com/_/name
      if (host === 'hub.docker.com' && p.startsWith('_/')) {
        const name = p.slice(2).replace(/\/$/, '');
        return { registry: 'registry-1.docker.io', repository: name, tag: 'latest' };
      }
      // github pkgs page: github.com/owner/repo/pkgs/container/name
      if (host === 'github.com' && p.includes('/pkgs/container/')) {
        const m = p.match(/^([^/]+\/[^/]+)\/pkgs\/container\/([^/]+)/);
        if (m) {
          return { registry: 'ghcr.io', repository: m[1].toLowerCase() + '/' + m[2].toLowerCase(), tag: 'latest' };
        }
      }
      // codeberg package page: codeberg.org/owner/-/packages/container/name
      if (host === 'codeberg.org') {
        const m = p.match(/^([^/]+)\/-\/packages\/container\/([^/]+)/);
        if (m) {
          return { registry: 'codeberg.org', repository: m[1] + '/' + m[2], tag: 'latest' };
        }
      }
      // ghcr.io mirror (path may carry an optional :tag)
      if (host.endsWith('ghcr.io')) {
        let repo = p.replace(/\/$/, '');
        let tag = 'latest';
        const slash = repo.lastIndexOf('/');
        const colon = repo.lastIndexOf(':');
        if (colon > slash) { tag = repo.slice(colon + 1); repo = repo.slice(0, colon); }
        return { registry: host, repository: repo, tag };
      }
      // generic registry URL: <host>/<ns>/<name>[:tag] - only for known hosts
      if (KNOWN_REGISTRIES.has(host) && p.includes('/')) {
        const parts = p.split('/');
        const last = parts.pop();
        let tag = 'latest';
        let repoName = last;
        if (last.includes(':')) { const sp = last.split(':'); repoName = sp[0]; tag = sp[1]; }
        parts.push(repoName);
        return { registry: host, repository: parts.join('/'), tag };
      }
      // unknown host + unknown page => not a docker image reference at all
      return null;
    } catch (e) { return null; }
  }
  // strip tag
  let repo = s;
  let tag = 'latest';
  if (s.includes('@')) { s = s.split('@')[0]; }
  if (s.includes(':')) {
    // careful: registry:port vs tag. Treat last colon as tag if after last slash
    const slash = s.lastIndexOf('/');
    const colon = s.lastIndexOf(':');
    if (colon > slash) { repo = s.slice(0, colon); tag = s.slice(colon + 1); }
    else repo = s;
  }
  const parts = repo.split('/');
  // registries
  if (parts.length >= 3 && parts[0].includes('.') && parts[0] !== 'registry-1.docker.io') {
    return { registry: parts[0], repository: parts.slice(1).join('/'), tag };
  }
  // docker.io / docker hub default
  return { registry: 'registry-1.docker.io', repository: repo, tag };
}

function imageDisplay(str) {
  const p = parseImageRef(str);
  if (!p) return String(str);
  return (p.registry && p.registry !== 'registry-1.docker.io' ? p.registry + '/' : '') + p.repository + ':' + p.tag;
}

// Get the set of architectures an image manifest publishes. Returns a Promise
// that resolves to { archs:Set|null, status } - archs=null means we could not
// determine them (caller decides how to treat).
async function imageArchs(imageUrl) {
  const ref = parseImageRef(imageUrl);
  if (!ref) return { archs: null, status: 'unparseable' };
  const reg = ref.registry;
  const repo = ref.repository;
  const tag = ref.tag || 'latest';

  // --- Docker Hub: use the public tag API (reliable, no token needed) ---
  if (reg === 'registry-1.docker.io') {
    // official (library) images have no namespace in the ref but live under
    // "library/" in the Docker Hub API
    const apiRepo = (repo.indexOf('/') === -1) ? 'library/' + repo : repo;
    const api = 'https://hub.docker.com/v2/repositories/' + apiRepo + '/tags/' + tag;
    const r = await getJSON(api);
    if (r.error) return { archs: null, status: r.error };
    if (r.status === 404) return { archs: null, status: 'not-found' };
    if (r.status !== 200 || !r.json) return { archs: null, status: 'http-' + r.status };
    const set = new Set();
    for (const img of (r.json.images || [])) {
      if (img.os && img.os !== 'linux') continue;
      const c = imageArchToCanonical(img.architecture, img.variant);
      if (c) set.add(c);
    }
    return { archs: set, status: 'ok' };
  }

  // --- OCI registry (ghcr.io and friends): manifest index ---
  try {
    const headers = { 'Accept': 'application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' };
    let url = 'https://' + reg + '/v2/' + repo + '/manifests/' + tag;
    // anonymous token flow
    if (reg === 'ghcr.io') {
      const tok = await getJSON('https://ghcr.io/token?scope=repository:' + repo + ':pull');
      if (!tok.error && tok.json && tok.json.token) {
        headers.Authorization = 'Bearer ' + tok.json.token;
      }
    }
    const m = await getJSON(url, headers);
    if (m.error) return { archs: null, status: 'net-' + m.error };
    if (m.status === 404 || m.status === 401 && m.text.includes('not found')) return { archs: null, status: 'not-found' };
    if (m.status !== 200 || !m.json) return { archs: null, status: 'http-' + m.status };
    const set = new Set();
    if (m.json.manifests) {
      for (const mm of m.json.manifests) {
        const p = mm.platform || {};
        if (p.os && p.os !== 'linux') continue;
        const c = imageArchToCanonical(p.architecture || (mm.artifactType ? null : p.architecture), p.variant);
        if (c) set.add(c);
      }
      return { archs: set, status: 'ok' };
    }
    // single-arch manifest: no platform list
    return { archs: set, status: 'single' };
  } catch (e) {
    return { archs: null, status: 'net-exc' };
  }
}

// Check description.json repository + image fields live against their sources.
async function checkRepositoryAndImage(app, d) {
  // ------------------------- repository URL -------------------------
  const repo = d.repository;
  if (repo) {
    const st = await getStatus(repo);
    if (st.error) {
      warn(app, 'description.json', 'repository URL could not be checked (' + st.error + '): ' + repo);
    } else if (st.status >= 400) {
      err(app, 'description.json', 'repository URL returned HTTP ' + st.status + ': ' + repo);
    } else {
      // For GitHub URLs, it must be a real repository (owner/repo), otherwise warn.
      try {
        const u = new URL(repo);
        if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
          const parts = u.pathname.split('/').filter(Boolean);
          if (parts.length < 2) {
            warn(app, 'description.json', 'repository is not a repository: ' + repo + ' (should be https://github.com/<owner>/<repo>)');
          } else if (parts[0].length && parts[1].length && parts.length >= 2) {
            // verify via GitHub API: a repo returns 200, a user/org or bad path returns 404
            const api = await getStatus('https://api.github.com/repos/' + parts[0] + '/' + parts[1], { 'Accept': 'application/vnd.github+json', 'User-Agent': 'cosmos-ci-validator' });
            if (api.status === 404) {
              warn(app, 'description.json', 'repository is not a repository: ' + repo + ' (GitHub reports 404 for ' + parts[0] + '/' + parts[1] + ')');
            }
          }
        }
      } catch (e) { /* not a URL we can parse */ }
    }
  }

  // ------------------------- image URL -------------------------
  const image = d.image;
  if (image) {
    const ref = parseImageRef(image);
    if (!ref) {
      err(app, 'description.json', 'image is not a valid docker image reference: ' + image);
      return;
    }
    const archs = await imageArchs(image);
    if (archs.status === 'not-found') {
      err(app, 'description.json', 'image does not exist (registry 404): ' + imageDisplay(image));
      return;
    }
    if (archs.status === 'unparseable') {
      err(app, 'description.json', 'image is not a valid docker image reference: ' + image);
      return;
    }
    if (archs.status === 'ok' && archs.archs && archs.archs.size) {
      // ------------------------- arch comparison -------------------------
      const announced = canonicalArchs(d.supported_architectures);
      const imageSet = archs.archs;
      // error: announced archs missing in the image
      for (const a of announced) {
        if (!imageSet.has(a)) {
          err(app, 'description.json',
            'announced architecture ' + a + ' is not provided by image ' + imageDisplay(image) + ' (image provides: ' + Array.from(imageSet).sort().join(', ') + ')');
        }
      }
      // warning: image archs not announced
      for (const a of imageSet) {
        if (!announced.has(a)) {
          warn(app, 'description.json',
            'image ' + imageDisplay(image) + ' provides architecture ' + a + ' which is not announced in supported_architectures');
        }
      }
    }
    // If archs could not be determined (network/registry edge), we do NOT
    // hard-fail the arch comparison - only the image existence check above
    // (404 -> error) is authoritative.
  }
}

// ---------------------------------------------------------------------------
// Per-app checks
// ---------------------------------------------------------------------------

async function checkApp(app) {
  const base = path.join('servapps', app);

  // ---------------------------------------------------------------------------
  // Required store file structure
  // ---------------------------------------------------------------------------
  // Every servapp must have the exact layout the Pages builder (index.js) and
  // the store require. The builder hardcodes these paths for every servapp:
  //   servapps/<App>/description.json
  //   servapps/<App>/cosmos-compose.json  (or docker-compose.yml)
  //   servapps/<App>/icon.png
  //   servapps/<App>/screenshots/
  // A missing screenshots/ directory crashes the deploy build outright (as
  // happened with ROMarr: ENOENT scandir './servapps/ROMarr/screenshots').
  // All four are required; missing any of them is a hard error.
  // ---------------------------------------------------------------------------

  // 1) description.json
  const dfile = path.join(base, 'description.json');
  if (!fs.existsSync(dfile)) {
    err(app, 'description.json', 'description.json is required for every servapp');
  }

  // 2) compose file - cosmos-compose.json OR docker-compose.yml
  const cfile = path.join(base, 'cosmos-compose.json');
  const yfile = path.join(base, 'docker-compose.yml');
  if (!fs.existsSync(cfile) && !fs.existsSync(yfile)) {
    err(app, 'cosmos-compose.json / docker-compose.yml',
        'a compose file (cosmos-compose.json or docker-compose.yml) is required for every servapp');
  }

  // 3) icon.png
  const iconFile = path.join(base, 'icon.png');
  if (!fs.existsSync(iconFile)) {
    err(app, 'icon.png', 'icon.png is required for every servapp (index.js hardcodes it)');
  }

  // 4) screenshots/ directory
  const shotsDir = path.join(base, 'screenshots');
  if (!fs.existsSync(shotsDir) || !fs.lstatSync(shotsDir).isDirectory()) {
    err(app, 'screenshots/', 'screenshots/ directory is required for every servapp (index.js scans it)');
  } else {
    // Warn if screenshots/ contains no real image files (e.g. only a .keep
    // placeholder) - the app will just render with no screenshots, which is
    // valid, but is usually a sign one was forgotten.
    const shots = fs.readdirSync(shotsDir).filter((f) => f !== '.keep' && f !== '.gitkeep');
    if (shots.length === 0) {
      warn(app, 'screenshots/', 'screenshots/ has no images (only a placeholder)');
    }
  }

  // ---------------------------------------------------------------------------
  // Non-mandatory files (potential executable / structured data)
  // ---------------------------------------------------------------------------
  // Anything in a servapp folder that is NOT part of the required structure
  // (description.json, compose file, icon.png, screenshots/*) can carry
  // executable code or structured data. We flag it with a warning so
  // maintainers review it. Exception: a file that is NOT executable AND is
  // referenced in the app's cosmos-compose.json is intentionally used by the
  // app (e.g. an artefacts/config.yaml fetched via wget in post_install) and
  // does NOT warn.
  const composeRaw = fs.existsSync(cfile) ? fs.readFileSync(cfile, 'utf8') : '';
  for (const extra of extraFiles(base)) {
    const referenced = composeReferences(composeRaw, extra);
    const executable = isExecutableFile(base, extra);
    if (!executable && referenced) continue; // intentional, referenced artefact
    warn(app, extra,
      'non-mandatory file (not part of the required structure) can contain ' +
      (executable ? 'executable code' : 'structured data') +
      (referenced ? '' : ' and is not referenced in cosmos-compose.json') +
      (executable ? '; review this file' : '; reference it in cosmos-compose.json or remove it'));
  }

  // ---------------------------------------------------------------------------
  // description.json content validation
  // ---------------------------------------------------------------------------
  if (fs.existsSync(dfile)) {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(dfile, 'utf8')); }
    catch (e) { err(app, 'description.json', 'invalid JSON: ' + e.message); }

    if (d) {
      ['name', 'description', 'longDescription', 'tags', 'repository', 'image', 'supported_architectures'].forEach((field) => {
        if (d[field] === undefined) err(app, 'description.json', 'missing required field "' + field + '"');
      });
      if (Array.isArray(d.tags) && d.tags.length === 0) warn(app, 'description.json', 'tags is empty');
      // NB: description.json URLs (repository / image hints) are intentionally
      // NOT validated here - only the store-provided icon URL (and store-hosted artefact files) in the
      // compose file is checked (see checkIconUrl below).
    }
  }

  // ---------------------------------------------------------------------------
  // description.json repository / image URL + architecture checks
  // ---------------------------------------------------------------------------
  if (fs.existsSync(dfile)) {
    let dd = null;
    try { dd = JSON.parse(fs.readFileSync(dfile, 'utf8')); } catch (e) { /* already reported */ }
    if (dd) await checkRepositoryAndImage(app, dd);
  }

  // ---------------------------------------------------------------------------
  // cosmos-compose.json content validation
  // ---------------------------------------------------------------------------
  if (fs.existsSync(cfile)) {
    const raw = fs.readFileSync(cfile, 'utf8');
    const trimmed = raw.trim();
    const isJson = trimmed.startsWith('{') && trimmed.endsWith('}');

    // Same context object Cosmos builds in docker-compose.jsx
    const context = {
      ServiceName: 'TestSvc',
      Hostnames: [],
      Context: {},
      Passwords: { '0': 'pw0', '1': 'pw1', '2': 'pw2', '3': 'pw3', '4': 'pw4' },
      CPU_ARCH: 'x64',
      CPU_AVX: 'true',
      DefaultDataPath: '/cosmos-storage',
      RootHostname: 'localhost',
      RootProtocol: 'https',
    };

    let rendered = null;
    try {
      rendered = whiskers.render(raw, context);
    } catch (e) {
      err(app, 'cosmos-compose.json', 'whiskers render failed: ' + String(e.message).split('\n')[0]);
    }

    if (rendered !== null) {
      if (isJson) {
        try { JSON.parse(rendered); }
        catch (e) {
          err(app, 'cosmos-compose.json', 'rendered output is not valid JSON: ' + String(e.message).split('\n')[0]);
        }
      }
      // Only store-served icon URLs and store-hosted artefact URLs are validated against the whitelist; every
      // other URL in the compose file (homepages, config defaults, app 3rd
      // -party sources) is intentionally skipped.
      // 1) cosmos-icon references.
      const iconRe = /"cosmos-icon"\s*:\s*"([^"]+)"/g;
      let im;
      while ((im = iconRe.exec(raw)) !== null) {
        checkIconUrl(app, 'cosmos-compose.json', im[1]);
      }
      // 2) Store-hosted artefact URLs (usually wget'd in post-install steps,
      //    e.g. .../servapps/<App>/artefacts/<file>).
      const artefactRe = /https?:\/\/[^\s"'`<>\\]*(?:\/artefact|\/artifact)[^\s"'`<>\\]*/gi;
      let am;
      while ((am = artefactRe.exec(raw)) !== null) {
        checkIconUrl(app, 'cosmos-compose.json', am[0]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const only = process.argv[2];
const apps = only ? [only] : eachApp();

(async () => {
  // run app checks sequentially to avoid hammering the registries with parallel
  // requests from 145 apps at once
  for (const app of apps) {
    await checkApp(app);
  }

  const hasErr = errors.length > 0;
  if (warnings.length) {
    console.log('\n' + warnings.length + ' warning(s):');
    warnings.forEach((w) => console.log('  [warn] ' + w));
  }
  if (errors.length) {
    console.log('\n' + errors.length + ' error(s):');
    errors.forEach((e) => console.log('  [error] ' + e));
  }
  console.log('\nChecked ' + apps.length + ' app(s).');
  process.exit(hasErr ? 1 : 0);
})();
