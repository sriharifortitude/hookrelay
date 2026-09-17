# 0003. Redirects from receivers are failures

**Status:** accepted

## Decision

The transport sets `maxRedirections: 0`. A 3xx response is recorded as a
failed attempt and, being a 3xx, is not retried.

## Reasoning

Endpoint URLs are screened at registration against private and link-local
address space. A redirect is the receiver instructing the sender where to
send the next request -- to an address that was never screened. Following
it would turn the screening into a formality and the service into an SSRF
relay: register `https://attacker.example/`, respond with a 302 to
`http://169.254.169.254/`, and the worker fetches cloud credentials.

It also protects the customer: the signed body goes to the URL they
registered and nowhere else.

## Costs

A receiver behind a redirecting load balancer must register the final URL.
The delivery log shows the 3xx, so the reason is visible.
