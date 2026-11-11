# AGENTS.md: Magic MessageGate API contract

This file is for AI coding agents (Codex, Claude Code, Cursor, …) and developers who integrate with `strapi-plugin-magic-messagegate`. It is the exact contract of version 1.x (1.1 added RCS, attachments, number checks, inbound messages, dry runs, the sandbox and the outgoing webhook). Everything here matches the code in `server/src`; when in doubt, the code wins and this file is a bug.

Plugin id: `magic-messagegate`. Channels: `whatsapp` (Meta WhatsApp Cloud API), `rcs` (Twilio), `telegram` (Bot API), `sms` (seven.io or Twilio).

The loop: **send → receive → process → automate.** Send with `messages.send`, receive every reply as a `messagegate.message.received` event, read it (`inbound.get`, `inbound.getMedia`, `conversations.history`), answer with `messages.reply`, and mark it done with `inbound.markProcessed`.

## Rules for agents

Do:

- Send through `strapi.plugin('magic-messagegate').service('messages').send(...)` on the server, or `POST /api/magic-messagegate/messages` with a Strapi **API token** from another service.
- Pass an `idempotencyKey` for every send that may be retried by your code (order id, event id). A second call with the same key returns the first message with `duplicate: true` and sends nothing.
- Pass `notAfter` for anything time-bound (login codes, appointment reminders). A message is never sent after it, not even by an admin retry.
- Use approved WhatsApp templates for business-initiated messages. Free text (`text`) only works inside the 24-hour window after the contact's last WhatsApp message.
- Record consent (`POST /consent` or `service('contacts').grantConsent`) when your app collects it. Sending needs `granted` consent for the channel (also for `rcs`) unless the template category is `AUTHENTICATION` and you pass `transactional: true`.
- Switch on `error.details.code`, never on the message text.
- Listen to the `messagegate.*` events on `strapi.eventHub` instead of polling. Do the work after the event (queue it in your app); never block the provider webhook.
- Use `send(input, { dryRun: true })` or `POST /messages` with `"dryRun": true` in tests to see the route and payload without sending.
- Use `providers.mode: 'sandbox'` in app tests and CI (no network, no cost, deterministic outcomes).
- Make inbound workers idempotent with `inbound.markProcessed(id)`: only the first call returns `alreadyProcessed: false`.

Don't:

- Don't call Meta, Telegram, seven.io or Twilio directly for messages that MessageGate should track; statuses, fallback and consent would be bypassed.
- Don't send the same message again yourself after an `uncertain` status. The provider may have delivered it; MessageGate leaves the decision to an admin.
- Don't use the Content API from a browser or with a users-permissions login. It is for servers with an API token (end users are refused unless `contentApi.allowUsersPermissions` is on).
- Don't put personal data in `metadata` or `tags`. They are stored in plain text and shown to admins.
- Don't expect "online", "exists on WhatsApp" or "RCS capable" pre-checks. The official APIs don't offer them (Twilio has no RCS capability lookup); MessageGate learns WhatsApp (error 131026) and RCS (Twilio 63036) from sends.
- Don't log inbound text, captions or files. They are personal data; MessageGate stores them encrypted and deletes them after `inbound.retentionDays`.
- E-mail is never sent by MessageGate itself. The `email` step only hands the message to Magic Mail when the owner turned `fallback.emailEnabled` on (off by default).

## Server API (inside Strapi)

```js
const mg = strapi.plugin('magic-messagegate');

const result = await mg.service('messages').send({
  to: '+4915123456789', // or userId (users-permissions id) or contactId
  channel: 'auto', // 'auto' | 'whatsapp' | 'rcs' | 'telegram' | 'sms'
  template: 'order_shipped', // template key
  language: 'de',
  variables: { first_name: 'Anna', order_id: 'A-10423' },
  attachment: { fileId: 42 }, // optional: media library file, or { url, mimeType }
  idempotencyKey: 'order-shipped-A-10423',
  notAfter: new Date(Date.now() + 24 * 3600_000),
});
// → { id: 'k3j9…', status: 'queued', channel: 'whatsapp', duplicate: false }
```

| Service         | Method                                                                            | Returns                                                                                           |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `messages`      | `send(input, { source?, dryRun? })`                                               | `{ id, status, channel, duplicate }`; with `dryRun: true` the dry-run result (below)              |
| `messages`      | `preview(input)`                                                                  | dry-run result: route, account, rendered payload, errors; nothing is queued or charged            |
| `messages`      | `reply(inboundId, input, { dryRun? })`                                            | like `send`, on the channel and account of the inbound message                                    |
| `messages`      | `get(id)`                                                                         | message detail (see below)                                                                        |
| `messages`      | `list(query)`                                                                     | `{ results, pagination }`                                                                         |
| `messages`      | `retry(id, { confirmDuplicateRisk? })`                                            | message detail; `uncertain` messages need `confirmDuplicateRisk: true`                            |
| `messages`      | `cancel(id)`                                                                      | message detail (status `discarded`)                                                               |
| `templates`     | `render(key, language, variables, channel)`                                       | `{ templateId, key, language, channel, approvalStatus, preview, payload, sms? }`, nothing is sent |
| `contacts`      | `upsert(phone, { userId?, locale? })`                                             | contact DTO (phone masked)                                                                        |
| `contacts`      | `grantConsent(contactId, channel, source?)`                                       | `undefined`                                                                                       |
| `contacts`      | `revokeConsent(contactId, channel, source?)`                                      | `undefined`                                                                                       |
| `telegram`      | `createLink(contactId, accountId?)`                                               | `{ url, token, expiresInMinutes: 30 }`, `url` is `https://t.me/<bot>?start=…`                     |
| `lookup`        | `check(phone, { remote?, hlr?, rcs? })`                                           | lookup result (see below)                                                                         |
| `lookup`        | `capabilities(phone)`                                                             | `{ valid, e164, type, active, whatsapp, rcs, telegramLinked, checkedAt }`, never paid             |
| `inbound`       | `get(id)`                                                                         | inbound DTO with decrypted text (see below)                                                       |
| `inbound`       | `list({ page?, pageSize?, channel?, kind?, contactId?, processed?, from?, to? })` | `{ results, pagination }`, newest first                                                           |
| `inbound`       | `markProcessed(id)`                                                               | `{ id, processedAt, alreadyProcessed }`                                                           |
| `inbound`       | `getMedia(id, { as: 'buffer' \| 'stream' \| 'base64' })`                          | `{ data, mime, size, filename, caption }`; only when `media.status` is `ready`                    |
| `inbound`       | `createMediaUrl(id, { ttlSeconds? })`                                             | `{ url, expiresAt }`: signed https URL, 30–3600 s (default 300)                                   |
| `inbound`       | `onReceived(handler)`                                                             | unsubscribe function; same as `strapi.eventHub.on('messagegate.message.received', …)`             |
| `inbound`       | `onMediaScan(async (file) => 'clean' \| 'infected')`                              | registers a virus scanner (per process; register it in every process)                             |
| `conversations` | `history(contactId \| { inboundId }, { limit?, since?, includeMedia? })`          | `{ contactId, items }`: inbound and outbound in time order (see below)                            |
| `sandbox`       | `simulateInbound(input)`                                                          | inbound DTO; sandbox mode only (`SANDBOX_ONLY` otherwise)                                         |
| `sandbox`       | `drain({ maxRounds? })`                                                           | runs the send and media workers until nothing is due (sandbox mode only)                          |
| `sandbox`       | `numbers`                                                                         | the magic test numbers                                                                            |

### `send` input

| Field            | Type                                                       | Rules                                                                                                                 |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `to`             | string                                                     | phone number, parsed to E.164 with the default country (`DE`); 3–40 chars                                             |
| `userId`         | integer                                                    | alternative to `to`: users-permissions user linked to a contact                                                       |
| `contactId`      | string                                                     | alternative to `to`                                                                                                   |
| `email`          | string                                                     | used only by the opt-in e-mail fallback (Magic Mail)                                                                  |
| `channel`        | `auto` \| `whatsapp` \| `rcs` \| `telegram` \| `sms`       | default `auto` = routing rules, then the default chain (`whatsapp → rcs → sms`)                                       |
| `template`       | string `^[a-z][a-z0-9_]{0,119}$`                           | template key; `template` or `text` is required                                                                        |
| `language`       | string, e.g. `de`, `pt_BR`                                 | picks the template variant                                                                                            |
| `variables`      | object, ≤ 50 keys, values string ≤ 1024 / number / boolean | validated against the template's variable definitions                                                                 |
| `text`           | string 1–4096                                              | free text (WhatsApp only inside the 24-hour window)                                                                   |
| `buttons`        | 1–3 × `{ payload, title }`                                 | only with `text`: WhatsApp reply buttons, Telegram inline keyboard; `payload` `^[A-Za-z0-9_.:-]{1,64}$`, `title` ≤ 20 |
| `attachment`     | `{ fileId }` or `{ url, mimeType? }`, optional `filename`  | see "Attachments"                                                                                                     |
| `idempotencyKey` | string 1–200                                               | scoped per caller (API token or service)                                                                              |
| `notAfter`       | Date, ISO string with offset, or epoch ms                  | final deadline; default `defaultNotAfterHours` (24)                                                                   |
| `transactional`  | boolean                                                    | with an `AUTHENTICATION` template: no consent needed                                                                  |
| `tags`           | string[] ≤ 10, each ≤ 40                                   | used by routing rules                                                                                                 |
| `accountId`      | string                                                     | send through this account only                                                                                        |
| `priority`       | `high` \| `normal` \| `low`                                | worker order                                                                                                          |
| `metadata`       | object ≤ 20 keys                                           | stored, never sent                                                                                                    |

Unknown fields are rejected (`INVALID_REQUEST`). `dryRun` is an option (service) or a body field (Content API), not part of the input.

### Channel chain and RCS

`auto` tries the channels of the matching routing rule, else `routing.defaultChain` (new installs: `whatsapp → rcs → sms`; settings saved by 1.0 keep their chain). A channel is skipped when it cannot reach the contact (the codes show up in the dry-run `steps`): no account, no consent, suppressed, WhatsApp window closed, not on WhatsApp (learned 131026), not RCS capable (learned Twilio 63036, trusted for 30 days), not linked (Telegram), attachment not possible. A terminal failure after sending (for example RCS `undelivered` with 63036) runs the next channel once.

RCS goes through a Twilio Messaging Service that holds your approved RCS sender (`messagingServiceSid` on the RCS account). MessageGate sends `To=rcs:+…`, so Twilio does not fall back on its own and MessageGate's chain decides; set `twilioFallback: true` on the account to let Twilio fall back to SMS instead. Plain-text RCS templates (`{ text, mediaUrl? }`) are approved on save; a rich card (`title`, up to 4 `buttons` of type `URL`, `PHONE_NUMBER` or `QUICK_REPLY` with `payload`) becomes a Twilio Content template with **Create on Twilio** (`POST /templates/:id/submit` with a Twilio account) and is sent with `ContentSid` and numbered `ContentVariables` in the stored `variableOrder`.

### Attachments

| Source        | Fields                          | Checks                                                                                                                                                 |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| media library | `{ fileId, filename? }`         | file exists, MIME allow-list, first bytes match the type (local files), public URL = `publicUrl` + file URL                                            |
| URL           | `{ url, mimeType?, filename? }` | `https:` only, no credentials, port 443, no local, private, loopback, link-local or CGNAT host; type from `mimeType` or the extension; they must match |

Allowed types: `image/jpeg`, `image/png`, `application/pdf`, `video/mp4`. How each channel carries the file:

| Channel  | Carries                                                                                                                                         | Limit                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| WhatsApp | free text → image, video or document message with caption (≤ 1024); template → header media (needs an IMAGE/VIDEO/DOCUMENT header of that kind) | image 5 MB, video 16 MB, PDF 100 MB |
| RCS      | `MediaUrl` (Twilio builds a rich card with the text); not combinable with a Content template                                                    | 16 MB                               |
| Telegram | `sendPhoto` (JPEG/PNG) or `sendDocument` (PDF) by URL with the text as caption (≤ 1024); other files or longer text → signed link               | photo 5 MB, PDF 20 MB               |
| SMS      | a signed, expiring download link appended to the text                                                                                           | –                                   |

A channel that cannot carry the file is skipped (`ATTACHMENT_TOO_LARGE`, `ATTACHMENT_TYPE_NOT_ALLOWED`, `ATTACHMENT_UNSUPPORTED`). Only a reference (file id or URL, name, type) is stored, encrypted; never the file. Signed links look like `https://<publicUrl>/api/magic-messagegate/files/<id>.<expiry>.<HMAC>`, are valid `attachments.linkTtlHours` (72) and are rate limited per IP; every invalid, expired or tampered link answers the same `404`. Media-library files on a remote upload provider (S3, …) and URL attachments are answered with a redirect to their public URL; local files are streamed as downloads (`Content-Disposition: attachment`, `nosniff`, sandbox CSP).

WhatsApp media templates: the header's `fileId` is uploaded as the sample with Meta's Resumable Upload API on submit (`example.header_handle`; needs the Meta app id from the account config `appId` or `providers.meta.embeddedSignup.appId`), and it is the default header media at send time; a message `attachment` replaces it.

### Variables in WhatsApp buttons

- **URL buttons:** Meta lets one variable sit at the **end** of an approved URL, for example `https://shop.example/track/{{order_id}}`. MessageGate sends only the value; WhatsApp appends it to the approved URL. The value must be the URL suffix (`A-10423`), never a full URL. Only the first placeholder of a URL button is used.
- **Copy-code buttons:** set `variable` on the button; the value is cut to 15 characters, Meta's limit.
- **Quick-reply buttons:** set a fixed `payload`; it comes back as `buttonPayload` of the inbound message when the customer taps it.
- Body, header and button variables all come from the same `variables` object.

### Dry run

`send(input, { dryRun: true })`, `messages.preview(input)` and `POST /messages` with `"dryRun": true` validate, resolve the route and render the payload of the channel that would be used. Nothing is queued, no contact is created, no provider is called and no paid lookup runs (cached HLR results are used).

```json
{
  "dryRun": true,
  "valid": true,
  "errors": [],
  "chain": ["whatsapp", "rcs", "sms"],
  "steps": [
    { "channel": "whatsapp", "eligible": false, "code": "NO_CONSENT" },
    { "channel": "rcs", "eligible": true, "attachmentMode": "media" },
    { "channel": "sms", "eligible": true }
  ],
  "channel": "rcs",
  "account": { "id": "x8…", "provider": "twilio", "name": "RCS Shop" },
  "to": "+491•••89",
  "payload": { "kind": "rcs", "text": "Hallo Anna …", "mediaUrl": "https://…" },
  "preview": "Hallo Anna …",
  "attachment": { "source": "library", "mimeType": "application/pdf", "filename": "invoice.pdf", "size": 12800 }
}
```

`errors` is `[{ code, field? }]` (for example `INVALID_REQUEST` with `field`, `MISSING_VARIABLE`, `NO_CONSENT`, `NUMBER_INACTIVE`); `valid` is false when there are errors. SMS links show as `…/files/<signed-link>`. Secrets never appear.

## Content API (for other services)

Base path `/api/magic-messagegate`. Authenticate with a Strapi API token (`Authorization: Bearer <token>`) that has the MessageGate permissions. Bodies may be wrapped in `{ "data": … }`.

| Method | Path                        | Body / query                                                                               | Success                                                                                                                           |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/messages`                 | `send` input, optional `"dryRun": true`                                                    | `202 { data: { id, status, channel, duplicate: false } }`, replay `200 … duplicate: true`, dry run `200 { data: dry-run result }` |
| GET    | `/messages/:id`             | –                                                                                          | `200 { data: { id, status, channel, templateKey, errorCode, sentAt, deliveredAt, readAt, failedAt, timeline, fallbacks } }`       |
| POST   | `/consent`                  | `{ phone, channel, status: 'granted'\|'revoked', userId? }`                                | `200 { data: { contactId, channel, status } }`                                                                                    |
| POST   | `/telegram-link`            | `{ phone }`                                                                                | `200 { data: { url, token, expiresInMinutes } }`                                                                                  |
| POST   | `/lookup`                   | `{ phone, remote?, hlr?, rcs? }`                                                           | `200 { data: lookup result }`                                                                                                     |
| POST   | `/capabilities`             | `{ phone }`                                                                                | `200 { data: { valid, e164, type, active, whatsapp, rcs, telegramLinked, checkedAt } }`                                           |
| POST   | `/templates/render`         | `{ template, channel, language?, variables? }`                                             | `200 { data: { templateId, key, language, channel, approvalStatus, preview, payload, sms? } }`                                    |
| GET    | `/inbound`                  | `page, pageSize, channel, kind, contactId, processed, from, to`                            | `200 { data: { results: inbound DTO[], pagination } }`                                                                            |
| GET    | `/inbound/:id`              | –                                                                                          | `200 { data: inbound DTO }`                                                                                                       |
| POST   | `/inbound/:id/processed`    | –                                                                                          | `200 { data: { id, processedAt, alreadyProcessed } }`                                                                             |
| GET    | `/inbound/:id/media`        | `?as=base64` (default: the file as a download)                                             | the file (`Content-Disposition: attachment`, `nosniff`) or `200 { data: { data, mime, size, filename, caption } }`                |
| POST   | `/inbound/:id/media-url`    | `{ ttlSeconds? }` (30–3600)                                                                | `200 { data: { url, expiresAt } }`                                                                                                |
| POST   | `/inbound/:id/reply`        | `text` (+ `buttons`) or `template` + `variables`, `attachment`, `idempotencyKey`, `dryRun` | `202` like `/messages`                                                                                                            |
| GET    | `/conversations/:contactId` | `limit` (≤ 200), `since`, `includeMedia`                                                   | `200 { data: { contactId, items } }`                                                                                              |
| POST   | `/sandbox/inbound`          | `simulateInbound` input                                                                    | `201 { data: inbound DTO }`; `403 SANDBOX_ONLY` outside sandbox mode                                                              |
| GET    | `/files/:token`             | – (public, signed)                                                                         | the file or a redirect; `404` for anything invalid                                                                                |

The inbound routes (`/inbound…`, `/conversations…`, `/sandbox/inbound`) return message text and files, so they belong to a separate controller (`inbound-api`): a custom API token only gets them when those permissions are ticked, and send-only tokens cannot read replies.

Rate limits (shared across all processes, per token): `rateLimits.sendPerMinute` (120) for `/messages`, `/templates/render` and replies, `rateLimits.lookupPerMinute` (30) for `/lookup` and `/capabilities`, `rateLimits.inboundPerMinute` (300) for the inbound routes, `rateLimits.downloadPerMinute` (60, per IP) for `/files`. Over the limit: `429` with `Retry-After: 60` and code `RATE_LIMITED`.

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

| Status      | Meaning                                                                                          | Terminal |
| ----------- | ------------------------------------------------------------------------------------------------ | -------- |
| `queued`    | waiting for the worker (also between retries)                                                    | no       |
| `sent`      | the provider accepted it                                                                         | no       |
| `delivered` | the provider reported delivery to the phone                                                      | no       |
| `read`      | the recipient opened it (WhatsApp and RCS, only with read receipts on)                           | yes      |
| `failed`    | not delivered (`errorCode`, e.g. `META_131026`, `TWILIO_63036`); the fallback chain may continue | yes      |
| `uncertain` | the outcome is unknown (timeout after the request was written); never resent automatically       | yes      |
| `expired`   | `notAfter` passed before it could be sent                                                        | yes      |
| `discarded` | cancelled by an admin or `cancel(id)`                                                            | yes      |

Statuses only move forward: a late `delivered` after `read` is ignored. Retries: first try plus up to 3 retries after about 1, 5 and 15 minutes (±20 %), only when the provider provably did not accept the message. Outbound message content is removed once a message is delivered (privacy by design), so `conversations.history` shows the template key instead of the text for delivered messages.

## Lookup result

```json
{
  "valid": true,
  "e164": "+4915123456789",
  "country": "DE",
  "type": "MOBILE",
  "mobile": true,
  "whatsapp": "unknown",
  "remote": null,
  "rcs": "unknown",
  "hlr": {
    "ok": true,
    "active": true,
    "valid": "valid",
    "reachable": "reachable",
    "ported": "assumed_not_ported",
    "roaming": "not_roaming",
    "network": "Example Mobile",
    "networkType": "mobile",
    "checkedAt": 1800000000000
  }
}
```

- `whatsapp`: `unknown`, `ok` (a message was delivered) or `unreachable` (Meta reported 131026).
- `remote`: the cached Twilio line-type result when `remote` is on (the default) and the Twilio lookup is configured, otherwise `null`.
- `rcs` (with `rcs: true`): `unknown`, `capable` (an RCS message was delivered) or `not_capable` (Twilio 63036 within the last 30 days).
- `hlr` (with `hlr: true`): seven.io HLR (`GET /api/lookup/hlr`). `active` is `true` (assigned; `reachable`, or `absent` = switched off), `false` (`not_valid` or `bad_number`) or `null` (unknown). Paid; cached for `lookup.cacheDays` (30) in the database; counts against `lookup.monthlyBudget` together with Twilio lookups. `LOOKUP_DISABLED` when HLR is not configured.
- `capabilities(phone)` returns the free summary `{ valid, e164, type, active, whatsapp, rcs, telegramLinked, checkedAt }` from cached results only.

`lookup.blockInactiveNumbers` (off by default) makes every send on a phone channel run the HLR check first (cached; paid only when not cached): a number with `active: false` fails at once with `NUMBER_INACTIVE` and costs no message. A check that fails or a used-up budget never blocks a send.

## Inbound messages

Every message a contact sends (WhatsApp, RCS, Telegram, SMS) is stored once and announced once:

```js
strapi
  .plugin('magic-messagegate')
  .service('inbound')
  .onReceived(async ({ inboundId, kind, buttonPayload }) => {
    // queue your own job here; keep the webhook fast
  });
```

Inbound DTO (`inbound.get`, `GET /inbound/:id`):

| Field                                 | Type                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                  | inbound id                                                                                                                                                                                                                                              |
| `channel`                             | `whatsapp` \| `rcs` \| `telegram` \| `sms`                                                                                                                                                                                                              |
| `kind`                                | `text` \| `button` \| `media` \| `location` \| `other`                                                                                                                                                                                                  |
| `text`                                | decrypted text or caption, or `null`                                                                                                                                                                                                                    |
| `buttonPayload`                       | payload of a tapped button (WhatsApp quick reply or reply button, Telegram callback data, RCS suggested reply), or `null`                                                                                                                               |
| `buttonTitle`                         | the button's label, or `null`                                                                                                                                                                                                                           |
| `location`                            | `{ latitude, longitude, name?, address? }` or `null`                                                                                                                                                                                                    |
| `media`                               | `null` or `{ status, code, fileId, mime, size, filename, caption, duration }`                                                                                                                                                                           |
| `replyTo`                             | id of our outbound message it answers (WhatsApp `context.id`, Telegram `reply_to_message`, Twilio `OriginalRepliedMessageSid`; SMS/RCS without a reference: the last message sent to the contact on that channel within `inbound.replyWindowHours`, 72) |
| `contactId`, `contact`                | contact id; `{ id, phoneMasked, userId }`                                                                                                                                                                                                               |
| `receivedAt`, `processedAt`, `seenAt` | epoch ms or `null`                                                                                                                                                                                                                                      |

Telegram messages are only stored for chats linked to a contact (bots cannot see phone numbers). An inline-keyboard press is answered (`answerCallbackQuery`) so the client stops its spinner.

### Inbound media

`media.status`: `pending` (download queued) → `ready`, or `failed` with `code`; `quarantined` while a registered scanner has not answered `clean`; `skipped` when `inboundMedia.storage` is `none`.

The download worker claims jobs with a lease (one process per file) and downloads only from the provider's own hosts with the account credentials: Meta `GET /{media-id}`, then the CDN URL with the bearer token; Telegram `getFile`, then `api.telegram.org/file/bot…`; Twilio the account's `MediaUrl` on `api.twilio.com` with basic auth and one redirect to Twilio's media hosts without credentials. It retries after 1, 5, 15 and 60 minutes until the provider's window ends (Meta media ids expire after 7 days; Telegram: 24 hours; Twilio: 7 days), and then:

1. stops at `inboundMedia.maxMb` (25) **while streaming** (`MEDIA_TOO_LARGE`),
2. checks the type against `inboundMedia.allowedTypes` (JPEG, PNG and WebP images, PDF, Office documents, plain text, Ogg, MP3, M4A, AAC and AMR audio, MP4 and 3GP video; `MEDIA_TYPE_BLOCKED`),
3. checks the first bytes against the type (`MEDIA_TYPE_MISMATCH`),
4. removes EXIF (GPS, device) from JPEG and `eXIf` chunks from PNG; other formats keep their metadata,
5. runs the scanner registered with `inbound.onMediaScan` (`infected` → `MEDIA_INFECTED`; any other answer keeps the file in quarantine, not stored, and checks again after 5 minutes),
6. stores the file with a safe name in the media library folder **MessageGate inbound** through the upload plugin (local, S3, Cloudinary … all work) and records `fileId`.

Other codes: `MEDIA_EXPIRED` (the provider no longer has it), `MEDIA_HOST_REFUSED` (the provider pointed to a host outside its own), `MEDIA_FETCH_FAILED`, `MEDIA_STORAGE_FAILED`. With the local upload provider, media library files are reachable by their (unguessable) URL like every other upload; use a private bucket provider if that is not acceptable. Files are deleted together with the inbound message (retention, GDPR erasure).

### Access inbound messages and files from your code

1. `onReceived` (the `messagegate.message.received` event) gives you the `inboundId`, `kind` and `buttonPayload`.
2. `inbound.get(inboundId)` returns the decrypted text, button, location and media metadata.
3. For media, wait for `messagegate.media.ready` (or check `media.status`), then call `inbound.getMedia(inboundId, { as: 'buffer' | 'stream' | 'base64' })`, or `inbound.createMediaUrl(inboundId, { ttlSeconds: 300 })` for a service that fetches files by URL. Anyone holding that URL can download the file until it expires; keep the TTL short and do not log it.
4. `conversations.history({ inboundId })` gives the context: inbound and outbound items `{ direction, id, channel, kind, text, buttonPayload, buttonTitle, location, media, status, replyTo, at, templateKey }`.
5. Answer with `messages.reply(inboundId, { text })` (WhatsApp: only within 24 hours of the customer's last message, otherwise `WINDOW_CLOSED`; use `{ template, variables }`), then call `inbound.markProcessed(inboundId)`.

The data can be passed to any processing of your own; MessageGate does not process it further. Check consent and your privacy notice before you forward message text or files to third parties.

## Sandbox (tests and CI)

```js
// config/env/test/plugins.js
const { sandboxConfig } = require('strapi-plugin-magic-messagegate/testing');

module.exports = {
  'magic-messagegate': { enabled: true, config: sandboxConfig({ encryptionKey: 'test-key-at-least-16' }) },
};
```

`providers.mode: 'sandbox'` replaces every provider with an in-process fake: no network, no cost. Accounts still need format-valid credentials. Each send is accepted and its statuses are applied at once through the normal webhook path, decided by the recipient:

| `SANDBOX_NUMBERS.` | Number           | Outcome                                                             |
| ------------------ | ---------------- | ------------------------------------------------------------------- |
| `delivered`        | `+4915550000001` | delivered (also every number not listed here)                       |
| `read`             | `+4915550000002` | delivered, then read (WhatsApp and RCS)                             |
| `notOnWhatsApp`    | `+4915550000003` | WhatsApp fails `META_131026`, the next channel delivers             |
| `rcsNotCapable`    | `+4915550000004` | RCS fails `TWILIO_63036`, the next channel delivers                 |
| `undelivered`      | `+4915550000005` | accepted, then failed on every channel                              |
| `rejected`         | `+4915550000006` | refused at send time (`SANDBOX_REJECTED`)                           |
| `uncertain`        | `+4915550000007` | timeout after the request was written (`uncertain`)                 |
| `inactive`         | `+4915550000008` | HLR `active: false` (`NUMBER_INACTIVE` with `blockInactiveNumbers`) |

Telegram sends end as `sent`. Templates submitted to Meta or Twilio are approved at once. `sandbox.simulateInbound({ to | contactId, channel?, text?, buttonPayload?, buttonTitle?, replyTo?, location?, media?: { mime, size?, filename?, caption?, duration?, expired?, mismatch? }, providerMessageId? })` stores an inbound message (the same `providerMessageId` twice returns `{ duplicate: true }`) and generates a synthetic file of the given type and size for the media path. `strapi-plugin-magic-messagegate/testing` exports `SANDBOX_NUMBERS`, `sandboxConfig(extra)`, `drain(strapi)` and `signDelivery(secret, timestamp, body)`. A warning is logged at startup in sandbox mode.

## Outgoing webhook

Settings → Outgoing webhook: an https URL (public host, no redirects; checked again before every delivery) and the events to forward: `message.received`, `message.status` (sent, delivered, read, failed, uncertain, expired), `media.ready`, `media.failed`. **Create signing secret** shows the secret once.

Each delivery is a POST with the JSON body `{ id, event, data, at }` (`data` is the event payload: ids, channel, status, codes; never phone numbers or text) and the headers `X-MessageGate-Event`, `X-MessageGate-Delivery`, `X-MessageGate-Timestamp` (unix seconds) and `X-MessageGate-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`. A `2xx` answer ends it; otherwise it is retried after 1, 5 and 15 minutes, 1 and 6 hours (6 tries). Deliveries are rows claimed with a lease, so each one is sent by one process. Verify like this:

```js
const crypto = require('node:crypto');

function verifyMessageGate(rawBody, headers, secret, toleranceSeconds = 300) {
  const timestamp = headers['x-messagegate-timestamp'];
  const signature = String(headers['x-messagegate-signature'] || '');
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = `v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

Use the delivery id to ignore repeats.

## Events (`strapi.eventHub`)

No phone numbers, names or message text in any payload. Every event is emitted by exactly one process.

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
| `messagegate.message.received`        | `{ inboundId, contactId, channel, replyTo, kind, buttonPayload?, media?: { status }, at }`     |
| `messagegate.media.ready`             | `{ inboundId, fileId, mime, size, at }` (`fileId` is the media library id)                     |
| `messagegate.media.failed`            | `{ inboundId, code, at }`                                                                      |
| `messagegate.contact.opted-out`       | `{ channel, at }`                                                                              |
| `messagegate.contact.unreachable`     | `{ channel: 'whatsapp', at }`                                                                  |
| `messagegate.template.status-changed` | template id, key, language, new status                                                         |

```js
strapi.eventHub.on('messagegate.message.read', ({ messageId, templateKey }) => {
  /* … */
});
```

## Error codes

| Code                          | HTTP | When                                                                                 |
| ----------------------------- | ---- | ------------------------------------------------------------------------------------ |
| `INVALID_REQUEST`             | 400  | body does not match the schema                                                       |
| `INVALID_PHONE`               | 400  | not a valid mobile number                                                            |
| `MISSING_VARIABLE`            | 400  | a required template variable is missing (`details.field`)                            |
| `INVALID_VARIABLE`            | 400  | a variable is too long or unknown, or the rendered Telegram text is too long         |
| `CONFIG_INVALID`              | 400  | account, template or settings configuration is invalid (`details.field`)             |
| `ATTACHMENT_TYPE_NOT_ALLOWED` | 400  | the file type is not on the allow-list                                               |
| `ATTACHMENT_TYPE_MISMATCH`    | 400  | the bytes, name or declared type do not match                                        |
| `ATTACHMENT_URL_INVALID`      | 400  | not a public `https` URL (`details.reason`), or no `publicUrl` for a local file      |
| `ATTACHMENT_TOO_LARGE`        | 400  | larger than every channel in the chain allows                                        |
| `WEBHOOK_URL_INVALID`         | 400  | the outgoing webhook URL is not public `https`                                       |
| `INVALID_SIGNATURE`           | 401  | webhook signature check failed                                                       |
| `FORBIDDEN`                   | 403  | Content API without an API token, or a paid lookup without `contacts.manage`         |
| `SANDBOX_ONLY`                | 403  | sandbox route or service outside `providers.mode: 'sandbox'`                         |
| `NOT_FOUND`                   | 404  | unknown message, inbound message, contact, template or account                       |
| `UNKNOWN_TEMPLATE`            | 404  | no active template with this key for the channel                                     |
| `ATTACHMENT_NOT_FOUND`        | 404  | the media library file does not exist                                                |
| `TEMPLATE_NOT_APPROVED`       | 409  | WhatsApp template not approved by Meta yet, or RCS card not created on Twilio        |
| `NO_CONSENT`                  | 409  | no granted consent for the channel                                                   |
| `SUPPRESSED`                  | 409  | contact suppressed (opted out, blocked the bot, not on WhatsApp)                     |
| `WINDOW_CLOSED`               | 409  | free text outside the 24-hour WhatsApp window (use a template)                       |
| `NO_ACCOUNT`                  | 409  | no active account for the channel                                                    |
| `NO_ROUTE`                    | 409  | no channel in the chain can reach the contact                                        |
| `NOT_LINKED`                  | 409  | contact has not linked Telegram                                                      |
| `RCS_NOT_CAPABLE`             | 409  | the number cannot receive RCS (learned from Twilio 63036)                            |
| `NUMBER_INACTIVE`             | 409  | HLR says the number is not assigned (`lookup.blockInactiveNumbers`)                  |
| `ATTACHMENT_UNSUPPORTED`      | 409  | no channel in the chain can carry the attachment                                     |
| `MEDIA_NOT_READY`             | 409  | inbound file pending, quarantined or failed (`details.status`, `details.code`)       |
| `MEDIA_NOT_STORED`            | 409  | inbound files are not stored (`inboundMedia.storage: 'none'`)                        |
| `DEADLINE_PASSED`             | 409  | `notAfter` has passed                                                                |
| `STATE_CHANGED`               | 409  | the message changed meanwhile (retry/discard race)                                   |
| `CONFIRMATION_REQUIRED`       | 409  | retrying an `uncertain` message without `confirmDuplicateRisk`                       |
| `PAYLOAD_PURGED`              | 409  | the message content was already removed by retention                                 |
| `LOOKUP_DISABLED`             | 409  | paid lookup (Twilio or HLR) not configured                                           |
| `EMBEDDED_SIGNUP_DISABLED`    | 409  | Meta Embedded Signup not configured on the server                                    |
| `RATE_LIMITED`                | 429  | too many requests                                                                    |
| `LOOKUP_BUDGET_EXCEEDED`      | 429  | monthly lookup budget used up                                                        |
| `PROVIDER_ERROR`              | 502  | the provider rejected an admin action (template submit, sample upload, account test) |

Provider error codes in `errorCode` and timelines are prefixed: `META_131026`, `TG_403`, `SEVEN_…`, `TWILIO_63036`, plus `TIMEOUT`, `LEASE_EXPIRED_DURING_SEND`, `DEADLINE_PASSED`, `SANDBOX_REJECTED`. Inbound media codes are listed under "Inbound media".

## Webhooks (configured by the owner, not called by apps)

`GET|POST /api/magic-messagegate/webhooks/:provider/:path`, where `:path` is a random id per account shown in the admin (Meta app-level URL: `/webhooks/meta/app`). Every POST must carry the provider signature (`X-Hub-Signature-256`, `X-Telegram-Bot-Api-Secret-Token`, seven.io `X-Signature`, `X-Twilio-Signature`); otherwise `401` without detail. Events are deduplicated (inbound messages by provider message id), and Meta retries for up to 36 hours. Telegram webhooks are registered for `message` and `callback_query` updates; run **Test** once on an existing Telegram account after updating to 1.1 so button presses arrive.
