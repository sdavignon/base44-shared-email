# Security

Please do not open a public issue for a vulnerability that could expose email, credentials or webhook access.

Report security concerns privately to `hello@1976.cloud` with the package version, affected file or function, and enough detail to reproduce the problem safely.

The package never needs provider secrets in browser code. Keep `SENDGRID_API_KEY`, `RESEND_API_KEY` and `SHARED_EMAIL_WEBHOOK_SECRET` in Base44 backend secrets only.
