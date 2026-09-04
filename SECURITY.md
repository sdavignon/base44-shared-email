# Security

Please do not open a public issue for a vulnerability that could expose email, credentials or webhook access.

Report security concerns privately to `hello@1976.cloud` with the package version, affected file or function, and enough detail to reproduce the problem safely.

The package never needs provider secrets in browser code. Keep `SENDGRID_API_KEY` and `RESEND_API_KEY` in Base44 backend secrets only. Configure `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` and `SENDGRID_INBOUND_WEBHOOK_PUBLIC_KEY` with the ECDSA verification keys issued for the corresponding SendGrid webhooks; requests without a valid signature are rejected.

Maintenance functions require an authenticated Base44 administrator. AI-assisted sends require a short-lived, single-use confirmation token bound to the exact mailbox, recipients, subject, and body shown in the preview.
