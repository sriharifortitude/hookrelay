# 0001. Standard Webhooks signatures rather than a home-grown scheme

**Status:** accepted

## Decision

Deliveries carry `webhook-id`, `webhook-timestamp` and `webhook-signature`
exactly as https://www.standardwebhooks.com specifies: HMAC-SHA256 over
`id.timestamp.body`, base64, `v1,` prefixed, secrets in `whsec_` form. The
implementation is tested against the specification's worked example.

## Reasoning

The receiver is somebody else's code. A scheme of our own would be one more
thing a customer had to implement correctly, in every language they use,
from our documentation. Standard Webhooks has published verifiers for the
common languages and is what Svix and a growing list of providers emit; a
customer who already receives webhooks from one of them verifies ours with
the code they have.

Signing the id and timestamp with the body is what makes a captured
delivery useless outside its five-minute window and under any other message
id. A body-only HMAC would not.

## Costs

The header names are fixed by the spec, so they cannot be made "ours". That
is the point.
