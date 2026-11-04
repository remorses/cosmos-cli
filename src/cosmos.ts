// cosmos.so SDK. Calls the site's GraphQL API (api.cosmos.so/graphql) from Node.
// The access token is copied once from the user's Chrome through playwriter (the
// csms_accessToken cookie, a 7 day JWT) and sent as a Bearer token. Chrome is only
// opened again when the saved token is about to expire or the API rejects it.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as errore from 'errore'
import { connectViaExtension, getCDPSessionForPage } from 'playwriter'
import { z } from 'zod'

export const API_URL = 'https://api.cosmos.so/graphql'
export const SITE_URL = 'https://www.cosmos.so'

export const ORDERS = ['relevant', 'latest', 'oldest', 'popular', 'random'] as const
export type Order = (typeof ORDERS)[number]

export const CONTENT_TYPES = ['image', 'video', 'link', 'note'] as const
export type ContentType = (typeof CONTENT_TYPES)[number]

// SearchOrigin values the site sends. SEARCH_BOX is what the search page uses
const SEARCH_ORIGIN = 'SEARCH_BOX'
const MAX_PAGE_SIZE = 100
const REQUEST_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
// refresh the token from Chrome when it expires within this window
const TOKEN_REFRESH_MARGIN_SECONDS = 10 * 60

// ── errors ─────────────────────────────────────────────────────────────────

export class CosmosFetchError extends errore.createTaggedError({
  name: 'CosmosFetchError',
  message: 'Request to $url failed: $reason',
}) {}

export class CosmosApiError extends errore.createTaggedError({
  name: 'CosmosApiError',
  message: 'cosmos API error in $operation: $reason',
}) {}

export class NotLoggedInError extends errore.createTaggedError({
  name: 'NotLoggedInError',
  message:
    'No cosmos login found in Chrome ($reason). Log in at https://www.cosmos.so in the Chrome profile with the playwriter extension, then run `cosmos login`. Or pass --anonymous to search without an account',
}) {}

export class PlaywriterConnectError extends errore.createTaggedError({
  name: 'PlaywriterConnectError',
  message:
    'Cannot connect to Chrome through playwriter: $reason. Open Chrome, click the playwriter extension icon on any tab, then retry. Check with: playwriter session new. Or pass --anonymous to skip Chrome',
}) {}

export class SessionWriteError extends errore.createTaggedError({
  name: 'SessionWriteError',
  message: 'Cannot write the cosmos session to $file',
}) {}

export class InvalidElementError extends errore.createTaggedError({
  name: 'InvalidElementError',
  message: 'Cannot read a cosmos element id from "$input". Pass a numeric id like 1924202323 or a https://www.cosmos.so/e/<id> URL',
}) {}

export class InvalidCollectionError extends errore.createTaggedError({
  name: 'InvalidCollectionError',
  message: 'Cannot read a cosmos collection from "$input". Pass a URL like https://www.cosmos.so/<user>/<slug> or <user>/<slug>',
}) {}

export class ElementNotFoundError extends errore.createTaggedError({
  name: 'ElementNotFoundError',
  message: 'Element $id not found. Open https://www.cosmos.so/e/$id in Chrome to check it',
}) {}

export class CollectionNotFoundError extends errore.createTaggedError({
  name: 'CollectionNotFoundError',
  message: 'Collection $owner/$slug not found or private. Open https://www.cosmos.so/$owner/$slug in Chrome to check it',
}) {}

export class DownloadError extends errore.createTaggedError({
  name: 'DownloadError',
  message: 'Cannot download $url: $reason',
}) {}

// ── session ────────────────────────────────────────────────────────────────

const sessionSchema = z.object({
  accessToken: z.string(),
  /** GraphQL `UserId` (the JWT `eid` claim). Not the same number as `sub` */
  userId: z.number(),
  username: z.string(),
  /** Unix seconds */
  expiresAt: z.number(),
  savedAt: z.string(),
})
export type CosmosSession = z.infer<typeof sessionSchema>

export function sessionPath(): string {
  return path.join(os.homedir(), '.cosmoscli', 'session.json')
}

export async function loadSession(): Promise<CosmosSession | null> {
  const text = await fs.promises.readFile(sessionPath(), 'utf8').catch(() => null)
  if (text === null) return null
  const json = errore.try({ try: (): unknown => JSON.parse(text), catch: () => null })
  const parsed = sessionSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** Atomic write, so parallel `cosmos` processes never read a half-written file */
async function saveSession(session: CosmosSession): Promise<void | SessionWriteError> {
  const file = sessionPath()
  const tmp = `${file}.${process.pid}.tmp`
  return fs.promises
    .mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    .then(() => fs.promises.writeFile(tmp, JSON.stringify(session, null, 2), { mode: 0o600 }))
    .then(() => fs.promises.rename(tmp, file))
    .catch((e) => new SessionWriteError({ file, cause: e }))
}

export function sessionFromToken(accessToken: string): CosmosSession | null {
  const payload = errore.try({
    try: () => JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>,
    catch: () => null,
  })
  if (!payload) return null
  const userId = Number(payload.eid)
  if (!Number.isFinite(userId) || typeof payload.exp !== 'number') return null
  return {
    accessToken,
    userId,
    username: typeof payload.username === 'string' ? payload.username : '',
    expiresAt: payload.exp,
    savedAt: new Date().toISOString(),
  }
}

function isFresh(session: CosmosSession): boolean {
  return session.expiresAt - TOKEN_REFRESH_MARGIN_SECONDS > Date.now() / 1000
}

/**
 * Open www.cosmos.so in one background tab of the user's Chrome, read the
 * csms_accessToken cookie and close the tab. Loading the page lets the site
 * refresh an expired access token with its refresh token cookie.
 */
export async function captureSession(): Promise<CosmosSession | PlaywriterConnectError | NotLoggedInError> {
  const email = process.env.COSMOS_BROWSER_EMAIL
  const connection = await connectViaExtension({
    tabGroup: 'cosmos',
    tabGroupColor: 'purple',
    ...(email && { selectBrowser: (browsers) => browsers.find((b) => b.email === email) }),
  }).catch((e) => new PlaywriterConnectError({ reason: e instanceof Error ? e.message : String(e), cause: e }))
  if (connection instanceof Error) return connection
  await using _connection = connection

  const context = connection.browser.contexts()[0]
  if (!context) return new PlaywriterConnectError({ reason: 'no browser context' })
  const page = await context.newPage().catch((e) => new PlaywriterConnectError({ reason: 'cannot open a tab', cause: e }))
  if (page instanceof Error) return page
  await using _page = page

  const cookies = await (async () => {
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' })
    // context.cookies() fails through the playwriter relay, the page CDP session works
    const cdp = await getCDPSessionForPage({ page })
    const result = await cdp.send('Network.getCookies', { urls: [SITE_URL] })
    return result.cookies as { name: string; value: string }[]
  })().catch((e) => new PlaywriterConnectError({ reason: `cannot read cookies of ${SITE_URL}`, cause: e }))
  if (cookies instanceof Error) return cookies

  const token = cookies.find((c) => c.name === 'csms_accessToken')?.value
  if (!token) return new NotLoggedInError({ reason: 'no csms_accessToken cookie' })
  const session = sessionFromToken(token)
  if (!session) return new NotLoggedInError({ reason: 'csms_accessToken is not a valid JWT' })
  if (!isFresh(session)) return new NotLoggedInError({ reason: 'the access token in Chrome is expired' })
  return session
}

/** Copy a fresh token from Chrome and save it to ~/.cosmoscli/session.json */
export async function login() {
  const session = await captureSession()
  if (session instanceof Error) return session
  const saved = await saveSession(session)
  if (saved instanceof Error) return saved
  return session
}

// ── client ─────────────────────────────────────────────────────────────────

interface GraphqlResponse<T> {
  data?: T | null
  errors?: { message: string; extensions?: { code?: string; violations?: { message: string }[] | null } }[]
}

export class CosmosClient {
  /** Null in anonymous mode */
  session: CosmosSession | null

  private constructor({ session }: { session: CosmosSession | null }) {
    this.session = session
  }

  /**
   * Uses ~/.cosmoscli/session.json, or copies the token from Chrome when it is
   * missing or expires soon. `anonymous: true` never touches Chrome; search
   * still works but results are not personalized and `mine` filters are unavailable.
   */
  static async create({ anonymous = false }: { anonymous?: boolean } = {}) {
    if (anonymous) return new CosmosClient({ session: null })
    const saved = await loadSession()
    if (saved && isFresh(saved)) return new CosmosClient({ session: saved })
    const session = await login()
    if (session instanceof Error) return session
    return new CosmosClient({ session })
  }

  get userId(): number | null {
    return this.session?.userId ?? null
  }

  private async send<T>({
    operation,
    query,
    variables,
    signal,
  }: {
    operation: string
    query: string
    variables: Record<string, unknown>
    signal?: AbortSignal
  }) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        accept: 'application/graphql-response+json,application/json;q=0.9',
        'content-type': 'application/json',
        origin: SITE_URL,
        referer: `${SITE_URL}/`,
        'x-client-name': 'cosmos-web',
        ...(this.session && { authorization: `Bearer ${this.session.accessToken}` }),
      },
      body: JSON.stringify({ operationName: operation, variables, query }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((e) => new CosmosFetchError({ url: API_URL, reason: e instanceof Error ? e.message : String(e), cause: e }))
    if (response instanceof Error) return response
    const body = await (response.json() as Promise<GraphqlResponse<T>>).catch(
      (e) => new CosmosFetchError({ url: API_URL, reason: `HTTP ${response.status}, body is not JSON`, cause: e }),
    )
    if (body instanceof Error) return body
    return body
  }

  /** Run a GraphQL operation. Retries once with a fresh Chrome token when the API answers AUTHENTICATION */
  async graphql<T>(args: { operation: string; query: string; variables: Record<string, unknown>; signal?: AbortSignal }) {
    const first = await this.send<T>(args)
    if (first instanceof Error) return first
    const unauthenticated = first.errors?.some((e) => e.extensions?.code === 'AUTHENTICATION')
    const body = await (async () => {
      if (!unauthenticated || !this.session) return first
      const session = await login()
      if (session instanceof Error) return session
      this.session = session
      return this.send<T>(args)
    })()
    if (body instanceof Error) return body
    const error = body.errors?.[0]
    if (error) {
      const violations = error.extensions?.violations?.map((v) => v.message).join('; ')
      return new CosmosApiError({ operation: args.operation, reason: violations || error.message })
    }
    if (!body.data) return new CosmosApiError({ operation: args.operation, reason: 'empty response' })
    return body.data
  }
}

// ── GraphQL documents ──────────────────────────────────────────────────────
// Trimmed copies of the queries www.cosmos.so sends (recorded 2026-11-04).

const FRAGMENTS = `
fragment Media on Media {
  __typename
  mediaId
  url
  width
  height
  notSafeForWorkStatus
  aiGenerated
  ... on StaticImage { blurHash }
  ... on AnimatedImage { blurHash video { url thumbnailUrl } }
  ... on Video { thumbnail { url } duration isStored mux { playbackUrl mp4Url(quality: HIGH) } }
}

fragment Element on ElementTile {
  __typename
  id
  createdAt
  shareUrl
  ownerId
  originalClusterId
  owner { username isVerifiedProfile }
  generatedCaption { text }
  source { url isPublicDomain author { username fullName profileUrl } }
  product {
    id
    name
    description
    brand { name }
    listPrice { value currency }
    salePrice { value currency }
    availability
    offers { url domain }
  }
  ... on MediaElementTile {
    hasMoreMedia
    media { ...Media }
    multipleMedia { ...Media }
    secondaryMedia { ...Media }
  }
  ... on ProductElementTile {
    media { ...Media }
    productTitle: name
    productDescription: description
    productBrand: brand
    productPrice: price { value currency }
  }
  ... on WebsiteElementTile {
    media { ...Media }
    websiteTitle: title
    websiteDescription: description
  }
  ... on TextElementTile { text }
}
`

const SEARCH_ELEMENTS = `
query SearchGlobalElements($searchTerm: String!, $userId: UserId, $contentType: ElementContentTypeFilter, $order: ElementOrder, $color: String, $origin: SearchOrigin, $pageCursor: String, $pageSize: Int) {
  searchElements(
    filters: {color: $color, userId: $userId, contentType: $contentType}
    order: $order
    searchTerm: $searchTerm
    searchOrigin: $origin
    meta: {pageSize: $pageSize, pageCursor: $pageCursor}
  ) {
    results { element { ...Element } }
    meta { nextPageCursor count }
  }
}
${FRAGMENTS}`

const ELEMENT_DETAILS = `
query GetElementDetails($elementId: ElementId!) {
  elementTopConnections(elementId: $elementId) { meta { count } }
  elementView(elementId: $elementId) {
    __typename
    element { ...Element }
    ... on MultiMediaElementView { media { ...Media } }
    ... on OembedElementView { html }
  }
}
${FRAGMENTS}`

const SIMILAR_ELEMENTS = `
query GetSimilarElements($elementIds: [ElementId!]!, $pageCursor: String, $pageSize: Int) {
  similarElementsV2(elementIds: $elementIds, meta: {pageSize: $pageSize, pageCursor: $pageCursor}) {
    results { element { ...Element } }
    meta { nextPageCursor count }
  }
}
${FRAGMENTS}`

const SEARCH_CLUSTERS = `
query SearchGlobalClusters($searchTerm: String!, $pageSize: Int, $pageCursor: String) {
  searchClusters(searchTerm: $searchTerm, meta: {pageSize: $pageSize, pageCursor: $pageCursor}) {
    items {
      id
      name
      slug
      numberOfElements
      followersCount
      cover { url }
      owner { username fullName }
    }
    meta { nextPageCursor count }
  }
}`

const CLUSTER_ELEMENTS = `
query GetClusterElements($input: ClusterGetInput!, $pageCursor: String, $pageSize: Int) {
  cluster(input: $input) {
    id
    name
    slug
    description
    numberOfElements
    followersCount
    owner { username fullName }
  }
  clusterConnections(clusterInput: $input, meta: {pageSize: $pageSize, pageCursor: $pageCursor}) {
    items { element { ...Element } }
    meta { nextPageCursor count }
  }
}
${FRAGMENTS}`

// ── raw API types ──────────────────────────────────────────────────────────

interface RawMedia {
  __typename: string
  mediaId: string
  url: string | null
  width: number | null
  height: number | null
  notSafeForWorkStatus: string | null
  aiGenerated: boolean | null
  blurHash?: string | null
  video?: { url: string | null; thumbnailUrl: string | null } | null
  thumbnail?: { url: string | null } | null
  duration?: number | null
  isStored?: boolean | null
  mux?: { playbackUrl: string | null; mp4Url: string | null } | null
}

interface RawPrice {
  value: number
  currency: string
}

interface RawElement {
  __typename: string
  id: number
  createdAt: string
  shareUrl: string
  ownerId: number
  originalClusterId: number | null
  owner: { username: string; isVerifiedProfile: boolean } | null
  generatedCaption: { text: string | null } | null
  source: {
    url: string | null
    isPublicDomain: boolean
    author: { username: string | null; fullName: string | null; profileUrl: string | null } | null
  } | null
  product: {
    id: string
    name: string | null
    description: string | null
    brand: { name: string } | null
    listPrice: RawPrice | null
    salePrice: RawPrice | null
    availability: string | null
    offers: { url: string; domain: string }[] | null
  } | null
  hasMoreMedia?: boolean
  media?: RawMedia | null
  multipleMedia?: RawMedia[] | null
  secondaryMedia?: RawMedia | null
  productTitle?: string | null
  productDescription?: string | null
  productBrand?: string | null
  productPrice?: RawPrice | null
  websiteTitle?: string | null
  websiteDescription?: string | null
  text?: string | null
}

interface RawPage {
  meta: { nextPageCursor: string | null; count: number | null }
}

// ── normalized types ───────────────────────────────────────────────────────

export type MediaKind = 'image' | 'gif' | 'video'

export interface CosmosMedia {
  id: string
  kind: MediaKind
  /** Original file on cdn.cosmos.so: jpg/png/webp for images, .gif for gifs, .mp4 for videos */
  url: string
  width: number | null
  height: number | null
  /** `SAFE` for most content */
  nsfw: string | null
  aiGenerated: boolean
  blurHash: string | null
  /** Gifs: mp4 copy on the CDN. Videos: Mux high quality mp4 */
  mp4Url: string | null
  /** Videos only: HLS stream */
  hlsUrl: string | null
  /** Video and gif poster image */
  thumbnailUrl: string | null
  durationSeconds: number | null
}

export type ElementKind = 'media' | 'product' | 'website' | 'note' | 'other'

export interface CosmosPrice {
  value: number
  currency: string
}

export interface CosmosElement {
  id: number
  kind: ElementKind
  /** https://www.cosmos.so/e/<id> */
  url: string
  /** AI caption cosmos generates for the element */
  caption: string | null
  createdAt: string
  /** Cosmos user who saved the element */
  owner: { id: number; username: string | null; verified: boolean }
  /** Collection the element was first saved to */
  collectionId: number | null
  /** Where the element was saved from (Pinterest, Behance, a website...). Check it before reusing an asset */
  source: {
    url: string | null
    isPublicDomain: boolean
    author: { username: string | null; fullName: string | null; profileUrl: string | null } | null
  } | null
  media: CosmosMedia[]
  /** Website or product title */
  title: string | null
  /** Website or product description */
  description: string | null
  /** Note text */
  text: string | null
  product: {
    id: string
    name: string | null
    brand: string | null
    price: CosmosPrice | null
    listPrice: CosmosPrice | null
    salePrice: CosmosPrice | null
    availability: string | null
    offers: { url: string; domain: string }[]
  } | null
}

export interface ElementPage {
  /** Total matches cosmos reports. Can be an estimate */
  total: number | null
  /** Pass as `cursor` to continue. Null on the last page */
  nextCursor: string | null
  elements: CosmosElement[]
}

export interface CosmosCollection {
  id: number
  name: string
  slug: string
  url: string
  description: string | null
  elementCount: number | null
  followers: number | null
  owner: { username: string; fullName: string | null }
  coverUrl: string | null
}

export function isTruthy<T>(value: T): value is NonNullable<T> {
  return Boolean(value)
}

const MEDIA_KINDS: Record<string, MediaKind> = { StaticImage: 'image', AnimatedImage: 'gif', Video: 'video' }

export function normalizeMedia(raw: RawMedia): CosmosMedia | null {
  const kind = MEDIA_KINDS[raw.__typename]
  // videos not copied to the CDN only have the Mux mp4
  const url = raw.url ?? raw.mux?.mp4Url ?? null
  if (!kind || !url) return null
  return {
    id: raw.mediaId,
    kind,
    url,
    width: raw.width,
    height: raw.height,
    nsfw: raw.notSafeForWorkStatus,
    aiGenerated: raw.aiGenerated ?? false,
    blurHash: raw.blurHash ?? null,
    mp4Url: raw.video?.url ?? raw.mux?.mp4Url ?? null,
    hlsUrl: raw.mux?.playbackUrl ?? null,
    thumbnailUrl: raw.video?.thumbnailUrl ?? raw.thumbnail?.url ?? null,
    durationSeconds: raw.duration ?? null,
  }
}

const ELEMENT_KINDS: Record<string, ElementKind> = {
  MediaElementTile: 'media',
  ProductElementTile: 'product',
  WebsiteElementTile: 'website',
  TextElementTile: 'note',
}

/** Captions mark entities with <n>...</n> tags */
function cleanCaption(text: string | null | undefined): string | null {
  const clean = (text ?? '').replace(/<\/?n>/g, '').trim()
  return clean || null
}

export function normalizeElement({ raw, extraMedia = [] }: { raw: RawElement; extraMedia?: RawMedia[] }): CosmosElement {
  const rawMedia = [raw.media, ...(raw.multipleMedia ?? []), ...extraMedia, raw.secondaryMedia].filter(isTruthy)
  const seen = new Set<string>()
  const media = rawMedia
    .map(normalizeMedia)
    .filter(isTruthy)
    .filter((m) => !seen.has(m.id) && Boolean(seen.add(m.id)))
  const product = raw.product
  return {
    id: raw.id,
    kind: ELEMENT_KINDS[raw.__typename] ?? 'other',
    url: raw.shareUrl || `${SITE_URL}/e/${raw.id}`,
    caption: cleanCaption(raw.generatedCaption?.text),
    createdAt: raw.createdAt,
    owner: { id: raw.ownerId, username: raw.owner?.username ?? null, verified: raw.owner?.isVerifiedProfile ?? false },
    collectionId: raw.originalClusterId,
    source: raw.source,
    media,
    title: raw.websiteTitle ?? raw.productTitle ?? product?.name ?? null,
    description: raw.websiteDescription ?? raw.productDescription ?? product?.description ?? null,
    text: raw.text ?? null,
    product: product
      ? {
          id: product.id,
          name: product.name,
          brand: product.brand?.name ?? raw.productBrand ?? null,
          price: raw.productPrice ?? product.salePrice ?? product.listPrice,
          listPrice: product.listPrice,
          salePrice: product.salePrice,
          availability: product.availability,
          offers: product.offers ?? [],
        }
      : null,
  }
}

// ── input parsing ──────────────────────────────────────────────────────────

/** `1924202323`, `https://www.cosmos.so/e/1924202323` */
export function parseElementId(input: string): number | InvalidElementError {
  const trimmed = input.trim()
  const match = /^(\d+)$/.exec(trimmed) ?? /cosmos\.so\/e\/(\d+)/.exec(trimmed)
  if (!match?.[1]) return new InvalidElementError({ input })
  return Number(match[1])
}

/** `https://www.cosmos.so/<owner>/<slug>`, `<owner>/<slug>` */
export function parseCollection(input: string): { owner: string; slug: string } | InvalidCollectionError {
  const pathname = errore.try({
    try: () => (/^https?:\/\//.test(input) ? new URL(input).pathname : input),
    catch: () => null,
  })
  const [owner, slug] = (pathname ?? '').split('/').filter(Boolean)
  if (!owner || !slug || owner === 'e' || owner === 'search') return new InvalidCollectionError({ input })
  return { owner: decodeURIComponent(owner), slug: decodeURIComponent(slug) }
}

/** `#ff0000` or `ff0000` → `ff0000` */
export function normalizeColor(color: string): string {
  return color.trim().replace(/^#/, '').toLowerCase()
}

// ── pagination ─────────────────────────────────────────────────────────────

/** Fetch pages until `limit` elements are collected or the results end */
async function collectPages<E extends Error>({
  limit,
  cursor,
  fetchPage,
  signal,
}: {
  limit: number
  cursor: string | null
  fetchPage: (args: { cursor: string | null; pageSize: number }) => Promise<ElementPage | E>
  signal?: AbortSignal
}): Promise<ElementPage | E> {
  const elements: CosmosElement[] = []
  const seen = new Set<number>()
  let next = cursor
  let total: number | null = null
  while (elements.length < limit) {
    const page = await fetchPage({ cursor: next, pageSize: Math.min(MAX_PAGE_SIZE, limit - elements.length) })
    if (page instanceof Error) return page
    total = page.total
    for (const element of page.elements) {
      if (seen.has(element.id)) continue
      seen.add(element.id)
      elements.push(element)
    }
    next = page.nextCursor
    if (!next || page.elements.length === 0) break
  }
  return { total, nextCursor: next, elements: elements.slice(0, limit) }
}

function toPage(raw: RawPage & { results?: { element: RawElement | null }[]; items?: { element: RawElement | null }[] }): ElementPage {
  const rows = raw.results ?? raw.items ?? []
  return {
    total: raw.meta.count,
    nextCursor: raw.meta.nextPageCursor,
    elements: rows.map((r) => r.element).filter(isTruthy).map((raw) => normalizeElement({ raw })),
  }
}

// ── operations ─────────────────────────────────────────────────────────────

export interface SearchOptions {
  client: CosmosClient
  query: string
  type?: ContentType
  order?: Order
  /** One or two hex colors, e.g. `['#ff0000']` */
  colors?: string[]
  /** Search only elements saved by the logged-in user */
  mine?: boolean
  /** Max elements to return, fetched across pages. Default 40 */
  limit?: number
  /** `nextCursor` of a previous result */
  cursor?: string | null
  signal?: AbortSignal
}

/** Search elements (images, videos, links, notes), same as the search page at cosmos.so/search/elements/<query> */
export async function searchElements({
  client,
  query,
  type,
  order = 'relevant',
  colors = [],
  mine = false,
  limit = 40,
  cursor = null,
  signal,
}: SearchOptions) {
  if (mine && client.userId === null) {
    return new NotLoggedInError({ reason: '`mine` needs a logged-in session, it does not work with --anonymous' })
  }
  if (colors.length > 2) return new CosmosApiError({ operation: 'SearchGlobalElements', reason: 'pass at most two colors' })
  return collectPages({
    limit,
    cursor,
    signal,
    fetchPage: async ({ cursor, pageSize }) => {
      const data = await client.graphql<{ searchElements: RawPage & { results: { element: RawElement | null }[] } }>({
        operation: 'SearchGlobalElements',
        query: SEARCH_ELEMENTS,
        variables: {
          searchTerm: query,
          userId: mine ? client.userId : null,
          contentType: type ? type.toUpperCase() : null,
          order: order === 'relevant' ? null : order.toUpperCase(),
          // two colors are joined with ";" (the API rejects "," and "|")
          color: colors.length > 0 ? colors.map(normalizeColor).join(';') : null,
          origin: SEARCH_ORIGIN,
          pageCursor: cursor,
          pageSize,
        },
        signal,
      })
      if (data instanceof Error) return data
      return toPage(data.searchElements)
    },
  })
}

export interface ElementDetails extends CosmosElement {
  /** How many times users saved this element */
  saves: number | null
  /** Embed HTML for oembed elements (YouTube, Vimeo...) */
  embedHtml: string | null
}

/** Read one element, including every media of multi image posts */
export async function getElement({ client, element, signal }: { client: CosmosClient; element: string | number; signal?: AbortSignal }) {
  const id = typeof element === 'number' ? element : parseElementId(element)
  if (id instanceof Error) return id
  const data = await client.graphql<{
    elementTopConnections: RawPage | null
    elementView: { __typename: string; element: RawElement | null; media?: RawMedia[] | null; html?: string | null } | null
  }>({ operation: 'GetElementDetails', query: ELEMENT_DETAILS, variables: { elementId: id }, signal })
  if (data instanceof Error) {
    if (data instanceof CosmosApiError && /not found|not authorized/i.test(String(data.reason))) return new ElementNotFoundError({ id: String(id), cause: data })
    return data
  }
  const view = data.elementView
  if (!view?.element) return new ElementNotFoundError({ id: String(id) })
  return {
    ...normalizeElement({ raw: view.element, extraMedia: view.media ?? [] }),
    saves: data.elementTopConnections?.meta.count ?? null,
    embedHtml: view.html ?? null,
  } satisfies ElementDetails
}

/** Elements visually similar to one element, like the grid under an element page */
export async function getSimilarElements({
  client,
  element,
  limit = 40,
  cursor = null,
  signal,
}: {
  client: CosmosClient
  element: string | number
  limit?: number
  cursor?: string | null
  signal?: AbortSignal
}) {
  const id = typeof element === 'number' ? element : parseElementId(element)
  if (id instanceof Error) return id
  return collectPages({
    limit,
    cursor,
    signal,
    fetchPage: async ({ cursor, pageSize }) => {
      const data = await client.graphql<{ similarElementsV2: RawPage & { results: { element: RawElement | null }[] } }>({
        operation: 'GetSimilarElements',
        query: SIMILAR_ELEMENTS,
        variables: { elementIds: [id], pageCursor: cursor, pageSize },
        signal,
      })
      if (data instanceof Error) return data
      return toPage(data.similarElementsV2)
    },
  })
}

/** Search collections (clusters), like the Collections tab of the search page */
export async function searchCollections({
  client,
  query,
  limit = 20,
  signal,
}: {
  client: CosmosClient
  query: string
  limit?: number
  signal?: AbortSignal
}) {
  const data = await client.graphql<{
    searchClusters: RawPage & {
      items: {
        id: number
        name: string
        slug: string
        numberOfElements: number | null
        followersCount: number | null
        cover: { url: string | null } | null
        owner: { username: string; fullName: string | null }
      }[]
    }
  }>({
    operation: 'SearchGlobalClusters',
    query: SEARCH_CLUSTERS,
    variables: { searchTerm: query, pageSize: Math.min(limit, MAX_PAGE_SIZE), pageCursor: null },
    signal,
  })
  if (data instanceof Error) return data
  return {
    collections: data.searchClusters.items.map(
      (c): CosmosCollection => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        url: `${SITE_URL}/${c.owner.username}/${c.slug}`,
        description: null,
        elementCount: c.numberOfElements,
        followers: c.followersCount,
        owner: c.owner,
        coverUrl: c.cover?.url ?? null,
      }),
    ),
  }
}

/** List the elements of a collection, e.g. https://www.cosmos.so/maratorresg/paper-texture */
export async function getCollection({
  client,
  collection,
  limit = 40,
  cursor = null,
  signal,
}: {
  client: CosmosClient
  collection: string
  limit?: number
  cursor?: string | null
  signal?: AbortSignal
}) {
  const parsed = parseCollection(collection)
  if (parsed instanceof Error) return parsed
  const input = { ownerUsername: parsed.owner, slug: parsed.slug }
  const info: { value: CosmosCollection | null } = { value: null }
  const page = await collectPages({
    limit,
    cursor,
    signal,
    fetchPage: async ({ cursor, pageSize }) => {
      const data = await client.graphql<{
        cluster: {
          id: number
          name: string
          slug: string
          description: string | null
          numberOfElements: number | null
          followersCount: number | null
          owner: { username: string; fullName: string | null }
        } | null
        clusterConnections: (RawPage & { items: { element: RawElement | null }[] }) | null
      }>({ operation: 'GetClusterElements', query: CLUSTER_ELEMENTS, variables: { input, pageCursor: cursor, pageSize }, signal })
      if (data instanceof Error) {
        if (data instanceof CosmosApiError && /not found|not allowed|permission/i.test(String(data.reason))) {
          return new CollectionNotFoundError({ ...parsed, cause: data })
        }
        return data
      }
      if (!data.cluster || !data.clusterConnections) return new CollectionNotFoundError(parsed)
      const c = data.cluster
      info.value = {
        id: c.id,
        name: c.name,
        slug: c.slug,
        url: `${SITE_URL}/${c.owner.username}/${c.slug}`,
        description: c.description || null,
        elementCount: c.numberOfElements,
        followers: c.followersCount,
        owner: c.owner,
        coverUrl: null,
      }
      return toPage(data.clusterConnections)
    },
  })
  if (page instanceof Error) return page
  if (!info.value) return new CollectionNotFoundError(parsed)
  return { collection: info.value, ...page }
}

// ── images ─────────────────────────────────────────────────────────────────

/** Resized copy from the cosmos image CDN, e.g. for previews. Images and gifs only */
export function resizedImageUrl({ url, width, format = 'webp' }: { url: string; width: number; format?: 'webp' | 'jpeg' | 'png' }): string {
  const resized = new URL(url)
  resized.searchParams.set('format', format)
  resized.searchParams.set('w', String(width))
  return resized.toString()
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}

/** `<caption-slug>-<id>[-<n>]` without extension */
export function assetBaseName({ element, index }: { element: CosmosElement; index: number }): string {
  const slug = slugify(element.caption ?? element.title ?? '')
  const suffix = element.media.length > 1 ? `-${index + 1}` : ''
  return `${slug ? `${slug}-` : ''}${element.id}${suffix}`
}

export interface DownloadedAsset {
  elementId: number
  media: CosmosMedia
  path: string
  bytes: number
  contentType: string
}

/** Download one media file. The extension comes from the response content type */
export async function downloadMedia({
  media,
  outDir,
  baseName,
  signal,
}: {
  media: CosmosMedia
  outDir: string
  baseName: string
  signal?: AbortSignal
}) {
  const url = media.url
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }).catch(
    (e) => new DownloadError({ url, reason: e instanceof Error ? e.message : String(e), cause: e }),
  )
  if (response instanceof Error) return response
  const body = response.body
  if (!response.ok || !body) return new DownloadError({ url, reason: `HTTP ${response.status}` })
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
  const extension = EXTENSIONS[contentType] ?? /\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname)?.[1] ?? 'bin'
  const file = path.join(outDir, `${baseName}.${extension}`)
  const tmp = `${file}.${crypto.randomUUID()}.part`
  const written = await fs.promises
    .mkdir(outDir, { recursive: true })
    .then(() => pipeline(Readable.fromWeb(body), fs.createWriteStream(tmp)))
    .then(() => fs.promises.rename(tmp, file))
    .then(() => fs.promises.stat(file))
    .catch(async (e) => {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
      return new DownloadError({ url, reason: `cannot write ${file}`, cause: e })
    })
  if (written instanceof Error) return written
  return { media, path: file, bytes: written.size, contentType } satisfies Omit<DownloadedAsset, 'elementId'>
}

/**
 * Download every media of the given elements to `outDir`, a few files at a time.
 * Returns one result per media; failures are returned as errors, not thrown.
 */
export async function downloadElements({
  elements,
  outDir,
  kinds,
  concurrency = 4,
  signal,
  onResult,
}: {
  elements: CosmosElement[]
  outDir: string
  /** Only these media kinds. Default: all */
  kinds?: MediaKind[]
  concurrency?: number
  signal?: AbortSignal
  onResult?: (result: DownloadedAsset | DownloadError) => void
}): Promise<(DownloadedAsset | DownloadError)[]> {
  const jobs = elements.flatMap((element) =>
    element.media
      .map((media, index) => ({ element, media, index }))
      .filter((job) => !kinds || kinds.includes(job.media.kind)),
  )
  const results: (DownloadedAsset | DownloadError)[] = new Array(jobs.length)
  let nextJob = 0
  const worker = async () => {
    while (nextJob < jobs.length) {
      const jobIndex = nextJob++
      const job = jobs[jobIndex]
      if (!job) return
      const downloaded = await downloadMedia({
        media: job.media,
        outDir,
        baseName: assetBaseName({ element: job.element, index: job.index }),
        signal,
      })
      const result = downloaded instanceof Error ? downloaded : { elementId: job.element.id, ...downloaded }
      results[jobIndex] = result
      onResult?.(result)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker))
  return results.filter(isTruthy)
}
