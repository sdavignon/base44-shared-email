# Security

Please do not open a public issue for a vulnerability that could expose email, credentials or webhook access.

Report security concerns privately to `hello@1976.cloud` with the package version, affected file or function, and enough detail to reproduce the problem safely.

The package never needs provider secrets in browser code. Keep `SENDGRID_API_KEY` and `RESEND_API_KEY` in Base44 backend secrets only. Configure `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` and `SENDGRID_INBOUND_WEBHOOK_PUBLIC_KEY` with the ECDSA verification keys issued for the corresponding SendGrid webhooks. If Inbound Parse has no signed security policy, use a distinct high-entropy `SENDGRID_INBOUND_PARSE_SECRET` backend secret and a matching `secret` query parameter in its destination URL. Do not reuse a public key or API key as that secret. Protect the full URL from logs and screenshots. Inbound requests without a valid signature or secret are rejected.

Maintenance functions require an authenticated Base44 administrator. AI-assisted sends require a short-lived, single-use confirmation token bound to the exact mailbox, recipients, subject, and body shown in the preview.

The optional Cloudflare event receiver uses a hosting access credential only as a Worker secret, forwards to a fixed configured endpoint, and independently verifies signed SendGrid events. Keep installation-specific configuration and operational logs out of this public repository. Review commit author/committer addresses as well as file contents before publishing; use your GitHub-provided noreply address when appropriate. See the [receiver guide](examples/cloudflare-sendgrid-relay/README.md) for deployment and verification.
