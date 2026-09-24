# base44-shared-email

A reusable shared inbox and email-admin feature for Base44 sites, built by [1976.cloud](https://1976.cloud).

It installs the same practical workflow used in production-style Base44 admin areas: inbox, threaded messages, drafts, compose/reply, sent mail, junk/trash, delivery status, multiple mailbox aliases, provider settings, and per-user view/send permissions.

## Why it is an installer

Base44 backend resources live in each app's source tree. A runtime-only React package cannot declare or deploy the app's entities, functions and workflows. This package therefore installs a namespaced, reviewable feature into an existing Base44 project and records exactly what it owns.

## Quick start

From an existing Base44 site's repository:

```sh
npm install --save-dev github:sdavignon/base44-shared-email
npx base44-shared-email install \
  --brand "Example Company" \
  --domain example.com \
  --mcp
```

This repository is the current distribution source. If the package is later published to npm, the GitHub install line can be replaced with `npm install --save-dev base44-shared-email`.

Then follow the generated `base44-shared-email.install.md` in that site. Preview first with `--dry-run` if desired.

Requirements:

- Node.js 20 or later
- An existing Base44 repository with `base44/config.jsonc`
- React and `@base44/sdk`
- SendGrid or Resend credentials

## Commands

```sh
# Install or safely update package-owned files
npx base44-shared-email install --brand "Example" --domain example.com
npx base44-shared-email upgrade --brand "Example" --domain example.com

# Preview generated changes
npx base44-shared-email diff --brand "Example" --domain example.com

# Check files, route wiring and required dependencies
npx base44-shared-email doctor --target .

# Remove executable/UI files but preserve entity schemas and stored data
npx base44-shared-email uninstall --target . --yes
```

Use `--include-data-model` with uninstall only when you deliberately want the generated entity schemas removed too. Base44 data deletion is a separate platform operation; this command never silently destroys remote data.

## Install options

| Option | Default | Purpose |
| --- | --- | --- |
| `--target` | `.` | Existing Base44 project |
| `--brand` | required | Site-facing brand name |
| `--domain` | required | Managed email domain |
| `--mailbox` | `hello@DOMAIN` | Initial mailbox address |
| `--inbound-domain` | `inbound.DOMAIN` | SendGrid Inbound Parse hostname |
| `--route` | `/admin/email` | Suggested admin route |
| `--client-import` | `@/api/base44Client` | Site's Base44 client module |
| `--auth-import` | `@/lib/AuthContext` | Site's auth-context module |
| `--mcp` | off | Add OAuth App MCP support and a least-privilege email agent |
| `--dry-run` | off | Show the plan without writing |
| `--force` | off | Back up and replace conflicts |

## What is installed

- Eight core `SharedEmail*` entity schemas; optional MCP support adds an admin-only send-confirmation entity. The site's `User` entity is not modified.
- Seven core backend functions for the admin API, sending, inbound parsing, event tracking, status, polling and reconciliation.
- Optional OAuth App MCP support with a dedicated email assistant and confirmation-gated send tool.
- An hourly status/reconciliation workflow.
- A dependency-light React admin UI using the target site's React, Base44 client and utility CSS.
- A site-specific integration guide.
- `.base44-shared-email.json`, which records config and hashes for safe upgrades/uninstall.

All backend resources and generated frontend folders are namespaced to reduce collisions. Existing package-owned files are updated only when they still match their recorded hash. A conflict stops the install; `--force` first saves the original under `.base44-shared-email-backup/`.

## Security model

- Every user-facing request requires a Base44 user; maintenance calls additionally require an administrator.
- Base44 admins can administer all enabled aliases.
- Non-admins require an enabled `SharedEmailAccessGrant` for each mailbox.
- View and send permissions are separate and checked in backend functions, not merely hidden in the UI.
- Maintenance functions require an authenticated Base44 administrator.
- SendGrid Event Webhooks verify the provider's ECDSA signature against the unmodified request body. Inbound Parse accepts either that signature or a separate high-entropy URL secret.
- Provider keys are read only in backend functions.
- Generated entity schemas are admin-only; permitted non-admin access is mediated by functions using explicit grants.

Provider setup and DNS are intentionally not automated. They are domain-sensitive changes and must be reviewed in each site's hosting and provider accounts.

### SendGrid Inbound Parse authentication

The receiving Base44 app must have a **backend secret named exactly**
`SENDGRID_INBOUND_WEBHOOK_PUBLIC_KEY`. Set its value to the ECDSA **public key**
from the SendGrid Inbound Parse security policy attached to that domain's Parse
webhook. This is distinct from `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` (delivery
events) and `SENDGRID_API_KEY` (provider API access). The inbound handler reads
the secret by this exact name and accepts signed requests when a valid
SendGrid signature is present. A public key is **not** a shared secret.

If the Parse setting does not have a signed security policy, set a distinct,
random, at-least-32-character Base44 backend secret named
`SENDGRID_INBOUND_PARSE_SECRET`. Append `?secret=<that value>` to the SendGrid
Parse destination URL. Never use `SENDGRID_INBOUND_WEBHOOK_PUBLIC_KEY`, a
SendGrid API key, or an Event Webhook key as the query secret. Treat the URL as
sensitive: do not commit it or paste it into logs, tickets, or screenshots.
Signing remains the preferred option because query strings can leak through
request logs. The receiver accepts either configured method and returns `401`
if neither authenticates.

Setup checklist:

1. Choose one authentication method for the Parse setting: attach a SendGrid
   Signature Verification policy and store its public key under
   `SENDGRID_INBOUND_WEBHOOK_PUBLIC_KEY`, **or** set
   `SENDGRID_INBOUND_PARSE_SECRET` in Base44 and append its value as the
   destination URL's `secret` parameter. Redeploy the inbound function after
   changing backend secrets.
2. Set the Parse destination to the deployed `shared-email-sendgrid-inbound`
   function URL and configure the hostname's receiving MX record separately.
   A lower-priority-number MX pointing to
   another mail host will receive mail first; merely adding SendGrid as a
   higher-number backup MX will not mirror messages to Inbound Parse. Preserve
   any existing mailbox service when choosing the receiving hostname.
3. Send a real test message to an enabled mailbox alias, then check the SendGrid
   Parse response, Base44 function logs, and the inbox. From this handler, a
   `401` means authentication failed; a `202` with `ignored` means no
   enabled alias matched; a `500` requires inspection of the function error.
   A successful provider callback alone does not prove the message appeared in
   the inbox.

See [SendGrid's Inbound Parse security-policy guide](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks)
for how to obtain and attach the public key. The generated site-specific
`base44-shared-email.install.md` also lists this secret and the full verification
checklist. Never commit the key value.

## AI assistant access with App MCP

Pass `--mcp` during install or upgrade to add [Base44 App MCP](https://docs.base44.com/Integrations/app-mcp) OAuth configuration, a `shared_email_assistant` agent, and a narrow backend tool for inbox, thread, draft and send operations.

The generated agent does not receive raw entity access. It works through the same backend mailbox grants as the admin UI, and sending is a two-step operation: it must return an exact preview first, then receive explicit user confirmation before delivery. The backend issues a five-minute, single-use token bound to the exact mailbox, recipients, subject and body; changed or replayed requests are rejected. After deployment, use **Dashboard → MCP → Tool access** to enable `shared_email_assistant` and disable raw `SharedEmail*` entity tools unless a specific role truly needs them. Publish again after changing tool access.

The generated `base44-shared-email.mcp.md` includes connection and verification steps for Claude, ChatGPT, Cursor and other Streamable HTTP clients.

## Provider support

| Capability | SendGrid | Resend |
| --- | --- | --- |
| Outbound | Yes | Yes |
| Delivery events | Yes | Polling |
| Inbound | Yes, Inbound Parse | Use SendGrid inbound |

Inbound attachments are stored in Base44 private file storage. Authorized mailbox viewers receive short-lived links from the shared-email API; test an actual attachment before declaring a site's inbound setup complete.

### Event webhooks behind a private hosting login

SendGrid sends email directly. A separate receiver is only needed when the hosting platform blocks provider callbacks behind a site-wide login and cannot exempt the webhook route. Ordinary Base44 apps with publicly reachable signed webhook functions do not need this relay.

The optional [Cloudflare signed-event relay example](examples/cloudflare-sendgrid-relay/README.md) includes source code, configuration, tests, deployment steps, and verification instructions for private OpenAI Sites. It forwards authenticated delivery events to one configured endpoint while keeping the application private. It is separate from the Base44 installer and does not send email or handle Inbound Parse.

## Development

```sh
npm test
npm run lint
npm run pack:check
```

The package has no runtime dependencies. It is released under the MIT License.

## Credits and support

Built and maintained by [1976.cloud](https://1976.cloud). Issues and contributions are welcome at [github.com/sdavignon/base44-shared-email](https://github.com/sdavignon/base44-shared-email).
