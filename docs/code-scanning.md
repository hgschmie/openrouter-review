# Code-scanning assessments

## Alert 1: SHA-1 in Undici's WebSocket handshake

[Alert 1](https://github.com/hgschmie/openrouter-review/security/code-scanning/1)
(`js/weak-cryptographic-algorithm`) points to `dist/index.js` in the
v1.2.1 build. The recommended disposition is **false positive**, pending
maintainer review. This document does not dismiss the alert or suppress the rule.

The flagged code comes from the bundled Undici 6.29.1 dependency,
`lib/web/websocket/connection.js`. It computes the expected `Sec-WebSocket-Accept`
header using `createHash('sha1').update(keyValue + uid).digest('base64')`.
The value identified as sensitive by CodeQL, `uid`, is the public protocol
constant `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, declared in
`lib/web/websocket/constants.js`. `keyValue` is a random handshake nonce sent to
the server as `Sec-WebSocket-Key`; neither value is an API key, password, or
user identifier.

[RFC 6455 section 4.2.2](https://www.rfc-editor.org/rfc/rfc6455#section-4.2.2)
requires this SHA-1 calculation for WebSocket interoperability.
[Section 10.8](https://www.rfc-editor.org/rfc/rfc6455#section-10.8) explains that
the handshake does not depend on SHA-1's cryptographic security properties.
Replacing SHA-1 with another hash would break the protocol.

The action uses HTTP requests for GitHub and OpenRouter and does not instantiate
a WebSocket. Undici's CommonJS entry point includes its WebSocket implementation
alongside the HTTP functionality used by the GitHub Actions toolkit, so it is
present in the committed bundle. The finding is not evidence of weak hashing of
the action's credentials.

After reviewing this assessment, dismiss only alert 1 as **false positive**, with
this rationale:

> Undici's RFC 6455 WebSocket handshake hashes a public protocol GUID and a
> public handshake nonce, not sensitive user data. RFC 6455 section 10.8 states
> that this use does not depend on SHA-1's cryptographic security properties.
> The action does not use WebSockets.

Keep CodeQL scanning enabled for the source and committed bundle, including
`js/weak-cryptographic-algorithm`. Reassess if the reported call site, dependency
implementation, or use of WebSockets changes; this assessment does not cover
other uses of SHA-1.
