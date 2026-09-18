// serve-mime — table MIME_TYPES de `mjs dev` (server/index.ts) incomplète (images/polices
// servies en application/octet-stream). Fusionnée sur MIME (render-server.ts, `mjs serve`) + 2
// extensions que NI L'UNE NI L'AUTRE table ne couvrait encore (.avif/.mp3).

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { StaticServer } from '../src/server/index.js'

describe('table MIME de mjs dev — extensions binaires', () => {
  let server: StaticServer
  let port: number
  let rootDir: string

  before(async () => {
    rootDir = mjsTmp('mime')
    writeFileSync(join(rootDir, 'photo-a1b2c3d4.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46]))
    writeFileSync(join(rootDir, 'font-a1b2c3d4.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]))
    writeFileSync(join(rootDir, 'icone-a1b2c3d4.svg'), '<svg></svg>')
    writeFileSync(join(rootDir, 'image-a1b2c3d4.avif'), Buffer.from([0x00, 0x00, 0x00]))
    writeFileSync(join(rootDir, 'son-a1b2c3d4.mp3'), Buffer.from([0xff, 0xfb]))
    server = new StaticServer({ rootDir, port: 0, host: '127.0.0.1' })
    await server.start()
    port = (server.server!.address() as any).port
  })

  after(async () => { await server.stop() })

  const cases: Array<[string, RegExp]> = [
    ['photo-a1b2c3d4.webp', /^image\/webp/],
    ['font-a1b2c3d4.woff2', /^font\/woff2/],
    ['icone-a1b2c3d4.svg',  /^image\/svg\+xml/],
    ['image-a1b2c3d4.avif', /^image\/avif/],
    ['son-a1b2c3d4.mp3',    /^audio\/mpeg/],
  ]
  for (const [file, expected] of cases) {
    it(`${file} → content-type correct (pas application/octet-stream)`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/modularjs/${file}`)
      const ct = res.headers.get('content-type') || ''
      assert.match(ct, expected)
    })
  }
})
