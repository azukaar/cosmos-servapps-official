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
 *     - icon / artifact URLs pointing at another Cosmos store (e.g. a
 *       github-pages icon path) instead of this official one
 *     - references to other stores (resiSTORE, cosmos-servapps-unofficial)
 *  4. A structural check that a compose file exists for each servapp.
 *
 * Exit code is non-zero if any check fails.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const whiskers = require('whiskers');

// Other-store path markers - these indicate a different Cosmos store was
// copy-pasted from.
const OTHER_STORE_MARKERS = [
  /resiSTORE/i,
  /resi-store/i,
  /cosmos-servapps-unofficial/i,
  /cosmos-servapps-(?!official)/i,
  /servapps-experimental/i,
  /servapps-dev/i,
  /store-cosmos\.github\.io/i,
];

// Personal / other-store hostnames found in the wild.
const OTHER_STORE_HOSTS = [
  /\.github\.io\/comos\./i,
  /manhtuong/i,
];

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

function checkStoreUrls(app, file, text) {
  const urls = text.match(/https?:\/\/[^\s"'`<>\\]+/g) || [];
  for (const u of urls) {
    const lower = u.toLowerCase();
    for (const marker of OTHER_STORE_MARKERS) {
      if (marker.test(lower)) {
        if (lower.includes('azukaar.github.io/cosmos-servapps-official')) continue;
        err(app, file, 'URL looks copy-pasted from another store: ' + u);
        break;
      }
    }
    for (const hostRe of OTHER_STORE_HOSTS) {
      if (hostRe.test(lower)) {
        err(app, file, 'URL points at another store host: ' + u);
      }
    }
  }
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
      checkStoreUrls(app, 'description.json', JSON.stringify(d.repository || '') + ' ' + JSON.stringify(d.image || ''));
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
      checkStoreUrls(app, 'cosmos-compose.json', raw);
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