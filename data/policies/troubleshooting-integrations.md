---
id: troubleshooting-integrations
title: Troubleshooting Integrations and Webhooks
doc_type: troubleshooting
tiers: [free, pro, enterprise]
---

# Troubleshooting Integrations and Webhooks

## Slack notifications not arriving

Slack is available on every tier.

1. In Fernway, open Settings > Integrations > Slack and check the connection status.
2. If the Slack app was removed from the Slack workspace, click Reconnect.
3. For private Slack channels, the Fernway app must be invited to the channel with /invite @Fernway.

## GitHub integration

<!-- tiers: pro, enterprise -->

The GitHub integration is available on Pro and Enterprise.

- Issues and pull requests stop linking when the GitHub authorization expires or is revoked. A workspace admin must click Reauthorize under Settings > Integrations > GitHub.
- Only repositories the authorizing GitHub user can access are visible to Fernway.

## Outgoing webhooks

<!-- tiers: pro, enterprise -->

Webhooks are available on Pro and Enterprise.

- Failed deliveries are retried 5 times with exponential backoff over 24 hours.
- A webhook endpoint that keeps failing for 24 hours is disabled automatically and the admin is emailed. Re-enable it under Settings > Integrations > Webhooks after fixing the endpoint.
- Every delivery is signed with the X-Fernway-Signature header (HMAC-SHA256 with the endpoint's signing secret). Signature mismatches usually mean the receiver is hashing a re-serialized body instead of the raw request body.
