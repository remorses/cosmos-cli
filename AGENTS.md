# cosmos-cli

User docs are in README.md. This file is for agents editing the code.

## Architecture

```
src/cli.ts     goke CLI. Thin: parses options, calls the SDK, prints text or JSON
src/cosmos.ts  SDK: session (token from Chrome), CosmosClient.graphql, queries, normalize, download
```

- **Auth**: `csms_accessToken` cookie on www.cosmos.so is a 7 day JWT. `captureSession()` opens one
  tab through playwriter, reads it with CDP `Network.getCookies` and closes the tab. The JWT `eid`
  claim is the GraphQL `UserId`; `sub` is a different id.
- **API**: POST https://api.cosmos.so/graphql with `authorization: Bearer <token>`. Introspection is
  disabled. Queries are trimmed copies of what the site sends; record new ones with a playwriter
  `page.on('request')` listener and copy `postData`.
- **Invalid tokens fail silently**: search answers as anonymous. That is why the client checks the JWT
  `exp` before every run instead of waiting for an error.
- `searchElements` `filters.userId` means "search this user's library", not personalization. Only set it for `--mine`.
- Media files on cdn.cosmos.so are public. Downloads use plain Node fetch.

## Rules

- Never send the site's tracking mutations (`ViewElement`, `RecordElementView`, `RememberGlobalSearchTerm`).
- Run `pnpm build` (typecheck) and `pnpm test` after changes. Verify on real searches with `node dist/cli.js`.
