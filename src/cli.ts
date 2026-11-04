#!/usr/bin/env node
import path from 'node:path'
import { createRequire } from 'node:module'
import * as errore from 'errore'
import { colors, goke, type GokeConsole } from 'goke'
import dedent from 'string-dedent'
import { z } from 'zod'
import {
  CONTENT_TYPES,
  ORDERS,
  CosmosClient,
  downloadElements,
  getCollection,
  getElement,
  getSimilarElements,
  login,
  parseElementId,
  searchCollections,
  searchElements,
  type CosmosCollection,
  type CosmosElement,
  type ElementPage,
  type MediaKind,
} from './cosmos.ts'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json') as { version: string }

const MEDIA_KINDS = ['image', 'gif', 'video'] as const satisfies readonly MediaKind[]

const cli = goke('cosmos').option(
  '--anonymous',
  'Do not use your Chrome login. Search works, `--mine` does not, results are not personalized. Also set by `COSMOS_ANONYMOUS=1`',
)

class UnexpectedError extends errore.createTaggedError({
  name: 'UnexpectedError',
  message: 'Unexpected failure while talking to cosmos',
}) {}

async function withClient<T>({ anonymous = false, task }: { anonymous?: boolean; task: (client: CosmosClient) => Promise<T> }) {
  const client = await CosmosClient.create({ anonymous: anonymous || process.env.COSMOS_ANONYMOUS === '1' })
  if (client instanceof Error) return client
  return task(client).catch((e) => new UnexpectedError({ cause: e }))
}

function exitWithError({ console, error }: { console: GokeConsole; error: Error }): never {
  console.error(colors.red(error.message))
  if (error.cause) console.error(error.cause)
  process.exit(1)
}

function formatElement({ element, index }: { element: CosmosElement; index?: number }): string {
  const first = element.media[0]
  const kind = first ? `${first.kind}${first.width && first.height ? ` ${first.width}x${first.height}` : ''}` : element.kind
  const extra = element.media.length > 1 ? ` +${element.media.length - 1} media` : ''
  const author = element.source?.author?.fullName ?? element.source?.author?.username
  const lines = [
    `${index !== undefined ? `${index + 1}. ` : ''}${element.url} · ${kind}${extra}${element.owner.username ? ` · saved by ${element.owner.username}` : ''}`,
    element.caption ?? element.title,
    element.text,
    ...element.media.map((m) => m.url),
    element.source?.url ? colors.dim(`source: ${element.source.url}${author ? ` (${author})` : ''}`) : null,
  ]
  const indent = index !== undefined ? '   ' : ''
  return lines
    .filter((line): line is string => Boolean(line))
    .map((line, i) => (i === 0 ? line : `${indent}${line}`))
    .join('\n')
}

function printPage({ page, header, console }: { page: ElementPage; header: string; console: GokeConsole }) {
  console.log(colors.bold(header))
  console.log('')
  console.log(page.elements.map((element, index) => formatElement({ element, index })).join('\n\n'))
  if (page.nextCursor) {
    console.log('')
    console.log(colors.dim(`more results: --cursor '${page.nextCursor}'`))
  }
}

async function downloadAndPrint({
  elements,
  outDir,
  kinds,
  concurrency,
  console,
}: {
  elements: CosmosElement[]
  outDir: string
  kinds?: MediaKind[]
  concurrency: number
  console: GokeConsole
}) {
  const results = await downloadElements({
    elements,
    outDir: path.resolve(outDir),
    kinds,
    concurrency,
    onResult: (result) => {
      if (result instanceof Error) console.error(colors.red(result.message))
      else console.error(`${colors.green('saved')} ${result.path} ${colors.dim(`${Math.round(result.bytes / 1024)} KB`)}`)
    },
  })
  const [saved, failed] = errore.partition(results)
  console.error(`${saved.length} files saved to ${path.resolve(outDir)}${failed.length ? `, ${failed.length} failed` : ''}`)
  if (failed.length > 0) process.exitCode = 1
  return { saved, failed }
}

const downloadOption = ['--download [dir]', z.string().optional().describe('Also download the original media files to this folder')] as const
const kindOption = [
  '--kind [kind]',
  z.array(z.enum(MEDIA_KINDS)).optional().describe('With `--download`, only save these media kinds. Repeatable'),
] as const
const concurrencyOption = ['--concurrency [n]', z.int().min(1).max(32).default(4).describe('Files downloaded in parallel')] as const

cli
  .command(
    'login',
    dedent`
      Copy your cosmos login from Chrome. Opens www.cosmos.so in one background tab of the
      Chrome profile connected to playwriter, reads the access token and closes the tab.

      Other commands do this automatically when the saved token is missing or about to expire
      (tokens last 7 days).
    `,
  )
  .action(async (_options, { console }) => {
    const session = await login()
    if (session instanceof Error) exitWithError({ console, error: session })
    console.log(`Logged in as ${session.username} until ${new Date(session.expiresAt * 1000).toISOString()}`)
  })

cli
  .command(
    'search <query>',
    dedent`
      Search elements (images, gifs, videos, links, notes) like cosmos.so/search/elements/<query>.
      Prints the element URL, caption, original media URLs and source for each result.

      Use \`--download <dir>\` to save the original files. Use \`--limit\` to fetch more than one page.
    `,
  )
  .option('--type [type]', z.enum(CONTENT_TYPES).optional().describe('Only this content type'))
  .option('--order [order]', z.enum(ORDERS).default('relevant').describe('Sort order'))
  .option('--color [hex]', z.array(z.string().regex(/^#?[0-9a-fA-F]{6}$/)).optional().describe('Dominant color like `#f2e8d5`. Repeat once for two colors'))
  .option('--mine', 'Only search elements you saved')
  .option('--limit [n]', z.int().min(1).max(2000).default(40).describe('Max results, fetched across pages'))
  .option('--cursor [cursor]', z.string().optional().describe('Continue from the cursor printed by a previous run'))
  .option(...downloadOption)
  .option(...kindOption)
  .option(...concurrencyOption)
  .option('--json', 'Print results as JSON')
  .example('cosmos search "paper texture"')
  .example('cosmos search "film grain overlay" --type image --limit 100 --download ./assets/film-grain-overlay')
  .example("cosmos search 'brutalist poster' --color '#ff0000' --order popular --json")
  .action(async (query, options, { console }) => {
    const page = await withClient({
      anonymous: options.anonymous,
      task: (client) =>
        searchElements({
          client,
          query,
          type: options.type,
          order: options.order,
          colors: options.color,
          mine: options.mine,
          limit: options.limit,
          cursor: options.cursor,
        }),
    })
    if (page instanceof Error) exitWithError({ console, error: page })
    if (options.json) console.log(JSON.stringify({ query, ...page }, null, 2))
    else printPage({ page, header: `${page.total ?? '?'} results for "${query}" · showing ${page.elements.length}`, console })
    if (options.download) await downloadAndPrint({ elements: page.elements, outDir: options.download, kinds: options.kind, concurrency: options.concurrency, console })
  })

cli
  .command(
    'element <element>',
    dedent`
      Read one element: caption, every media URL (multi image posts included), sizes, source URL
      and author, saves count, product or website info.

      Accepts a numeric id or a https://www.cosmos.so/e/<id> URL.
    `,
  )
  .option(...downloadOption)
  .option(...kindOption)
  .option(...concurrencyOption)
  .option('--json', 'Print the element as JSON')
  .example('cosmos element 764119920')
  .example('cosmos element https://www.cosmos.so/e/764119920 --download ./assets/paper-texture')
  .action(async (element, options, { console }) => {
    const details = await withClient({ anonymous: options.anonymous, task: (client) => getElement({ client, element }) })
    if (details instanceof Error) exitWithError({ console, error: details })
    if (options.json) console.log(JSON.stringify(details, null, 2))
    else {
      console.log(formatElement({ element: details }))
      console.log(colors.dim(`created ${details.createdAt} · saved ${details.saves ?? '?'} times`))
    }
    if (options.download) await downloadAndPrint({ elements: [details], outDir: options.download, kinds: options.kind, concurrency: options.concurrency, console })
  })

cli
  .command(
    'similar <element>',
    dedent`
      Elements visually similar to one element, like the grid under an element page.
    `,
  )
  .option('--limit [n]', z.int().min(1).max(2000).default(40).describe('Max results, fetched across pages'))
  .option('--cursor [cursor]', z.string().optional().describe('Continue from the cursor printed by a previous run'))
  .option(...downloadOption)
  .option(...kindOption)
  .option(...concurrencyOption)
  .option('--json', 'Print results as JSON')
  .example('cosmos similar 764119920 --limit 20')
  .action(async (element, options, { console }) => {
    const page = await withClient({
      anonymous: options.anonymous,
      task: (client) => getSimilarElements({ client, element, limit: options.limit, cursor: options.cursor }),
    })
    if (page instanceof Error) exitWithError({ console, error: page })
    if (options.json) console.log(JSON.stringify(page, null, 2))
    else printPage({ page, header: `similar to ${element} · showing ${page.elements.length}`, console })
    if (options.download) await downloadAndPrint({ elements: page.elements, outDir: options.download, kinds: options.kind, concurrency: options.concurrency, console })
  })

function formatCollection(c: CosmosCollection, index: number): string {
  return [
    `${index + 1}. ${c.name} · ${c.elementCount ?? '?'} elements · ${c.followers ?? 0} followers · by ${c.owner.username}`,
    `   ${c.url}`,
    c.description ? `   ${c.description}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n')
}

cli
  .command(
    'collections <query>',
    dedent`
      Search collections, like the Collections tab of the search page. Read one with \`cosmos collection <url>\`.
    `,
  )
  .option('--limit [n]', z.int().min(1).max(100).default(20).describe('Max results'))
  .option('--json', 'Print results as JSON')
  .example('cosmos collections "paper texture"')
  .action(async (query, options, { console }) => {
    const result = await withClient({
      anonymous: options.anonymous,
      task: (client) => searchCollections({ client, query, limit: options.limit }),
    })
    if (result instanceof Error) exitWithError({ console, error: result })
    if (options.json) {
      console.log(JSON.stringify({ query, ...result }, null, 2))
      return
    }
    console.log(colors.bold(`${result.collections.length} collections for "${query}"`))
    console.log('')
    console.log(result.collections.map(formatCollection).join('\n\n'))
  })

cli
  .command(
    'collection <collection>',
    dedent`
      List the elements of a collection. Accepts https://www.cosmos.so/<user>/<slug> or <user>/<slug>.
    `,
  )
  .option('--limit [n]', z.int().min(1).max(5000).default(40).describe('Max elements, fetched across pages'))
  .option('--cursor [cursor]', z.string().optional().describe('Continue from the cursor printed by a previous run'))
  .option(...downloadOption)
  .option(...kindOption)
  .option(...concurrencyOption)
  .option('--json', 'Print the collection and its elements as JSON')
  .example('cosmos collection https://www.cosmos.so/maratorresg/paper-texture --limit 100')
  .example('cosmos collection maratorresg/paper-texture --limit 1000 --download ./assets/paper-texture --concurrency 8')
  .action(async (collection, options, { console }) => {
    const result = await withClient({
      anonymous: options.anonymous,
      task: (client) => getCollection({ client, collection, limit: options.limit, cursor: options.cursor }),
    })
    if (result instanceof Error) exitWithError({ console, error: result })
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else {
      const c = result.collection
      printPage({
        page: result,
        header: `${c.name} by ${c.owner.username} · ${c.elementCount ?? '?'} elements · showing ${result.elements.length}${c.description ? `\n${c.description}` : ''}`,
        console,
      })
    }
    if (options.download) await downloadAndPrint({ elements: result.elements, outDir: options.download, kinds: options.kind, concurrency: options.concurrency, console })
  })

cli
  .command(
    'download [...elements]',
    dedent`
      Download the original media files of elements (ids or https://www.cosmos.so/e/<id> URLs).
      Files are named \`<caption-slug>-<id>.<ext>\`; multi image elements get \`-1\`, \`-2\` suffixes.
      Prints one saved path per line.
    `,
  )
  .option('--out [dir]', z.string().default('.').describe('Folder to save files into'))
  .option('--kind [kind]', z.array(z.enum(MEDIA_KINDS)).optional().describe('Only save these media kinds. Repeatable'))
  .option(...concurrencyOption)
  .option('--json', 'Print the saved files as JSON')
  .example('cosmos download 764119920 1924202323 --out ./assets/paper-texture')
  .example('cosmos search "paper texture" --json | jq -r ".elements[].id" | xargs cosmos download --out ./assets/paper-texture')
  .action(async (elements, options, { console }) => {
    const [ids, invalid] = errore.partition(elements.map(parseElementId))
    if (invalid[0]) exitWithError({ console, error: invalid[0] })
    if (ids.length === 0) exitWithError({ console, error: new Error('Pass at least one element id, e.g. cosmos download 764119920 --out ./assets/paper-texture') })
    const details = await withClient({
      anonymous: options.anonymous,
      task: (client) => Promise.all(ids.map((id) => getElement({ client, element: id }))),
    })
    if (details instanceof Error) exitWithError({ console, error: details })
    const [found, missing] = errore.partition(details)
    for (const error of missing) console.error(colors.red(error.message))
    const outDir = path.resolve(options.out)
    const results = await downloadElements({ elements: found, outDir, kinds: options.kind, concurrency: options.concurrency })
    const [saved, failed] = errore.partition(results)
    for (const error of failed) console.error(colors.red(error.message))
    if (options.json) console.log(JSON.stringify(saved, null, 2))
    else for (const file of saved) console.log(file.path)
    if (missing.length > 0 || failed.length > 0) process.exit(1)
  })

cli.help()
cli.completions()
cli.version(packageJson.version)
await cli.parse()
