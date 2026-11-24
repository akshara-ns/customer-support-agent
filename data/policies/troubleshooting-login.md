---
id: troubleshooting-login
title: Troubleshooting Sign-in, 2FA and SSO
doc_type: troubleshooting
tiers: [free, pro, enterprise]
---

# Troubleshooting Sign-in, 2FA and SSO

## Password reset not arriving

1. Ask the customer to check spam and any email filtering rules for messages from no-reply@fernway.example.
2. Reset links expire after 30 minutes; request a new one if it is older.
3. If the customer signs in with Google, there is no Fernway password to reset; they should use "Continue with Google".

## Lost two-factor authentication device

1. The customer can sign in with one of the 10 backup codes generated when 2FA was set up. Each code works once.
2. If they have no backup codes, verify their identity (email on file plus support PIN). A 2FA reset is then placed on a 48-hour security hold before it takes effect, and the workspace owner is notified.
3. Never disable 2FA immediately on request.

## SAML single sign-on errors

<!-- tiers: enterprise -->

SAML SSO is available on Enterprise only.

- "Invalid audience": the Entity ID configured in the identity provider must exactly match the one shown under Settings > Security > SSO.
- "Assertion expired" or "not yet valid": the identity provider's server clock is off by more than 3 minutes. Ask the IT admin to sync the clock (NTP).
- Sign-in stopped working for everyone at once: the identity provider's signing certificate was probably rotated. The admin must upload the new certificate in Fernway.
- Users missing after setup: SCIM provisioning only creates users assigned to the Fernway app in the identity provider.

## Google sign-in problems

<!-- tiers: free, pro -->

If "Continue with Google" fails with "account not found", the Google account email does not match a Fernway member. The workspace admin should invite that exact email address.
