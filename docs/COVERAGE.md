# Open Cloud coverage

Checked 2026-10-28 against Roblox's published OpenAPI spec
(`Roblox/creator-docs` → `content/en-us/reference/cloud/openapi.json`).

Everything UpdateDay does uses an **Open Cloud API key** (`x-api-key`). No cookie,
no Connect/OAuth app and no server of ours.

| Feature | Endpoint | Scope | Stability |
|---|---|---|---|
| Game icon (countdown) | `POST /legacy-game-internationalization/v1/game-icon/games/{universeId}/language-codes/{lang}` (multipart `Files`) | `legacy-universe:manage` | Experimental |
| Game page thumbnails | `POST .../game-thumbnails/games/{universeId}/language-codes/{lang}/image`, `.../images/order`, `DELETE .../images/{imageId}` | `legacy-universe:manage` | Experimental |
| Game name / description | `PATCH /legacy-game-internationalization/v1/name-description/games/{universeId}` | `legacy-universe:manage` | Experimental |
| Name / description (alt) | `PATCH /cloud/v2/universes/{u}/places/{rootPlace}?updateMask=displayName,description` | `universe.place:write` | Stable |
| Game pass sale | `PATCH /game-passes/v1/universes/{u}/game-passes/{id}` (multipart `price`) | `game-pass:read`, `game-pass:write` | Beta |
| Dev product sale | `PATCH /developer-products/v2/universes/{u}/developer-products/{id}` (multipart `price`) | `developer-product:read`, `developer-product:write` | Beta |
| Roblox event | `POST /virtual-events/v3/universes/{u}/game-events` | `universe.event:write` | Experimental |
| Player data | `/cloud/v2/universes/{u}/data-stores/{store}/entries/{key}` (`If-Match` etag) | `universe-datastores.objects:*` | Stable |
| Publish place at update time | `POST /universes/v1/{u}/places/{p}/versions?versionType=Published` | `universe-places:write` | Beta |
| Restart / bleed-off servers | `POST /cloud/v2/universes/{u}:restartServers` | `universe:write` | Stable |
| In-game broadcast | `POST /cloud/v2/universes/{u}:publishMessage` | `universe-messaging-service:publish` | Stable |
| Player notifications | `POST /cloud/v2/users/{userId}/notifications` | `user.user-notification:write` | Stable |

## Caveats

- **Experimental endpoints** (icon, thumbnails, name/description, events) can change
  without notice. They're wrapped in one place (`src/openCloud.ts`) so a break is a
  one-file fix.
- **Silent no-ops:** Roblox notes that a key missing a scope may return success
  without applying a change. Every write in UpdateDay is followed by a read-back.
- **Event thumbnails:** the create body takes a `thumbnails` array, but the spec
  doesn't document its item shape. Needs a live test.
- **Language code:** the icon / name endpoints are per language. Writing the
  game's source language (usually `en`) updates the primary icon / name. Needs a live
  test to confirm.
- **Rate limits:** about 3 writes/sec for dev products, 5/sec for passes, and 30/min for place
  publishing. Bulk sales are throttled.

## Live findings (2026-10-28, private test game)

- **Main icon:** the API key can't set the source-language icon (error 26). The source-language swap works:
  switch the source, upload the icon for the old source language, delete it before switching back.
- **Name / description:** `PATCH /cloud/v2/universes/{u}/places/{rootPlace}` with `universe.place:write`
  changes the public name and description.
- **Automatic translation:** Roblox auto-translates a new description into every supported language
  within seconds. Restoring the source description to *empty* does **not** clear those translations;
  they have to be blanked per language with `PATCH .../name-description/games/{u}`. Any name or
  description change must check the translations after restoring.
- **Sales:** passes and products PATCH + read-back work; 28 items took about 33 s each way.
- **Events:** creation works on a private game.
