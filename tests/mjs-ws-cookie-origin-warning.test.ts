// Test de l'avertissement au démarrage (verifyOrigin × cookie) — `opts.auth` fourni
// SANS `verifyOrigin` armé est le terrain du détournement CSWSH (patron cookie de
// docs/23-mjs-ws.md §7.12) : `opts.auth` étant une fonction opaque, impossible de savoir si elle
// lit VRAIMENT `meta.headers.cookie` sans l'instrumenter — l'avertissement couvre donc le
// terrain plus large « auth applicative sans contrôle d'origine » (cf. src/mjs-ws/core.ts,
// juste après la définition de `log`). Émis UNE SEULE FOIS au démarrage, jamais par connexion.
import assert from 'node:assert/strict'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { t } from '../src/messages/index.js'

const MESSAGE = t('ws.core.origine-non-verifiee-avec-cookie')

describe('MJS-WS — avertissement démarrage : auth SANS verifyOrigin', () => {
  it('émet l\'avertissement quand opts.auth est fourni et verifyOrigin absent', async () => {
    const logs      = [] as string[]
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, auth: () => ({ id: 1 }), onLog: (level, message) => { if(level === 'warn') logs.push(message) } })
    await app.listen()
    try {
      assert.ok(logs.includes(MESSAGE), 'avertissement attendu, absent du journal')
    } finally {
      await app.stop()
    }
  })

  it('n\'émet RIEN quand verifyOrigin est armé', async () => {
    const logs      = [] as string[]
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, auth: () => ({ id: 1 }), verifyOrigin: ['https://exemple.com'], onLog: (level, message) => { if(level === 'warn') logs.push(message) } })
    await app.listen()
    try {
      assert.ok(!logs.includes(MESSAGE), 'avertissement inattendu avec verifyOrigin armé')
    } finally {
      await app.stop()
    }
  })

  it('n\'émet RIEN quand opts.auth est absent', async () => {
    const logs      = [] as string[]
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, onLog: (level, message) => { if(level === 'warn') logs.push(message) } })
    await app.listen()
    try {
      assert.ok(!logs.includes(MESSAGE), 'avertissement inattendu sans opts.auth')
    } finally {
      await app.stop()
    }
  })

  it('ne s\'émet qu\'UNE SEULE FOIS, jamais par connexion', async () => {
    const logs      = [] as string[]
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, auth: () => ({ id: 1 }), onLog: (level, message) => { if(level === 'warn') logs.push(message) } })
    await app.listen()
    try {
      transport.connect({ url: 'memory://cookie-warn-1' })
      transport.connect({ url: 'memory://cookie-warn-2' })
      transport.connect({ url: 'memory://cookie-warn-3' })
      const occurrences = logs.filter(m => m === MESSAGE).length
      assert.equal(occurrences, 1, 'avertissement émis plus d\'une fois')
    } finally {
      await app.stop()
    }
  })
})
