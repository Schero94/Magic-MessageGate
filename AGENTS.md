# AGENTS.md: Magic MessageGate API contract

This file is for AI coding agents (Codex, Claude Code, Cursor, …) and developers who integrate with `strapi-plugin-magic-messagegate`. It is the exact contract of version 1.x. Everything here matches the code in `server/src`; when in doubt, the code wins and this file is a bug.

Plugin id: `magic-messagegate`. Channels: `whatsapp` (Meta WhatsApp Cloud API), `telegram` (Bot API), `sms` (seven.io or Twilio).

## Rules for agents

Do:

- Send through `strapi.plugin('magic-messagegate').service('messages').send(...)` on the server, or `POST /api/magic-messagegate/messages` with a Strapi **API token** from another service.
- Pass an `idempotencyKey` for every send that may be retried by your code (order id, event id). A second call with the same key returns the first message with `duplicate: true` and sends nothing.
- Pass `notAfter` for anything time-bound (login codes, appointment reminders). A message is never sent after it, not even by an admin retry.
- Use approved WhatsApp templates for business-initiated messages. Free text (`text`) only works inside the 24-hour window after the contact's last WhatsApp message.
- Record consent (`POST /consent` or `service('contacts').grantConsent`) when your app collects it. Sending needs `granted` consent for the channel unless the template category is `AUTHENTICATION` and you pass `transactional: true`.
- Switch on `error.details.code`, never on the message text.
- Listen to the `messagegate.*` events on `strapi.eventHub` instead of polling.

Don't:

- Don't call Meta, Telegram, seven.io or Twilio directly for messages that MessageGate should track; statuses, fallback and consent would be bypassed.
- Don't send the same message again yourself after an `uncertain` status. The provider may have delivered it; MessageGate leaves the decision to an admin.
- Don't use the Content API from a browser or with a users-permissions login. It is for servers with an API token (end users are refused unless `contentApi.allowUsersPermissions` is on).
- Don't put personal data in `metadata` or `tags`. They are stored in plain text and shown to admins.
- Don't expect "online" or "exists on WhatsApp" checks. The official APIs don't offer them (see README, "What the official APIs allow").

## Server API (inside Strapi)

```js
const mg = strapi.plugin('magic-messagegate');

const result = await mg.service('messages').send({
  to: '+4915123456789', // or userId (users-permissions id) or contactId
  channel: 'auto', // 'auto' | 'whatsapp' | 'telegram' | 'sms'
  template: 'order_shipped', // template key
  language: 'de',
  variables: { first_name: 'Anna', order_id: 'A-10423' },
  idempotencyKey: 'order-shipped-A-10423',
  notAfter: new Date(Date.now() + 24 * 3600_000),
});
// → { id: 'k3j9…', status: 'queued', channel: 'whatsapp', duplicate: false }
```

| Service    | Method                                       | Returns                                                                       |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| `messages` | `send(input, { source? })`                   | `{ id, status, channel, duplicate }`                                          |
| `messages` | `get(id)`                                    | message detail (see below)                                                    |
| `messages` | `list(query)`                                | `{ results, pagination }`                                                     |
| `messages` | `retry(id, { confirmDuplicateRisk? })`       | message detail; `uncertain` messages need `confirmDuplicateRisk: true`        |
| `messages` | `cancel(id)`                                 | message detail (status `discarded`)                                           |
| `contacts` | `upsert(phone, { userId?, locale? })`        | contact DTO (phone masked)                                                    |
| `contacts` | `grantConsent(contactId, channel, source?)`  | `undefined`                                                                   |
| `contacts` | `revokeConsent(contactId, channel, source?)` | `undefined`                                                                   |
| `telegram` | `createLink(contactId, accountId?)`          | `{ url, token, expiresInMinutes: 30 }`, `url` is `https://t.me/<bot>?start=…` |
| `lookup`   | `check(phone)`                               | lookup result (see below)                                                     |

### `send` input

| Field            | Type                                                       | Rules                                                                     |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `to`             | string                                                     | phone number, parsed to E.164 with the default country (`DE`); 3–40 chars |
| `userId`         | integer                                                    | alternative to `to`: users-permissions user linked to a contact           |
| `contactId`      | string                                                     | alternative to `to`                                                       |
| `email`          | string                                                     | used only by the e-mail fallback (Magic Mail)                             |
| `channel`        | `auto` \| `whatsapp` \| `telegram` \| `sms`                | default `auto` = routing rules, then the default chain (`whatsapp → sms`) |
| `template`       | string `^[a-z][a-z0-9_]{0,119}$`                           | template key; `template` or `text` is required                            |
| `language`       | string, e.g. `de`, `pt_BR`                                 | picks the template variant                                                |
| `variables`      | object, ≤ 50 keys, values string ≤ 1024 / number / boolean | validated against the template's variable definitions                     |
| `text`           | string 1–4096                                              | free text (WhatsApp only inside the 24-hour window)                       |
| `idempotencyKey` | string 1–200                                               | scoped per caller (API token or service)                                  |
| `notAfter`       | Date, ISO string with offset, or epoch ms                  | final deadline; default `defaultNotAfterHours` (24)                       |
| `transactional`  | boolean                                                    | with an `AUTHENTICATION` template: no consent needed                      |
| `tags`           | string[] ≤ 10, each ≤ 40                                   | used by routing rules                                                     |
| `accountId`      | string                                                     | send through this account only                                            |
| `priority`       | `high` \| `normal` \| `low`                                | worker order                                                              |
| `metadata`       | object ≤ 20 keys                                           | stored, never sent                                                        |

Unknown fields are rejected (`INVALID_REQUEST`).

## Content API (for other services)

Base path `/api/magic-messagegate`. Authenticate with a Strapi API token (`Authorization: Bearer <token>`) that has the MessageGate permissions. Bodies may be wrapped in `{ "data": … }`.

| Method | Path             | Body                                                        | Success                                                                                                                     |
| ------ | ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/messages`      | `send` input                                                | `202 { data: { id, status, channel, duplicate: false } }`, replay `200 … duplicate: true`                                   |
| GET    | `/messages/:id`  | –                                                           | `200 { data: { id, status, channel, templateKey, errorCode, sentAt, deliveredAt, readAt, failedAt, timeline, fallbacks } }` |
| POST   | `/consent`       | `{ phone, channel, status: 'granted'\|'revoked', userId? }` | `200 { data: { contactId, channel, status } }`                                                                              |
| POST   | `/telegram-link` | `{ phone }`                                                 | `200 { data: { url, token, expiresInMinutes } }`                                                                            |
| POST   | `/lookup`        | `{ phone }`                                                 | `200 { data: lookup result }`                                                                                               |

Rate limits (shared across all processes): `rateLimits.sendPerMinute` (120) per token for `/messages`, `rateLimits.lookupPerMinute` (30) for `/lookup`. Over the limit: `429` with `Retry-After: 60` and code `RATE_LIMITED`.

```bash
curl -X POST https://cms.example.com/api/magic-messagegate/messages \
  -H "Authorization: Bearer $STRAPI_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"data":{"to":"+4915123456789","template":"order_shipped","language":"de","variables":{"first_name":"Anna","order_id":"A-10423"},"idempotencyKey":"order-shipped-A-10423"}}'
```

Errors use Strapi's error shape:

```json
{
  "data": null,
  "error": { "status": 409, "name": "ConflictError", "message": "…", "details": { "code": "NO_CONSENT" } }
}
```

## Message detail and statuses

`timeline` is a list of `{ type, code, at }` (epoch ms), `fallbacks` a list of `{ id, channel, status }` for messages created by the fallback chain.

| Status      | Meaning                                                                                    | Terminal |
| ----------- | ------------------------------------------------------------------------------------------ | -------- |
| `queued`    | waiting for the worker (also between retries)                                              | no       |
| `sent`      | the provider accepted it                                                                   | no       |
| `delivered` | the provider reported delivery to the phone                                                | no       |
| `read`      | the recipient opened it (WhatsApp only, and only with read receipts on)                    | yes      |
| `failed`    | not delivered (`errorCode`, e.g. `META_131026`); the fallback chain may continue           | yes      |
| `uncertain` | the outcome is unknown (timeout after the request was written); never resent automatically | yes      |
| `expired`   | `notAfter` passed before it could be sent                                                  | yes      |
| `discarded` | cancelled by an admin or `cancel(id)`                                                      | yes      |

Statuses only move forward: a late `delivered` after `read` is ignored. Retries: first try plus up to 3 retries after about 1, 5 and 15 minutes (±20 %), only when the provider provably did not accept the message.

## Lookup result

```json
{
  "valid": true,
  "e164": "+4915123456789",
  "country": "DE",
  "type": "MOBILE",
  "mobile": true,
  "whatsapp": "unknown",
  "remote": null
}
```

`whatsapp` is `unknown`, `ok` (a message was delivered) or `unreachable` (Meta reported 131026). `remote` holds the cached Twilio line-type result when paid lookups are enabled, otherwise `null`.

## Events (`strapi.eventHub`)

No phone numbers, names or message text in any payload.

| Event                                 | Payload                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `messagegate.message.queued`          | `{ messageId, channel, templateKey, status, code?, at }`                                       |
| `messagegate.message.sent`            | same                                                                                           |
| `messagegate.message.delivered`       | same                                                                                           |
| `messagegate.message.read`            | same                                                                                           |
| `messagegate.message.failed`          | same, `code` set                                                                               |
| `messagegate.message.uncertain`       | same, `code` set                                                                               |
| `messagegate.message.expired`         | same, `code: 'DEADLINE_PASSED'`                                                                |
| `messagegate.message.discarded`       | same                                                                                           |
| `messagegate.message.fallback`        | `{ messageId, channel, templateKey, status: 'fallback', code, at }` (`channel` = next channel) |
| `messagegate.contact.opted-out`       | `{ channel, at }`                                                                              |
| `messagegate.contact.unreachable`     | `{ channel: 'whatsapp', at }`                                                                  |
| `messagegate.template.status-changed` | template id, key, language, new status                                                         |

```js
strapi.eventHub.on('messagegate.message.read', ({ messageId, templateKey }) => {
  /* … */
});
```

## Error codes

| Code                       | HTTP | When                                                                         |
| -------------------------- | ---- | ---------------------------------------------------------------------------- |
| `INVALID_REQUEST`          | 400  | body does not match the schema                                               |
| `INVALID_PHONE`            | 400  | not a valid mobile number                                                    |
| `MISSING_VARIABLE`         | 400  | a required template variable is missing (`details.field`)                    |
| `INVALID_VARIABLE`         | 400  | a variable is too long or unknown, or the rendered Telegram text is too long |
| `CONFIG_INVALID`           | 400  | account or settings configuration is invalid                                 |
| `INVALID_SIGNATURE`        | 401  | webhook signature check failed                                               |
| `FORBIDDEN`                | 403  | Content API without an API token, or a paid lookup without `contacts.manage` |
| `NOT_FOUND`                | 404  | unknown message, contact, template or account                                |
| `UNKNOWN_TEMPLATE`         | 404  | no active template with this key for the channel                             |
| `TEMPLATE_NOT_APPROVED`    | 409  | WhatsApp template not approved by Meta yet                                   |
| `NO_CONSENT`               | 409  | no granted consent for the channel                                           |
| `SUPPRESSED`               | 409  | contact suppressed (opted out, blocked the bot, not on WhatsApp)             |
| `WINDOW_CLOSED`            | 409  | free text outside the 24-hour WhatsApp window                                |
| `NO_ACCOUNT`               | 409  | no active account for the channel                                            |
| `NO_ROUTE`                 | 409  | no channel in the chain can reach the contact                                |
| `NOT_LINKED`               | 409  | contact has not linked Telegram                                              |
| `DEADLINE_PASSED`          | 409  | `notAfter` has passed                                                        |
| `STATE_CHANGED`            | 409  | the message changed meanwhile (retry/discard race)                           |
| `CONFIRMATION_REQUIRED`    | 409  | retrying an `uncertain` message without `confirmDuplicateRisk`               |
| `PAYLOAD_PURGED`           | 409  | the message content was already removed by retention                         |
| `LOOKUP_DISABLED`          | 409  | paid lookup not configured                                                   |
| `EMBEDDED_SIGNUP_DISABLED` | 409  | Meta Embedded Signup not configured on the server                            |
| `RATE_LIMITED`             | 429  | too many requests                                                            |
| `LOOKUP_BUDGET_EXCEEDED`   | 429  | monthly lookup budget used up                                                |
| `PROVIDER_ERROR`           | 502  | the provider rejected an admin action (template submit, account test)        |

Provider error codes in `errorCode` and timelines are prefixed: `META_131026`, `TG_403`, `SEVEN_…`, `TWILIO_…`, plus `TIMEOUT`, `LEASE_EXPIRED_DURING_SEND`, `DEADLINE_PASSED`.

## Webhooks (configured by the owner, not called by apps)

`GET|POST /api/magic-messagegate/webhooks/:provider/:path`, where `:path` is a random id per account shown in the admin (Meta app-level URL: `/webhooks/meta/app`). Every POST must carry the provider signature (`X-Hub-Signature-256`, `X-Telegram-Bot-Api-Secret-Token`, seven.io `X-Signature`, `X-Twilio-Signature`); otherwise `401` without detail. Events are deduplicated, and Meta retries for up to 36 hours.
