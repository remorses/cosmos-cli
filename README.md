<div align='center' class='hidden'>
    <br/>
    <br/>
    <h3>cosmos-cli</h3>
    <p>Search cosmos.so and download image and video assets, as typed data.</p>
    <br/>
    <br/>
</div>

`cosmos` searches [cosmos.so](https://www.cosmos.so) like the site's search page and returns every element as data: **original media URLs**, sizes, AI caption, source URL and author, gif and video variants, product and website info. It can download the original files. It calls the site's GraphQL API from Node with your login token, copied once from Chrome through [playwriter](https://playwriter.dev). No clicks, no scraping.

```bash
cosmos search "paper texture" --type image --limit 100 --download ./assets
cosmos element https://www.cosmos.so/e/764119920
cosmos collection maratorresg/paper-texture --limit 1000 --download ./paper
```

## Features

- **Search** elements with the site filters: content type, sort order, one or two colors, only your saved elements
- **Original files**: `cdn.cosmos.so` URLs of the full image, gif or mp4, plus mp4 and HLS variants and poster images
- **All page data**: caption, size, NSFW flag, AI generated flag, blurhash, source URL, source author, saves count, website title and description, product price and offers, note text
- **Multi image posts**: `cosmos element` returns every image of a carousel
- **Similar elements** and **collections**: search collections, list a collection, browse the "similar" grid
- **Downloads** named `<caption-slug>-<id>.<ext>`, a few files in parallel
- **Typed SDK**, errors returned as values ([errore](https://errore.org))
- **JSON output** on every command with `--json`

## Setup

1. Install the [playwriter extension](https://playwriter.dev) in Chrome and click its icon once so it connects.
2. Log into cosmos.so in that Chrome profile.
3. Install and build:

```bash
git clone https://github.com/remorses/cosmos-cli
cd cosmos-cli
pnpm install
pnpm build
pnpm link --global   # puts `cosmos` on your PATH
```

The first command opens **one** background tab on www.cosmos.so in a purple **cosmos** tab group, reads the login token and closes the tab. Later commands call the API from Node and do not touch Chrome until the token is about to expire (tokens last 7 days).

```bash
cosmos login   # copy the token again, for example after you switch cosmos account in Chrome
```

No Chrome? Add `--anonymous` (or `COSMOS_ANONYMOUS=1`). Search still works; results are not personalized and `--mine` is not available.

If playwriter is connected in more than one browser profile, pick one with `COSMOS_BROWSER_EMAIL=me@example.com`.

## Search

```bash
cosmos search "light paper texture"
cosmos search "film grain overlay" --type image --order popular --limit 200
cosmos search "brutalist poster" --color '#ff0000' --color '#0000ff'
cosmos search "ocean waves" --type video --download ./clips
cosmos search "moodboard" --mine          # only elements you saved
```

Output, one block per element:

```
323 results for "light paper texture" · showing 40

2. https://www.cosmos.so/e/1522356023 · image 563x1000 · saved by divine.luna
   Brown cardboard textured mobile wallpaper by Benjamas.
   https://cdn.cosmos.so/33df68ea-55bc-40d3-8171-acd64562f41b
   source: https://www.rawpixel.com/image/9966281/brown-cardboard-textured-mobile-wallpaper (Carolyne Charron)

more results: --cursor 'cursor://recsys/search?...'
```

| Option | Values |
| --- | --- |
| `--type` | `image`, `video`, `link`, `note` |
| `--order` | `relevant` (default), `latest`, `oldest`, `popular`, `random` |
| `--color` | hex like `#f2e8d5`, repeat once for two colors |
| `--mine` | only elements saved by your account |
| `--limit` | results to fetch across pages (default 40) |
| `--cursor` | continue from the cursor of a previous run |
| `--download <dir>` | save the original files |
| `--kind` | with `--download`, only `image`, `gif` or `video` (repeatable) |

## Elements, similar, collections

```bash
cosmos element 457818511              # all 5 images of a carousel, saves count, source
cosmos similar 764119920 --limit 100  # the "similar" grid of an element page
cosmos collections "paper texture"    # find collections
cosmos collection https://www.cosmos.so/maratorresg/paper-texture --limit 1000
```

## Download

`--download <dir>` works on `search`, `element`, `similar` and `collection`. The `download` command takes element ids or URLs and reads every media of each element first:

```bash
cosmos download 764119920 457818511 --out ./assets
cosmos search "paper texture" --json | jq -r '.elements[].id' | xargs cosmos download --out ./assets
```

Files are named `<caption-slug>-<id>.<ext>`. Multi image elements get `-1`, `-2` suffixes. The extension comes from the CDN content type (`jpg`, `png`, `webp`, `gif`, `mp4`).

Images on cosmos are saved from Pinterest, Behance and other sites. Check `source.url` and `source.isPublicDomain` before reusing an asset in published work.

## SDK

```ts
import { CosmosClient, searchElements, getElement, downloadElements, resizedImageUrl } from 'cosmos-cli'

const client = await CosmosClient.create() // or { anonymous: true }
if (client instanceof Error) throw client

const page = await searchElements({ client, query: 'paper texture', type: 'image', limit: 100 })
if (page instanceof Error) throw page

for (const element of page.elements) {
  console.log(element.url, element.caption, element.media[0]?.url)
}

const preview = resizedImageUrl({ url: page.elements[0]!.media[0]!.url, width: 400 })
const files = await downloadElements({ elements: page.elements, outDir: './assets', kinds: ['image'] })
```

| Function | Returns |
| --- | --- |
| `searchElements({ client, query, type, order, colors, mine, limit, cursor })` | `{ total, nextCursor, elements }` |
| `getElement({ client, element })` | element plus `saves`, `embedHtml` |
| `getSimilarElements({ client, element, limit, cursor })` | `{ total, nextCursor, elements }` |
| `searchCollections({ client, query, limit })` | `{ collections }` |
| `getCollection({ client, collection, limit, cursor })` | `{ collection, total, nextCursor, elements }` |
| `downloadElements({ elements, outDir, kinds, concurrency })` | one `DownloadedAsset` or `DownloadError` per media |

Every function also takes an optional `signal: AbortSignal`.

## How it works

```
cosmos search ...
   │
   ├─▶ read ~/.cosmoscli/session.json  (access token JWT, user id, expiry)
   │      └─▶ missing or expires in < 10 min?
   │             └─▶ playwriter: 1 tab ──▶ www.cosmos.so ──▶ CDP Network.getCookies ──▶ csms_accessToken ──▶ save
   │
   ├─▶ Node fetch POST https://api.cosmos.so/graphql   authorization: Bearer <token>
   │      operations copied from the site: SearchGlobalElements, GetElementDetails,
   │      GetSimilarElements, SearchGlobalClusters, GetClusterElements
   │
   └─▶ media files: plain GET on cdn.cosmos.so (public, no auth)
```

## Shell Completions

```bash
cosmos completions install
```

## Agent notes

- **Read `cosmos --help` in full** before using the CLI. It lists every option.
- **Asset workflow**: search with `--json`, pick elements by `caption`, `media[].width/height` and `media[].kind`, then `cosmos download <ids> --out <dir>`. Use `cosmos element <id>` for carousels: search results can hold fewer media than the element page.
- **Big images**: sort by size with jq, e.g. `jq '[.elements[] | select(.media[0].width >= 1500)]'`.
- **Previews**: the CDN resizes on the fly: `https://cdn.cosmos.so/<id>?format=webp&w=400`. Only for images and gifs, not mp4.
- **`--type video` can return gifs** (`media[].kind: "gif"`). That is cosmos behavior. Filter downloads with `--kind video`.
- **Totals are estimates**: `total` comes from the recommendation engine and may change between pages.
- **An invalid token does not fail**: the API silently answers as anonymous (`--mine` returns nothing). Run `cosmos login` if results look unpersonalized.
- **Nothing is tracked**: the CLI never sends the site's view or "recent search" events, so your cosmos history does not change.
