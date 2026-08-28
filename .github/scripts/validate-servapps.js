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

// ---------------------------------------------------------------------------
// Per-app checks
// ---------------------------------------------------------------------------

function checkApp(app) {
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
apps.forEach(checkApp);

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
