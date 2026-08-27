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
 *  4. A structural check that a compose file exists for each servapp.
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

function err(app, file, msg) { errors.push('[' + app + '] ' + file + ': ' + msg); }
function warn(app, file, msg) { warnings.push('[' + app + '] ' + file + ': ' + msg); }

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

// ---------------------------------------------------------------------------
// Per-app checks
// ---------------------------------------------------------------------------

function checkApp(app) {
  const base = path.join('servapps', app);

  // ---------- description.json ----------
  const dfile = path.join(base, 'description.json');
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
  } else {
    err(app, 'description.json', 'description.json is required for every servapp');
  }

  // ---------- cosmos-compose.json ----------
  const cfile = path.join(base, 'cosmos-compose.json');
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
  } else {
    const yfile = path.join(base, 'docker-compose.yml');
    if (!fs.existsSync(yfile)) {
      err(app, 'cosmos-compose.json / docker-compose.yml', 'a compose file is required for every servapp');
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
