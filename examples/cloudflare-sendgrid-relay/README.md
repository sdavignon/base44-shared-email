# Signed SendGrid events for a private Site

Use this optional Cloudflare Worker only when a hosting platform's site-wide sign-in gate prevents SendGrid from reaching an otherwise correct webhook. A normal public Base44 webhook already verifies SendGrid signatures and does not need this extra component. This example is independent of the Base44 installer.

**SendGrid remains the email sender.** The Worker receives delivery/engagement events; it never calls the Mail Send API. This example does not support Inbound Parse or uploaded email attachments.

```text
SendGrid -- signed event batch --> public Worker
         -- same signed body + private hosting credential --> private Site webhook
         -- durable event storage / suppression / analytics --> 2xx acknowledgement
```

The dashboard, contacts, sending routes, and Sites access policy stay private. The only public Worker path is `POST /api/webhooks/sendgrid`. It rejects invalid signatures, limits payloads to 2 MiB while streaming, forwards to one operator-configured HTTPS destination, does not follow redirects, and returns a failure if the application fails. It never forwards incoming cookies or arbitrary authorization headers, logs bodies, or exposes upstream response bodies.

## Files

- `src/worker.js`: receiver and constrained forwarding.
- `src/sendgrid-signature.js`: ECDSA P-256/SHA-256 verification, including SendGrid DER signatures and timestamp validation.
- `wrangler.example.jsonc`: placeholders only; copy to ignored `wrangler.jsonc` for a real installation.
- `../../test/cloudflare-relay.test.js`: executable offline tests; no real provider calls or emails.

Run tests from the repository root with `npm test`. Use the repository's supported Node.js version and a current authenticated Wrangler CLI to deploy the example.

## Configure and deploy

1. Confirm the existing endpoint fails at the hosting login gate. If the application itself rejects a signature, fix its key/raw-body verification instead. Do not add a relay solely because a webhook-settings API returns 403.
2. Copy `wrangler.example.jsonc` to `wrangler.jsonc` in this directory. Choose a unique Worker name and set `UPSTREAM_WEBHOOK_URL` to the exact private application's event endpoint. Set `RECEIVER_URL` to the Worker's deployed HTTPS URL plus `/api/webhooks/sendgrid`. Keep both URLs free of credentials, queries, and fragments. Never derive the upstream URL from an incoming request.
3. In SendGrid, open the intended Event Webhook and leave **Signed Event Webhook** enabled. Copy its **verification public key**. This is different from the SendGrid sending API key. Do not generate or expose SendGrid's private signing key.
4. Obtain the selected private Site's existing hosting access token through its authorized administration tools. Do not rotate it casually: other integrations may use it. This credential can bypass the Site login, so store it only as a Worker secret. The Worker needs no SendGrid API key and no access to the Site database.
5. From this example directory, deploy the code and set the two values using the interactive secret prompts:

   ```sh
   npx wrangler deploy --config wrangler.jsonc
   npx wrangler secret put SITES_GATE_TOKEN --config wrangler.jsonc
   npx wrangler secret put SENDGRID_VERIFICATION_KEY --config wrangler.jsonc
   ```

   The first deployment rejects callbacks until both values are set. Enter secret values only at the prompts; do not paste them into commands, checked-in files, screenshots, issue bodies, or logs. The verification key is public cryptographic material, but this example also keeps it out of the repository as installation-specific configuration.

6. Deploy the application's signed webhook handler before pointing SendGrid at the receiver. Preserve the private hosting access policy. On OpenAI Sites, the Worker supplies `OAI-Sites-Authorization: Bearer ...` for the hosting gate; the application must still verify the original SendGrid signature independently.
7. In the existing SendGrid webhook, replace only its Post URL with `RECEIVER_URL`. Preserve signing and the required events: Processed, Delivered, Opened, Clicked, Bounced, Dropped, Spam Reports, and Unsubscribed. Keep any additional events required by the application. Run **Test Integration**, verify receipt inside the application, then save and confirm the persisted URL. This test sends sample event payloads, not a newsletter.

For a local signing test, use a newly generated fixture key pair. Never copy production secrets into a test fixture. Local `.dev.vars`, `.env*`, Wrangler state, and real configuration are ignored and must not be published.

## Required application handler behavior

The relay does not implement event processing, deduplication, or application readiness. The upstream handler must:

1. Read the unmodified UTF-8 request body and verify the two original `x-twilio-email-event-webhook-*` headers with the same public key. This verifier's argument order is `(publicKey, signature, timestamp, rawBody)`; the Base44 template helper has a different argument order and accepts body bytes.
2. Parse an array only after successful verification. Validate event fields and ownership before touching contacts or campaigns.
3. Deduplicate by `sg_event_id` in durable storage using an atomic unique constraint. A timestamp window alone does not prevent replay. This verifier permits up to 25 hours of age for provider retries and five minutes of future clock skew.
4. Persist events and apply suppression for the appropriate brand. Return 2xx only after successful processing; propagate failure so SendGrid can retry.
5. Keep provider test samples and events without a known application brand out of contact records and campaign analytics. They may provide separate connection evidence.

For a JavaScript Site using this example's verifier, the authentication portion is:

```js
const rawBody = await request.text();
const verified = await verifySendGridSignature(
  env.SENDGRID_VERIFICATION_KEY,
  request.headers.get('x-twilio-email-event-webhook-signature'),
  request.headers.get('x-twilio-email-event-webhook-timestamp'),
  rawBody,
);
if (!verified) return new Response('Unauthorized webhook', { status: 401 });
// Validate JSON, deduplicate and store events before returning success.
```

The forwarded `x-marketingcloud-webhook-receiver` header identifies the configured ingress for applications that track connection evidence. It is **not an authentication credential**. Trust connection evidence only after signature verification, and bind it to the current verification key and receiver URL. Never unlock sending solely because a key is present or because a settings lookup failed. If a restricted SendGrid key cannot read webhook settings, distinguish that permission error from signed receiver health. Applications may require a fresh integration test when stored evidence expires or configuration changes.

## Verify and troubleshoot

| Check | Expected result |
| --- | --- |
| Unsigned POST of `[]` to the receiver | 401; no forwarding |
| GET of the receiver | 405; no data |
| Any unrelated receiver path | 404 |
| SendGrid Test Integration | All required signed event types reach the application |
| Application's receipt/readiness endpoint | Current key/receiver evidence, without exposing credentials |
| Private dashboard without login | Remains inaccessible |
| Contacts and campaigns after integration samples | No synthetic contacts or campaigns |

A 401 from the receiver usually means a missing, wrong, stale, or altered signature. A 503 means configuration is incomplete. A 502 means the application did not acknowledge the batch: check the hosting credential, upstream URL, deployed verification key, and handler errors. Do not fix this by disabling signature verification or making the whole application public. A settings API 403 is separate from callback delivery; grant only the needed read permission if API inspection is required.

If a hosting token rotates, update the Worker secret and test again. If SendGrid's verification key changes, update the Worker and the upstream application together, then deploy/apply each platform's configuration and test. To retire the receiver, first move or disable the specific SendGrid webhook and confirm its replacement works, then remove the Worker and its secret. Never leave SendGrid pointing to an inactive receiver.

## Public repository hygiene

This directory contains reusable source and example domains only. Do not add real account IDs, private Site IDs, webhook IDs, customer lists, messages, personal addresses, operational logs, access tokens, or installation-specific configuration. Before publishing, review the exact diff, package contents, and commit author/committer metadata. Use the GitHub-provided noreply address when personal email privacy is required. Secret scanning is useful but does not prove the absence of all sensitive information, especially in old commits, forks, caches, or downloaded copies.

## References

- [SendGrid signed webhook verification and raw-body requirements](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
