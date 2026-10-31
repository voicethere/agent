# Webhooks

Acme Cloud can call your server when something happens in a project. Add an endpoint URL under Settings, then Webhooks.

## Signatures

Every request carries an `X-Acme-Signature` header. It holds an HMAC-SHA256 of the raw body, keyed with the endpoint secret. Reject requests whose signature does not match.

## Retries

If your server answers with a status outside 200 to 299, Acme retries the delivery after 1 minute, 10 minutes and 1 hour, then gives up.
