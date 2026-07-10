<!--
  Reporting contact: confirm security@foundersmcp.com is a real, monitored inbox,
  or replace it with one you watch. The GitHub Security Advisories link is the
  preferred channel and works now that the repo is public.
-->

# Security Policy

We take the security of FoundersOS seriously. FoundersOS connects to your own Supabase project using a service role key that has full database access, so we want any vulnerability handled carefully and privately.

## Reporting a vulnerability

Please do not report security issues through public GitHub issues, discussions, or pull requests.

Instead, use one of these private channels:

- Preferred: open a private report through GitHub Security Advisories at https://github.com/OurThinkTank/founders-os/security/advisories/new
- Email: security@foundersmcp.com

Please include:

- A description of the issue and its potential impact
- Steps to reproduce, or a proof of concept
- The affected version (the get_version output, if you have it)
- Any suggested remediation

## What to expect

- We will acknowledge your report as soon as we can.
- We will investigate and keep you updated on progress.
- Once a fix is available we will release it, and credit you if you would like.

Please give us a reasonable amount of time to address the issue before any public disclosure.

## Supported versions

FoundersOS is pre-1.0 and moving quickly. Security fixes are applied to the latest released version. Please make sure you are on the most recent version before reporting.

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Older versions | No |

## A note on your credentials

FoundersOS is self-hosted. Your `SUPABASE_SECRET_KEY` is the Supabase service role key and has full access to your database. Never commit it to source control or share it publicly. If you believe a key has been exposed, rotate it in your Supabase dashboard immediately.

## Security model

For the full picture of what the service role key can and cannot do, what the tenant boundary actually is when you share a Supabase project with co-founders, and what changes if FoundersOS ever runs as a hosted multi-tenant service, see [`docs/security-model.md`](./docs/security-model.md). Reading it before deploying in any non-trivial configuration is recommended.
