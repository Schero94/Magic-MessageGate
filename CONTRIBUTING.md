# Contributing to Magic MessageGate

Thanks for helping. Issues and pull requests go to
[github.com/Schero94/Magic-MessageGate](https://github.com/Schero94/Magic-MessageGate/issues).
Report security problems privately through
[a security advisory](https://github.com/Schero94/Magic-MessageGate/security/advisories/new), not in a public issue.

## Setup

```bash
npm ci
npm rebuild better-sqlite3   # only needed when you installed with --ignore-scripts
```

Node.js `^22.21.0` or `>=24.9.0`. The design decisions are in [CONCEPT.md](./CONCEPT.md), the API contract for
integrations and coding agents in [AGENTS.md](./AGENTS.md).

## Checks before a pull request

```bash
npm run lint
npm run format:check
npm test          # unit tests, provider contract tests with local fakes, 8 processes on SQLite
npm run test:pg   # 8 processes on PostgreSQL; set MG_TEST_PG_URL (default postgres://strapi@127.0.0.1:5440/mg_test)
npm run test:admin # admin entry points in React StrictMode (jsdom, fake network)
npm run build     # also runs the server bundle runtime check
npm run verify
npm pack --dry-run
npm audit --omit=dev
```

CI runs the same steps on Node 22, 24 and 26, the build and tests again with the lowest supported Strapi (5.38.0, the `peerDependencies` floor), `test:pg` against PostgreSQL 16, and the admin StrictMode tests against React 19 (informational; the peer range stays React 18).

Rules:

- Read the official docs of the version you use before calling a provider API (Meta Cloud API, Telegram Bot API,
  seven.io, Twilio) and cite them in the pull request.
- No vendor SDKs. Providers are reached through the small `fetch` adapters in `server/src/adapters`.
- New dependencies must be actively maintained. Dependabot waits 7 days (14 for majors) before it proposes a release.
- Never log or return phone numbers, tokens or message text. Tests use synthetic data only (`+49155501…`,
  `example.test`).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/); `feat` and `fix` trigger a
  release.

## 8-process acceptance run

`scripts/cluster-acceptance.mjs` proves the outbox and webhooks on eight Strapi processes (two groups of four) behind a
non-sticky balancer, all on one PostgreSQL database, with local fake providers. It checks:

- 500 sends are each delivered exactly once, and 50 replays with the same idempotency key send nothing;
- status webhooks in random order to random processes end at `read`;
- error 131026 falls back to SMS and marks the contact as not on WhatsApp;
- a STOP received by one process blocks the next send on another process;
- the maintenance job is held by exactly one process.

1. Create a Strapi 5.61 app outside this repository, install the packed plugin and build the admin:

   ```bash
   npm pack                                  # in this repo
   npx create-strapi-app@5.61 ../mg-cluster-app --no-run --skip-cloud --js --use-npm
   cd ../mg-cluster-app && npm install pg ../Magic-MessageGate/strapi-plugin-magic-messagegate-*.tgz
   ```

2. Create a PostgreSQL database whose name starts with `mg_`, for example `createdb mg_cluster`.
3. Run it from this repository:

   ```bash
   node scripts/cluster-acceptance.mjs --app ../mg-cluster-app \
     --pg postgres://strapi@127.0.0.1:5440/mg_cluster --write-config --reset
   (cd ../mg-cluster-app && NODE_ENV=production npx strapi build)   # first run only, after --write-config
   ```

   `--write-config` copies `scripts/cluster/app-config/*` into the app's `config/` folder (providers point at the fake
   server). `--reset` drops and recreates the database's `public` schema, so only use a throwaway database.

Safety: secrets are generated per run and never printed, outgoing network is blocked in every process, the runner
refuses busy ports and the reserved workbench ports (1337, 1338, 1340, 1345, 1351–1356, 1371–1388), and `--base`
(default 1480) moves the whole port block. The result is written to `messagegate-cluster-result.txt` in the system temp
folder (or `MG_CLUSTER_RESULT`), the process logs to `.mg-cluster-logs-*` in the app folder.

## CI PostgreSQL image

The CI service image is pinned by digest. Dependabot does not update service images, so refresh it by hand:

```bash
docker buildx imagetools inspect postgres:16-alpine   # copy the index digest and the exact tag
```

Then update `image:` in `.github/workflows/ci.yml` and the `ci.yml` assertion in `tests/release.test.js`.

## Dependency updates and the auto-merge gate

Dependabot proposes updates weekly, after a cooldown (7 days, 14 for majors). `.github/workflows/dependency-auto-merge.yml` handles its pull requests with the rules in `.github/scripts/dependency-gate.mjs`. The script is the same in every Magic plugin repository; its unit tests run with `node --test .github/scripts/dependency-gate.test.mjs` and in CI.

- **Merged automatically** (squash merge by `github-actions`): an explicit patch or minor update, after the repository's own checks pass, the gate finds nothing below, and every other check on the PR head commit has finished green: every CI job and matrix entry (for example Node versions, peer floor, React 19 StrictMode) and CodeQL where present. The merge is bound to that exact commit (`--match-head-commit`).
- **Held for review** (label `needs-review` plus a comment with the reasons, never merged automatically) when:
  - a changed package's `engines.node` no longer covers a Node version this plugin supports, or its `peerDependencies` no longer match the installed tree or this plugin's peer floor;
  - the PR body or release notes mention a breaking change;
  - the published surface changes: the `npm pack` file list (content hashes ignored), `exports`, `peerDependencies`, `engines`, or the exports of the built entry files;
  - a runtime dependency on 0.x gets a minor bump;
  - dependency review reports a vulnerability of moderate or higher, or a license outside the allowlist (MIT, MIT-0, ISC, BSD, Apache-2.0, 0BSD, BlueOak-1.0.0, CC0-1.0, Unlicense, Python-2.0, Zlib; MPL-2.0 and CC-BY for development dependencies only);
  - `npm audit signatures` reports a missing or invalid registry signature or provenance attestation;
  - the lockfile adds a package with an install script, more than 15 packages that are new to the tree, or a package that does not resolve from `registry.npmjs.org`;
  - a check fails, or the CI does not finish within 75 minutes.
- **Major updates** get the `major-update` label and a comment; a person reads the changelog and merges by hand.

The gate script runs from the default branch and reads lockfiles and reports as data; it never runs code from the pull request. Only the surface job installs (without lifecycle scripts) and builds the pull request, with a read-only token. Merges made with `GITHUB_TOKEN` do not start `release.yml`, so a dependency update ships with the next regular release.

## Releases

Merging to `main` runs `.github/workflows/release.yml`: the full gate, then semantic-release publishes
`strapi-plugin-magic-messagegate` with npm provenance. Tags use the format `messagegate-v<version>`; the old `v1.0.x`
tags belong to the unpublished `magic-whatsapp` code and are ignored. Write user-facing notes under `## [Unreleased]`
in `CHANGELOG.md`; the release folds them into the notes and removes co-author trailers.
