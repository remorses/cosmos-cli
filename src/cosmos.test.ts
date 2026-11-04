import { describe, expect, test } from 'vitest'
import { normalizeElement, parseCollection, parseElementId } from './cosmos.ts'

describe('input parsing', () => {
  test('element ids and collection urls', () => {
    expect([
      parseElementId('764119920'),
      parseElementId('https://www.cosmos.so/e/764119920?ref=x'),
      parseElementId('https://www.cosmos.so/maratorresg/paper-texture') instanceof Error,
      parseCollection('https://www.cosmos.so/maratorresg/paper-texture?tab=x'),
      parseCollection('maratorresg/paper%20texture'),
      parseCollection('https://www.cosmos.so/e/764119920') instanceof Error,
      parseCollection('https://www.cosmos.so/search/elements/paper') instanceof Error,
    ]).toMatchInlineSnapshot(`
      [
        764119920,
        764119920,
        true,
        {
          "owner": "maratorresg",
          "slug": "paper-texture",
        },
        {
          "owner": "maratorresg",
          "slug": "paper texture",
        },
        true,
        true,
      ]
    `)
  })
})

describe('normalizeElement', () => {
  test('video element: caption tags stripped, media deduped, mux fallbacks', () => {
    const video = {
      __typename: 'Video',
      mediaId: '1826364a',
      url: 'https://cdn.cosmos.so/1826364a.mp4',
      width: 1080,
      height: 1920,
      notSafeForWorkStatus: 'SAFE',
      aiGenerated: false,
      thumbnail: { url: 'https://cdn.cosmos.so/b6dffbb8' },
      duration: 13,
      isStored: true,
      mux: { playbackUrl: 'https://stream.mux.com/aY3.m3u8', mp4Url: 'https://stream.mux.com/aY3/high.mp4' },
    }
    const element = normalizeElement({
      raw: {
        __typename: 'MediaElementTile',
        id: 1651197062,
        createdAt: '2025-01-12T08:04:17.922844Z',
        shareUrl: 'https://www.cosmos.so/e/1651197062',
        ownerId: 384203461,
        originalClusterId: 358656965,
        owner: { username: 'divine.luna', isVerifiedProfile: false },
        generatedCaption: { text: 'Ocean waves by <n>Benjamas</n>.' },
        source: null,
        product: null,
        media: video,
        // the same media again, plus an unknown media type that must be skipped
        multipleMedia: [video, { ...video, __typename: 'Audio', mediaId: 'other' }],
        secondaryMedia: null,
      },
    })
    expect(element).toMatchInlineSnapshot(`
      {
        "caption": "Ocean waves by Benjamas.",
        "collectionId": 358656965,
        "createdAt": "2025-01-12T08:04:17.922844Z",
        "description": null,
        "id": 1651197062,
        "kind": "media",
        "media": [
          {
            "aiGenerated": false,
            "blurHash": null,
            "durationSeconds": 13,
            "height": 1920,
            "hlsUrl": "https://stream.mux.com/aY3.m3u8",
            "id": "1826364a",
            "kind": "video",
            "mp4Url": "https://stream.mux.com/aY3/high.mp4",
            "nsfw": "SAFE",
            "thumbnailUrl": "https://cdn.cosmos.so/b6dffbb8",
            "url": "https://cdn.cosmos.so/1826364a.mp4",
            "width": 1080,
          },
        ],
        "owner": {
          "id": 384203461,
          "username": "divine.luna",
          "verified": false,
        },
        "product": null,
        "source": null,
        "text": null,
        "title": null,
        "url": "https://www.cosmos.so/e/1651197062",
      }
    `)
  })
})
