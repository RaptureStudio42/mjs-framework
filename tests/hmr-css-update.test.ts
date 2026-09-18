// Trame HMR « css-update » : notifyCssUpdate(payload) diffuse le CSS
// frais lui-même ({type:'css-update', css:{components,sheets,root?}}) ; le
// snippet client appelle µ._hotCss(payload) et NE recharge la page que si le
// hot-swap n'est pas sûr (retour false) — sinon il conserve le rafraîchissement
// des <link rel=stylesheet> historique.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { StaticServer } from '../src/server/index.js'
import { hmrClientSnippet } from '../src/server/hmr.js'
import { mjsTmp } from './helpers/tmp.js'
import { extractMarked } from './helpers/extract-marked.js'

describe('HMR — css-update (rechargement CSS à chaud)', () => {
  let server: StaticServer
  let port: number

  before(async () => {
    const rootDir = mjsTmp('hmr-css')
    writeFileSync(join(rootDir, 'app-12345678.js'), '// app')
    port = 35000 + Math.floor(Math.random() * 5000)
    server = new StaticServer({ rootDir, port, host: '127.0.0.1', hmr: true })
    await server.start()
  })

  after(async () => { await server.stop() })

  it('notifyCssUpdate(payload) broadcast {type:"css-update", css:{…}} tel quel', async function () {
    this.timeout(5000)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__mjs_hmr`)
    const messages: string[] = []
    ws.on('message', (d) => messages.push(d.toString()))
    await new Promise<void>(r => ws.on('open', () => r()))
    await new Promise(r => setTimeout(r, 100))

    const payload = {
      components: { 'mjs-comp': ':host{display:block}.t{color:blue}' },
      sheets: { theme: '.a{color:blue}' },
      root: 'body{margin:0}',
    }
    server.hmr?.notifyCssUpdate(payload)
    await new Promise(r => setTimeout(r, 100))

    const raw = messages.find(m => m.includes('"type":"css-update"'))
    assert.ok(raw, 'le message css-update doit être diffusé')
    assert.deepEqual(JSON.parse(raw!), { type: 'css-update', css: payload })
    ws.close()
  })

  it('le snippet client câble µ._hotCss + repli location.reload() si le swap n\'est pas sûr', () => {
    const snippet = hmrClientSnippet('ws://127.0.0.1:1234/__mjs_hmr')
    assert.match(snippet, /_hotCss/, 'le snippet doit appeler le hot-swap runtime')
    assert.match(snippet, /msg\.css/, 'le snippet doit passer la charge css du message')
    assert.match(snippet, /!== false/, 'retour false de µ._hotCss = swap pas sûr')
    assert.match(snippet, /location\.reload\(\)/, 'repli reload complet conservé')
    assert.match(snippet, /link\[rel=stylesheet\]/, 'le rafraîchissement des <link> est CONSERVÉ après le hot-swap')
  })

  it('non-régression : reload et error inchangés dans le snippet', () => {
    const snippet = hmrClientSnippet('ws://127.0.0.1:1234/__mjs_hmr')
    assert.match(snippet, /msg\.type === 'reload'/)
    assert.match(snippet, /msg\.type === 'error'/)
    assert.match(snippet, /__mjs_hmr_overlay/)
  })

  // µ._hotCss ABSENT (mjs_hotcss.ts hors du bundle — prod, ou `mjs dev` pointé par erreur sur un
  // build de prod) : AVANT le fix, `ok` restait à sa valeur initiale `true` (le `if (hot)` ne
  // s'exécutait juste pas), le remplacement de CSS devenait inerte EN SILENCE au lieu de
  // recharger la page. Fragment isolé via marqueurs (cf. tests/helpers/extract-marked.ts) —
  // exécuté hors navigateur avec `window`/`location` factices, `msg` porte juste `.css`.
  describe('repli reload quand µ._hotCss est absent (fragment isolé du snippet)', () => {
    function runFallback(msg: any, window: any, location: any): void {
      const snippet = hmrClientSnippet('ws://127.0.0.1:1234/__mjs_hmr')
      const body = extractMarked(snippet, 'hmr-hotcss-fallback')
      new Function('msg', 'window', 'location', body)(msg, window, location)
    }

    it('window.µ présent mais SANS _hotCss : reload (avant le fix : aucun reload, swap silencieusement inerte)', () => {
      let reloaded = false
      runFallback({ css: {} }, { µ: {} }, { reload: () => { reloaded = true } })
      assert.equal(reloaded, true)
    })

    it('window.µ absent (page sans runtime) : PAS de reload — le re-fetch des <link> suffit', () => {
      let reloaded = false
      runFallback({ css: {} }, {}, { reload: () => { reloaded = true } })
      assert.equal(reloaded, false)
    })

    it('_hotCss présent, renvoie true : pas de reload', () => {
      let reloaded = false
      runFallback({ css: { a: 1 } }, { µ: { _hotCss: () => true } }, { reload: () => { reloaded = true } })
      assert.equal(reloaded, false)
    })

    it('_hotCss présent, renvoie false (swap pas sûr) : reload', () => {
      let reloaded = false
      runFallback({ css: {} }, { µ: { _hotCss: () => false } }, { reload: () => { reloaded = true } })
      assert.equal(reloaded, true)
    })

    it('_hotCss présent mais lève : reload (catch existant, non-régression)', () => {
      let reloaded = false
      runFallback({ css: {} }, { µ: { _hotCss: () => { throw new Error('boom') } } }, { reload: () => { reloaded = true } })
      assert.equal(reloaded, true)
    })
  })
})
