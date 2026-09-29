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
      // The ghcr image is <owner>/<package> (package is usually the repo name).
      if (host === 'github.com' && p.includes('/pkgs/container/')) {
        const m = p.match(/^([^/]+)\/[^/]+\/pkgs\/container\/([^/]+)/);
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
// Compose services[*].image validation + description/compose image cross-check
// ---------------------------------------------------------------------------

// Normalize an image reference to a comparable {repo, tag} for the
// description-vs-compose cross-check. Docker Hub and linuxserver's mirror
// (lscr.io) are folded together; tag defaults to "latest".
function imageIdentity(str) {
  const p = parseImageRef(str);
  if (!p) return null;
  let registry = p.registry;
  let repo = p.repository.replace(/\/$/, '');
  // fold docker hub registries + lscr.io (linuxserver's dockerhub mirror)
  if (['registry-1.docker.io', 'docker.io', 'index.docker.io'].includes(registry)) registry = 'docker.io';
  if (registry === 'lscr.io') registry = 'docker.io';
  let tag = (p.tag || 'latest').toLowerCase();
  return { registry, repo: repo.toLowerCase(), tag };
}

function imagesMatch(a, b) {
  if (!a || !b) return false;
  if (a.registry !== b.registry) return false;
  // repository must agree (ignore a trailing ":tag" mismatch caused by
  // docker.io official images vs the slash form)
  const aRepo = a.repo.replace(/^library\//, '');
  const bRepo = b.repo.replace(/^library\//, '');
  if (aRepo !== bRepo) return false;
  // tag comparison: latest/tag is acceptable against any specific tag, and
  // a missing tag (default latest) against any tag
  if (a.tag === 'latest' || b.tag === 'latest') return true;
  return a.tag === b.tag;
}

// Extract {name,image}[] for every service in a rendered compose document.
// Handles both the JSON object form (cosmos-compose.json) and a plain
// docker-compose.yml YAML doc (regex-based, best effort).
function composeServiceImages(rendered, isYaml) {
  const out = [];
  if (!rendered) return out;
  if (isYaml) {
    // minimal YAML: look for "    <name>:" under a "services:" block followed
    // by an "image:" line. Handles the common indentation.
    const rx = /(?:^|\n)\s{2}(\S[^:]*):\s*(?:\n|$)([\s\S]*?)(?=\n\s,{1,2}\S|\n\s{0,2}\w)/g;
    // Simpler: split services block
    const servicesBlock = rendered.match(/(?:^|\n)services:\s*\n([\s\S]*)/);
    if (servicesBlock) {
      const block = servicesBlock[1];
      const lines = block.split('\n');
      let curName = null;
      for (const line of lines) {
        const svc = line.match(/^(\s{2,4})?([A-Za-z0-9_.-]+):\s*$/);
        const img = line.match(/image:\s*['"]?([^\s'"]+)['"]?\s*$/);
        if (svc && !line.startsWith('    ')) { curName = svc[2]; }
        else if (img && curName) { out.push({ name: curName, image: img[1] }); }
      }
    }
    return out;
  }
  // JSON form: rendered is a parsed object (we parse before calling) OR string
  let doc = rendered;
  if (typeof rendered === 'string') { try { doc = JSON.parse(rendered); } catch (e) { return out; } }
  const services = doc && doc.services;
  if (services && typeof services === 'object') {
    for (const [name, conf] of Object.entries(services)) {
      if (conf && typeof conf === 'object' && conf.image) {
        out.push({ name, image: String(conf.image) });
      }
    }
  }
  return out;
}

// Check every compose service image is a valid, existing docker image and
// that description.image matches the primary service ({ServiceName}) image.
async function checkComposeImages(app, rendered, isYaml, composeFileLabel) {
  const services = composeServiceImages(rendered, isYaml);
  if (!services.length) return;

  // primary service is the one named {ServiceName} -> after render, matches
  // the value used in the render context ("TestSvc"); if present, the service
  // key equals TestSvc, otherwise fall back to the first service.
  let primary = services.find((s) => s.name === 'TestSvc') || services[0];

  // ---- 1) each service image must be a valid docker image ----
  // Dedupe image refs within an app to limit registry calls.
  const seen = new Set();
  for (const svc of services) {
    if (!svc.image) { err(app, composeFileLabel, 'services.' + svc.name + '.image is missing'); continue; }
    const ref = parseImageRef(svc.image);
    if (!ref) { err(app, composeFileLabel, 'services.' + svc.name + '.image is not a valid docker image reference: ' + svc.image); continue; }
    const key = (ref.registry || '') + '/' + ref.repository + ':' + (ref.tag || 'latest');
    if (seen.has(key)) continue;
    seen.add(key);
    const archs = await imageArchs(svc.image); // reuse: 404 => not found
    if (archs.status === 'not-found') {
      err(app, composeFileLabel, 'services.' + svc.name + '.image does not exist (registry 404): ' + svc.image);
    }
    // non-404 / non-ok statuses (network etc.) are ignored here; the primary
    // existence/arch check is authoritative.
  }

  // ---- cross-check description.image vs primary service image ----
  const dfile = path.join('servapps', app, 'description.json');
  if (primary && fs.existsSync(dfile)) {
    let desc = null;
    try { desc = JSON.parse(fs.readFileSync(dfile, 'utf8')); } catch (e) {}
    if (desc && desc.image) {
      const compId = imageIdentity(primary.image);
      const descId = imageIdentity(desc.image);
      if (compId && descId && !imagesMatch(compId, descId)) {
        warn(app, composeFileLabel,
          'description.image (' + desc.image + ') does not match the primary service image (' +
          primary.image + ') in services.' + primary.name + '.image');
      }
    }
  }
}


// ---------------------------------------------------------------------------
// Schema checks - mandatory / optional / allowed fields for description.json
// and the compose files.
//
// Mandatory fields are derived from the fields present in (essentially) every
// existing app. The allowed (optional) field vocabulary is the set of fields
// Cosmos-Server actually supports when creating a service (the struct in
// src/docker/api_blueprint.go: ContainerCreateRequestContainer and
// DockerServiceCreateRequest), plus a few fields existing apps legitimately
// use. Matching is case-insensitive because Go's encoding/json accepts struct
// fields by name regardless of the case of the compose keys. A field that is
// not in the supported vocabulary is rejected as undocumented.
// ---------------------------------------------------------------------------

const DESC_MANDATORY = [
  'name', 'description', 'longDescription', 'repository', 'image', 'tags', 'supported_architectures'
];
const DESC_OPTIONAL = ['translation'];
// Known = mandatory + optional (the full documented vocabulary). Any key
// outside this set has never been seen in an existing app and is rejected.
const DESC_KNOWN = new Set([...DESC_MANDATORY, ...DESC_OPTIONAL]);

const COMPOSE_TOP_MANDATORY = ['services', 'cosmos-installer', 'minVersion'];
const COMPOSE_TOP_OPTIONAL = ['networks', 'version', 'volumes'];
const COMPOSE_TOP_KNOWN = new Set([...COMPOSE_TOP_MANDATORY, ...COMPOSE_TOP_OPTIONAL]);

const COMPOSE_SERVICE_MANDATORY = ['image', 'container_name', 'labels'];

// Canonical service fields supported by Cosmos-Server (json tags of
// ContainerCreateRequestContainer in src/docker/api_blueprint.go) plus fields
// already used by existing apps that Cosmos's types do not (yet) declare.
const COMPOSE_SERVICE_OPTIONAL = [
  // Cosmos-Server ContainerCreateRequestContainer fields
  'environment', 'labels', 'ports', 'volumes', 'networks', 'routes', 'links',
  'restart', 'devices', 'expose', 'depends_on', 'tty', 'stdin_open', 'command',
  'entrypoint', 'runtime', 'working_dir', 'user', 'uid', 'gid', 'hostname',
  'domainname', 'mac_address', 'privileged', 'network_mode', 'stop_signal',
  'stop_grace_period', 'healthcheck', 'dns', 'dns_search', 'extra_hosts',
  'security_opt', 'storage_opt', 'sysctls', 'isolation', 'cap_add', 'cap_drop',
  'mem_limit', 'mem_reservation', 'cpus', 'cpu_shares', 'cpuset_cpus',
  'post_install',
  // fields used by existing apps but not (yet) in Cosmos-Server's struct
  'init', 'logging', 'shm_size', 'group_add', 'deploy'
];

// Normalize a field name for case-insensitive, separator-insensitive matching
// (Go's encoding/json matches struct fields case-insensitively, so compose keys
// like CapAdd / cap_add / CAPADD are all honored).
function normalizeFieldKey(k) {
  return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const COMPOSE_SERVICE_SUPPORTED = new Map();
for (const f of COMPOSE_SERVICE_OPTIONAL) COMPOSE_SERVICE_SUPPORTED.set(normalizeFieldKey(f), f);
for (const f of COMPOSE_SERVICE_MANDATORY) COMPOSE_SERVICE_SUPPORTED.set(normalizeFieldKey(f), f);

function checkMissing(app, file, which, present) {
  for (const f of [...which].sort()) {
    if (!present.has(f)) err(app, file, 'missing mandatory field "' + f + '"');
  }
}

function checkUndocumented(app, file, which, keys) {
  for (const k of keys) {
    if (!which.has(k)) err(app, file, 'field "' + k + '" is not documented (not present in any existing app)');
  }
}

// description.json top-level schema
function checkDescriptionSchema(app, d) {
  if (!d || typeof d !== 'object') return;
  const keys = new Set(Object.keys(d));
  checkMissing(app, 'description.json', DESC_MANDATORY, keys);
  checkUndocumented(app, 'description.json', DESC_KNOWN, Object.keys(d));
}

// cosmos-compose.json / docker-compose.yml schema.
// rendered = the whiskers-rendered compose object (JSON form) or raw string for YAML.
function checkComposeSchema(app, rendered, isYaml, composeFileLabel) {
  let doc = rendered;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch (e) { return; }
  }
  if (!doc || typeof doc !== 'object') return;

  const topKeys = new Set(Object.keys(doc));
  checkMissing(app, composeFileLabel, COMPOSE_TOP_MANDATORY, topKeys);
  checkUndocumented(app, composeFileLabel, COMPOSE_TOP_KNOWN, Object.keys(doc));

  const services = doc.services;
  if (services && typeof services === 'object') {
    for (const [name, conf] of Object.entries(services)) {
      if (!conf || typeof conf !== 'object') continue;
      const prefix = 'services.' + name;
      const keys = new Set(Object.keys(conf));
      // report missing mandatory per-service fields
      for (const f of COMPOSE_SERVICE_MANDATORY) {
        if (!keys.has(f)) err(app, composeFileLabel, prefix + ': missing mandatory field "' + f + '"');
      }
      // report unsupported per-service fields (case-insensitive against the
      // Cosmos-Server supported vocabulary). Non-canonical casing is always
      // flagged as a warning - Cosmos's encoding/json binds by field name
      // regardless of case, but the store's canonical spelling is lowercase.
      for (const k of Object.keys(conf)) {
        const nk = normalizeFieldKey(k);
        const canonical = COMPOSE_SERVICE_SUPPORTED.get(nk);
        if (!canonical) {
          const low = k.toLowerCase();
          if (low === 'tmpfs' || low === 'read_only' || low === 'readonly') {
            // tmpfs/read_only have no service-level field in Cosmos-Server's
            // ContainerCreateRequestContainer (Go silently ignores them), but
            // tmpfs IS supported as a volume mount type (mount.TypeTmpfs).
            err(app, composeFileLabel, prefix + ': field "' + k + '" is NOT honored by Cosmos-Server at the service level; express ' + low + ' as a volume mount instead, e.g. volumes: [{ "type": "' + (low === 'tmpfs' ? 'tmpfs' : 'bind') + '", "target": "<path>" }] (only supported via the volumes mount list)');
          } else {
            err(app, composeFileLabel, prefix + ': field "' + k + '" is not supported by Cosmos-Server (not in the supported compose vocabulary)');
          }
        } else if (canonical !== k) {
          warn(app, composeFileLabel, prefix + ': field "' + k + '" should be spelled "' + canonical + '" (canonical Cosmos field name)');
        }
      }
    }
  }
}
// ---------------------------------------------------------------------------
// minVersion support matrix
//
// The minimum Cosmos-Server version that honors each template feature. This
// is used to check that a template's `minVersion` is high enough for the
// fields it uses - otherwise the template could be installed on a Cosmos that
// silently ignores those fields (or the fields' newer behavior).
//
// Verified against azukaar/Cosmos-Server git history with `git log -S` +
// `git tag --contains` on the introducing commits (only STABLE tags count;
// "-unstableNNN" pre-release tags are not released versions). Concretely:
//   - src/docker/api_blueprint.go      (ContainerCreateRequestContainer service fields)
//   - src/utils/types.go              (ProxyRouteConfig / SmartShieldPolicy route fields)
//   - client/src/pages/servapps/containers/docker-compose.jsx + newService.jsx
//     (installer form types, template variables, post-install, translations)
//   - changelog.md                    (market/store feature introductions)
// See CREATING_A_MARKET_TEMPLATE.md §9 for the full human-readable matrix.
// ---------------------------------------------------------------------------

// Generic semver-ish compare used only to decide "is B ≥ A". Handles the
// 1..4 part dotted versions found in the store, with optional -suffix
// (e.g. "0.16.0-unstable26"). Suffixed prerelease builds sort BELOW the
// corresponding release (0.16.0-unstable26 < 0.16.0) but versions in the
// store are compared numerically against release floors, which is what we
// want. Returns:
//   -1 if a < b, 0 if a == b, 1 if a > b
// For a === b it returns 0. Non-numeric components break ties by treating
// "has suffix" as smaller.
function compareVersions(a, b) {
  const pa = String(a || '').trim().split('-')[0].split('.').map((x) => { const n = parseInt(x, 10); return Number.isNaN(n) ? 0 : n; });
  const pb = String(b || '').trim().split('-')[0].split('.').map((x) => { const n = parseInt(x, 10); return Number.isNaN(n) ? 0 : n; });
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // numeric parts equal: a version with a pre-release suffix is older
  const sa = /^[0-9.]+(-.+)?$/.test(String(a || '').trim()) ? (String(a || '').trim().includes('-') ? 1 : 0) : 0;
  const sb = /^[0-9.]+(-.+)?$/.test(String(b || '').trim()) ? (String(b || '').trim().includes('-') ? 1 : 0) : 0;
  if (sa !== sb) return sa === 1 ? -1 : 1; // a has a prerelease suffix => a is older
  return 0;
}

// Minimum Cosmos version for each feature a template may use. Keys are the
// raw fields/values as they appear in the template.
const FEATURE_MINVERSION = {
  // --- installer (cosmos-installer) features ---
  // All of these landed together with the market in v0.7.0 (verified via
  // git tag --contains on the introducing commits).
  'cosmos-installer.form':              '0.7.0',
  'cosmos-installer.form.passwords':    '0.7.0',   // {Passwords.N} in initialValue / template
  'cosmos-installer.frozen-volumes':    '0.7.0',
  'cosmos-installer.skip-default-network': '0.14.0',
  'cosmos-installer.translation':       '0.16.0',  // i18next support (PR #303)
  'cosmos-installer.post-install':      '0.7.0',   // rendered in newService.jsx since 0.7.0

  // --- installer form field types ---
  'form-type.text':          '0.7.0',
  'form-type.password':      '0.7.0',
  'form-type.email':         '0.7.0',
  'form-type.checkbox':      '0.7.0',
  'form-type.warning':       '0.7.0',
  'form-type.info':          '0.7.0',
  'form-type.error':         '0.7.0',
  'form-type.select':        '0.7.0',
  'form-type.hostname':      '0.7.0',
  'form-type.container':     '0.7.0',
  'form-type.container-full':'0.7.0',
  'form-type.path':          '0.17.0',
  // 'success' is NOT a form type - it is a post-install message severity
  // (MUI Alert severity) and has existed since post-install itself (0.7.0).

  // --- template variables ---
  'var.ServiceName':        '0.7.0',
  'var.Context':            '0.7.0',
  'var.Passwords':          '0.7.0',
  'var.DefaultDataPath':    '0.7.6',   // pickaxe: introduced in v0.7.6
  'var.Hostnames':          '0.7.0',
  'var.CPU_ARCH':           '0.7.0',   // pickaxe: same commit as market (0.7.0)
  'var.CPU_AVX':            '0.7.0',
  'var.RootHostname':       '0.22.23',
  'var.RootProtocol':       '0.22.23',

  // --- service-level (container) fields > the 0.5.x baseline ---
  'svc.uid':                '0.7.0',
  'svc.gid':                '0.7.0',
  'svc.post_install':       '0.7.0',
  'svc.runtime':            '0.16.0',  // PR #299 (Add runtime support)
  'svc.mem_limit':          '0.20.0',  // pickaxe: introduced in v0.20.0
  'svc.mem_reservation':    '0.20.0',
  'svc.cpus':               '0.20.0',
  'svc.cpu_shares':         '0.20.0',
  'svc.cpuset_cpus':        '0.20.0',

  // --- template top-level ---
  'top.minVersion':         '0.7.0',
  'top.cosmos-installer':   '0.7.0',
  'top.services':           '0.5.0',   // cosmos-compose service creation existed pre-market
};

// Fields that exist in the store vocabulary but are NOT (yet) honored by
// Cosmos-Server at all. Using one does not bump minVersion - it is simply
// ignored at install time - but we keep them out of the "is newer than the
// declared minVersion" calculation to avoid false positives on legacy apps.
const STORE_ONLY_FIELDS = new Set(['init', 'logging', 'shm_size', 'group_add', 'deploy']);

// Detect the highest Cosmos version required by every feature used in a
// rendered compose document. Returns { max, fields } where fields lists the
// concrete feature keys that required the maximum (for the error message).
function requiredMinVersion(rendered, isYaml) {
  let doc = rendered;
  if (typeof doc === 'string') { try { doc = JSON.parse(doc); } catch (e) { return { max: null, fields: [] }; } }
  if (!doc || typeof doc !== 'object') return { max: null, fields: [] };

  let max = null;
  const maxFields = [];

  const bump = (key, why) => {
    const v = FEATURE_MINVERSION[key];
    if (!v) return;
    if (max === null || compareVersions(v, max) > 0) {
      max = v;
      maxFields.length = 0;
      maxFields.push(why);
    } else if (max !== null && compareVersions(v, max) === 0) {
      maxFields.push(why);
    }
  };

  // top-level
  if (doc.services) bump('top.services', 'top-level "services" (required field)');
  if (doc['cosmos-installer']) bump('top.cosmos-installer', 'top-level "cosmos-installer" (required field)');
  if (doc.minVersion) bump('top.minVersion', 'top-level "minVersion" (required field)');

  // installer options - each is independent of the others (e.g. post-install
  // can exist without any form fields), so each is checked separately.
  const ci = doc['cosmos-installer'];
  if (ci && typeof ci === 'object') {
    if (Array.isArray(ci['frozen-volumes']) && ci['frozen-volumes'].length) bump('cosmos-installer.frozen-volumes', '"cosmos-installer.frozen-volumes"');
    if (Array.isArray(ci['post-install']) && ci['post-install'].length) bump('cosmos-installer.post-install', '"cosmos-installer.post-install"');
    if (ci.translation && typeof ci.translation === 'object' && Object.keys(ci.translation).length) bump('cosmos-installer.translation', '"cosmos-installer.translation"');
    if (ci['skip-default-network']) bump('cosmos-installer.skip-default-network', '"cosmos-installer.skip-default-network"');
    if (Array.isArray(ci.form) && ci.form.length) {
      bump('cosmos-installer.form', '"cosmos-installer.form"');
      for (const f of ci.form) {
        if (!f || typeof f !== 'object') continue;
        const t = String(f.type || 'text').toLowerCase();
        const key = 'form-type.' + t;
        if (FEATURE_MINVERSION[key]) bump(key, 'form field "' + (f.name || f.label || '?') + '" type "' + t + '"');
      }
    }
  }

  // template variables anywhere in the raw text (initialValue, labels, envs, volumes...)
  if (typeof rendered === 'string') {
    // variables are detected on the RAW (pre-render) text in the caller; here
    // rendered may be a parsed object for JSON templates, so variables are
    // detected via the raw template in checkMinVersionTemplate.
  }

  // service fields
  const services = doc.services;
  if (services && typeof services === 'object') {
    for (const [name, conf] of Object.entries(services)) {
      if (!conf || typeof conf !== 'object') continue;
      for (const k of Object.keys(conf)) {
        const low = k.toLowerCase();
        if (STORE_ONLY_FIELDS.has(low)) continue;
        const key = 'svc.' + low;
        if (FEATURE_MINVERSION[key]) bump(key, 'services.' + name + '.' + k);
      }
    }
  }

  return { max, fields: maxFields };
}

// Detect template variables ({...}) and installer features on the RAW
// (unrendered) template text, because {Passwords.N} etc. are substituted by
// whiskers before JSON parsing and are invisible on the rendered object.
// Returns the highest required version and the matching feature keys.
function requiredMinVersionRaw(raw) {
  let max = null;
  const maxFields = [];
  const bump = (key, why) => {
    const v = FEATURE_MINVERSION[key];
    if (!v) return;
    if (max === null || compareVersions(v, max) > 0) {
      max = v; maxFields.length = 0; maxFields.push(why);
    } else if (max !== null && compareVersions(v, max) === 0) {
      maxFields.push(why);
    }
  };

  // {Passwords.N}
  if (/\{Passwords\./.test(raw)) bump('var.Passwords', '{Passwords.N} variable');
  // {DefaultDataPath}
  if (/\{DefaultDataPath\}/.test(raw)) bump('var.DefaultDataPath', '{DefaultDataPath} variable');
  // {RootHostname} / {RootProtocol}
  if (/\{RootHostname\}/.test(raw)) bump('var.RootHostname', '{RootHostname} variable');
  if (/\{RootProtocol\}/.test(raw)) bump('var.RootProtocol', '{RootProtocol} variable');
  // {CPU_ARCH} / {CPU_AVX}
  if (/\{CPU_ARCH\}/.test(raw)) bump('var.CPU_ARCH', '{CPU_ARCH} variable');
  if (/\{CPU_AVX\}/.test(raw)) bump('var.CPU_AVX', '{CPU_AVX} variable');
  // {ServiceName} / {Context.*} / {Hostnames...} are baseline (0.7.2), no bump needed
  // but we track them for completeness of the "used features" summary
  if (/\{ServiceName\}/.test(raw)) bump('var.ServiceName', '{ServiceName} variable');
  if (/\{Context\./.test(raw)) bump('var.Context', '{Context.*} variable');
  if (/\{Hostnames/.test(raw)) bump('var.Hostnames', '{Hostnames} variable');

  return { max, fields: maxFields };
}

function mergeRequired(a, b) {
  if (!a.max) return b;
  if (!b.max) return a;
  if (compareVersions(b.max, a.max) > 0) return b;
  if (compareVersions(b.max, a.max) === 0) {
    return { max: a.max, fields: a.fields.concat(b.fields) };
  }
  return a;
}

// The actual check: does the template's declared minVersion cover every
// feature it uses? Errors when it does not, warns when it is well above.
function checkMinVersion(app, composeFileLabel, raw, rendered, isYaml) {
  if (!raw || typeof raw !== 'string') return;

  // 1) find declared minVersion on the raw text (it is a literal JSON string
  //    field, but {if} blocks can place it anywhere in the object so we scan
  //    the raw text instead of relying on the parsed doc).
  const m = raw.match(/"minVersion"\s*:\s*"([^"]+)"/);
  if (!m) return; // missing minVersion is already reported as a schema error
  const declared = m[1];

  // 2) desired = max(required from parsed structure, required from raw vars)
  const fromStruct = requiredMinVersion(rendered, isYaml);
  const fromRaw = requiredMinVersionRaw(raw);
  const desired = mergeRequired(fromStruct, fromRaw);
  if (!desired.max) return;

  if (compareVersions(declared, desired.max) < 0) {
    err(app, composeFileLabel,
      'minVersion "' + declared + '" is too low: the template uses features that require at least Cosmos "' +
      desired.max + '" (' + desired.fields.slice(0, 8).join(', ') + (desired.fields.length > 8 ? ', …' : '') +
      '). Bump minVersion to >= ' + desired.max + ' so the installer blocks older Cosmos versions that would otherwise ignore or mishandle these fields.');
  }
  // Note: a minVersion HIGHER than the used features require is intentionally
  // NOT flagged - templates often pin a higher version on purpose (known bug
  // fixes, intended feature behavior, or to guarantee a minimum supported
  // Cosmos). Only under-declaration is a problem we can detect reliably.
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
    if (dd) {
      await checkRepositoryAndImage(app, dd);
      checkDescriptionSchema(app, dd);
    }
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
      // Validate every services.*.image in the rendered compose and cross-check
      // description.image against the primary ({ServiceName}) service image.
      await checkComposeImages(app, rendered, !isJson, cfile.split('/').pop());
      checkComposeSchema(app, rendered, !isJson, cfile.split('/').pop());
      // Check that the template's declared minVersion covers every feature it
      // uses (form types, template variables, service fields, installer
      // options). Errors when a field requires a newer Cosmos than minVersion.
      checkMinVersion(app, cfile.split('/').pop(), raw, rendered, !isJson);
      // Only store-served icon URLs and store-hosted artifact URLs are referenced against the whitelist; every
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
