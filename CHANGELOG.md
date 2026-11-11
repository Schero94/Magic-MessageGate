# Changelog

# 1.0.0 (2026-11-11)


### Bug Fixes

* align CI installs with lockfile settings ([4ed4c72](https://github.com/Schero94/Magic-MessageGate/commit/4ed4c72e6b498f426b0f31420de8e0832954f60a))
* build before verifying WhatsApp package exports ([bbdf206](https://github.com/Schero94/Magic-MessageGate/commit/bbdf2068aba4c83c2943e4f9ecf02ada0b32c778))
* bundle WhatsApp service for Strapi runtime ([f7306ab](https://github.com/Schero94/Magic-MessageGate/commit/f7306ab58e1abf0cbed8779149fbc701fe3e7ce5))


### Features

* add secure isolated WhatsApp plugin ([1cb39b7](https://github.com/Schero94/Magic-MessageGate/commit/1cb39b7e73c869be5cfcd310b9442d6431d4415b))
* establish isolated WhatsApp service ownership ([b6024af](https://github.com/Schero94/Magic-MessageGate/commit/b6024af40a356e8a91dd118793a9e15ba68cad88))
* scaffold local WhatsApp plugin with disabled routes ([19bbbba](https://github.com/Schero94/Magic-MessageGate/commit/19bbbbad035ae03234ae9ec62f0d9e87e8d01ac0))


### Breaking changes

- The package is now `strapi-plugin-magic-messagegate` (plugin id `magic-messagegate`). The former unofficial WhatsApp Web transport (`baileys`, QR pairing, `magic-whatsapp` routes and permissions) has been removed. Earlier `magic-whatsapp` versions were never published to npm.

### Features

- WhatsApp Cloud API, Telegram Bot API and SMS (seven.io, Twilio) through small fetch adapters, no vendor SDKs.
- Durable outbox with exactly-once dispatch across processes (PostgreSQL `FOR UPDATE SKIP LOCKED`, MySQL, SQLite), lease fencing, 1/5/15 minute backoff, `notAfter` deadlines and an `uncertain` state that is never resent automatically.
- Templates with zod-validated variables, WhatsApp template submission and status sync, SMS segment counting.
- Delivery and read tracking through signed webhooks (Meta, Telegram, seven.io, Twilio) with dedupe and replay protection.
- Consent per channel, STOP keywords, suppressions, learned WhatsApp reachability (error 131026), fallback chain WhatsApp → SMS → e-mail (Magic Mail).
- Number pre-check (E.164, line type) with an optional cached Twilio Lookup and a monthly budget.
- Admin and content API routes with RBAC actions, zod validation and rate limits; GDPR export and erasure; retention jobs.

### Security

- The Content API accepts Strapi API tokens only (`content-api-token` in Strapi 5.61, `api-token` before). Users-permissions logins get `403 FORBIDDEN` unless `contentApi.allowUsersPermissions` is set, because these routes act on any phone number.
- The paid number lookup in the admin needs the `contacts.manage` permission; the free format check stays available with `contacts.read`.
- A send accepts at most 50 variables and 20 metadata keys.

### Documentation

- New README, `AGENTS.md` API contract, GitHub Pages site with `llms.txt` and `llms-full.txt` (`npm run docs:llms` keeps the latter in sync), and an 8-process PostgreSQL acceptance record.

### Migration

- Remove `magic-whatsapp` from `config/plugins.*` and add `magic-messagegate`. Set `MESSAGEGATE_ENCRYPTION_KEY` (32+ random characters); without it the plugin derives keys from `APP_KEYS`.
- Old `magic-whatsapp` permissions disappear; grant the new `plugin::magic-messagegate.*` actions to admin roles.
