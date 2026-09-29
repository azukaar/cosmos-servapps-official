# cosmos-servapps-official

The official application store (aka **market / servapps registry**) for
[Cosmos](https://github.com/azukaar/Cosmos-Server) — the self-hosted home
server platform. Every app in this repository appears in the Cosmos
marketplace and can be installed with a few clicks.

## Add an app to the store

Each application lives in its own directory under [`servapps/`](servapps)
and is defined by a `description.json` (store listing) plus a
`cosmos-compose.json` (or `docker-compose.yml`) template.

**New to writing templates? Read the full guide:** 👉
**[`CREATING_A_MARKET_TEMPLATE.md`](CREATING_A_MARKET_TEMPLATE.md)**

It covers:

- repository layout and required files (`description.json`, `icon.png`,
  `screenshots/`, compose template)
- the `cosmos-compose.json` / `docker-compose.yml` template format
- the `cosmos-installer` wizard (form fields, `post-install` messages,
  translations), whiskers variables and conditionals
- how to choose `minVersion` for each field, with a version-support matrix
  cross-checked against Cosmos-Server
- validation, testing, and the submission checklist

## Validation

Pull requests touching `servapps/**` are validated automatically by
`.github/scripts/validate-servapps.js` — it renders every template with the
same whiskers engine Cosmos uses, checks the schema, verifies images and
architecture support, and enforces that each template's `minVersion` covers
the fields it uses. See the [guide](CREATING_A_MARKET_TEMPLATE.md#7-ci-validation--local-checks)
for how to run it locally:

```bash
npm install
npm run validate            # all apps, or:
node .github/scripts/validate-servapps.js MyApp
```

## Deployment

Merges to `master` are published to GitHub Pages; the store is served from
`https://azukaar.github.io/cosmos-servapps-official/` and fetched by Cosmos'
marketplace.

## Useful links

- [Cosmos server](https://github.com/azukaar/Cosmos-Server) — the platform
  that consumes this store
- [`CREATING_A_MARKET_TEMPLATE.md`](CREATING_A_MARKET_TEMPLATE.md) — template
  authoring documentation
