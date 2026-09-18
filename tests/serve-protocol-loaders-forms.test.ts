// mjs serve — chargeurs de props/actions `.server.mjs` + formulaires POST urlencoded.
// Harnais calqué sur serve-protocol-negotiation.test.ts (tmpdir, manifest 2 lignes à la main,
// config objet, mode csr, port 0, fetch, close en after). Fixture serve.server.mjs écrite EN
// DIALECTE CIVET (assignations nues, ->, #{}) : le test PROUVE aussi le pipeline de
// compilation (même dialecte que le <script> des composants, cf. serve-entry.ts/cli/ws.ts).
//
// Rechargement à chaud NON testé ici (flaky) — seul le chargement initial l'est.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { connect } from 'node:net'
import { startRenderServer } from '../src/server/render-server.js'

const FIXTURE = `export default {
  props: {
    '/': (params, req) -> { home: true }
    '/p/:id': (params, req) -> { id: params.id, source: 'chargeur' }
  }
  actions: {
    '/p/:id': (params, body, req) ->
      if body.name is 'bad'
        { errors: { name: 'invalide' } }
      else
        { redirect: "/p/#{params.id}" }
  }
}
`

// config PARTAGÉE : 3 routes CSR (mjs-other n'a PAS d'entrée de chargeur, pour le cas 3) + un
// manifest écrit à la main (µ.version connue) + serve.server.mjs au défaut racine.
function setup() {
  const root = mjsTmp('serve-forms')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
  writeFileSync(join(root, 'serve.server.mjs'), FIXTURE)
  const config = {
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
    render: {
      routes: {
        '/':      { component: 'mjs-home',  mode: 'csr' as const },
        '/p/:id': { component: 'mjs-page',  mode: 'csr' as const },
        '/other': { component: 'mjs-other', mode: 'csr' as const },
      },
    },
  }
  return { root, config }
}

async function getNav(port: number, path: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'X-MJS-Nav': '1' } })
}

// `method` en dernier paramètre optionnel (défaut 'POST') : PUT/PATCH réutilisent le MÊME
// harnais (corps urlencoded), seul le verbe change ; tous les appels existants restent inchangés.
async function postForm(port: number, path: string, body: string, headers: Record<string, string> = {}, method: string = 'POST') {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  })
}

// fabrique un corps multipart minimal (CRLF strict) à partir de champs texte/fichier ; ordre
// name AVANT filename, comme tout client conforme (fetch/FormData) — cf. render-server.ts.
function multipartBody(boundary: string, champs: Array<{ name: string, filename?: string, valeur: string }>): string {
  const parts = champs.map((c) => {
    const filenamePart = c.filename !== undefined ? `; filename="${c.filename}"` : ''
    return `--${boundary}\r\nContent-Disposition: form-data; name="${c.name}"${filenamePart}\r\n\r\n${c.valeur}\r\n`
  })
  return parts.join('') + `--${boundary}--\r\n`
}

// sonde brute : fetch/undici refuse d'émettre un Content-Type VIDE, on écrit donc la
// requête HTTP à la main sur une socket TCP (cf. render-server.ts, commentaire du garde 415).
function rawRequest(port: number, method: string, chemin: string, entetes: string[], corps: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      const lignes = [
        `${method} ${chemin} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Content-Length: ${Buffer.byteLength(corps)}`,
        'Connection: close',
        ...entetes,
        '', corps,
      ]
      sock.write(lignes.join('\r\n'))
    })
    let data = ''
    sock.on('data', (chunk) => { data += chunk.toString('utf-8') })
    sock.on('end', () => {
      const m = data.match(/^HTTP\/1\.\d (\d+)/)
      resolve({ status: m ? Number(m[1]) : 0 })
    })
    sock.on('error', reject)
  })
}

describe('render-server — chargeurs de props/actions .server.mjs + formulaires POST', () => {
  it('1. GET / protocole : props du chargeur (home: true)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const json = await (await getNav(running.port, '/')).json()
      assert.deepEqual(json.props, { home: true })
    } finally { await running.close() }
  })

  it('2. GET /p/42 protocole : params injectés par le chargeur', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const json = await (await getNav(running.port, '/p/42')).json()
      assert.deepEqual(json.props, { id: '42', source: 'chargeur' })
    } finally { await running.close() }
  })

  it('3. route sans entrée de chargeur (/other) : props {}', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const json = await (await getNav(running.port, '/other')).json()
      assert.deepEqual(json.props, {})
    } finally { await running.close() }
  })

  it('4. POST /p/42 name=bad (même origine) : 422 JSON, errors + props du chargeur', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=bad', { origin: `http://127.0.0.1:${running.port}` })
      assert.equal(res.status, 422)
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
      const json = await res.json()
      assert.equal(json.props.errors.name, 'invalide')
      assert.equal(json.props.id, '42')            // props du chargeur AUSSI présentes
      assert.equal(json.props.source, 'chargeur')
    } finally { await running.close() }
  })

  it('5. POST /p/42 name=ok : 303 + Location /p/42', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: `http://127.0.0.1:${running.port}` })
      assert.equal(res.status, 303)
      assert.equal(res.headers.get('location'), '/p/42')
    } finally { await running.close() }
  })

  it('5 bis. redirect protocole-relatif (//evil, /\\evil) : REFUSÉ, jamais de Location externe', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    writeFileSync(join(root, 'serve.server.mjs'), `export default {
  actions: {
    '/p/:id': (params, body, req) -> { redirect: body.cible }
  }
}
`)
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const origin = `http://127.0.0.1:${running.port}`
      for (const cible of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
        const res = await postForm(running.port, '/p/42', 'cible=' + encodeURIComponent(cible), { origin })
        assert.equal(res.status, 500, 'cible refusée : ' + cible)
        assert.equal(res.headers.get('location'), null)
      }
      const ok = await postForm(running.port, '/p/42', 'cible=' + encodeURIComponent('/p/7'), { origin })
      assert.equal(ok.status, 303)                 // une cible INTERNE passe toujours
      assert.equal(ok.headers.get('location'), '/p/7')
    } finally { await running.close() }
  })

  it('6. POST sur route sans action (/) : 405 + Allow', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/', 'x=1', { origin: `http://127.0.0.1:${running.port}` })
      assert.equal(res.status, 405)
      assert.equal(res.headers.get('allow'), 'GET, HEAD')
    } finally { await running.close() }
  })

  it('7. mauvais content-type : 415', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/p/42`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${running.port}` },
        body: '{}',
      })
      assert.equal(res.status, 415)
    } finally { await running.close() }
  })

  it('8. corps > 1 Mo : 413', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const enorme = 'name=' + 'x'.repeat(1_100_000)
      const res = await postForm(running.port, '/p/42', enorme, { origin: `http://127.0.0.1:${running.port}` })
      assert.equal(res.status, 413)
    } finally { await running.close() }
  })

  it('9. Origin http://evil.test : 403', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: 'http://evil.test' })
      assert.equal(res.status, 403)
    } finally { await running.close() }
  })

  it('10. Origin même host:port : accepté (même comportement que sans Origin)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: `http://127.0.0.1:${running.port}` })
      assert.equal(res.status, 303)
    } finally { await running.close() }
  })

  it('11. serveur SANS fichier d\'entrée : GET protocole → props {}', async function () {
    this.timeout(15000)
    const root = mjsTmp('serve-forms-noentry')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    const config = { sourceDir: 'src', outputDir: 'out', render: { routes: { '/': { component: 'mjs-home', mode: 'csr' as const } } } }
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const json = await (await getNav(running.port, '/')).json()
      assert.equal(json.module, 'mjs-home')
      assert.deepEqual(json.props, {})
    } finally { await running.close() }
  })

  it('12. GET HTML (sans en-tête), chargeurs présents : rendu HTML normal (non-régression)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/`)
      const html = await res.text()
      assert.match(res.headers.get('content-type') || '', /text\/html/)
      assert.match(html, /<mjs-home><\/mjs-home>/)
    } finally { await running.close() }
  })

  // contrôle d'origine configurable (render.allowedOrigins) : désactiver ou élargir la
  // garde same-origin de la branche POST (formulaires inter-domaines légitimes).
  it('13. allowedOrigins: false + Origin étrangère : PASSE (aucun contrôle, pas de 403)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    ;(config.render as any).allowedOrigins = false
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: 'http://evil.test' })
      assert.equal(res.status, 303)
    } finally { await running.close() }
  })

  it("14. allowedOrigins: ['http://ami.test'] + Origin http://ami.test : PASSE (allowlist)", async function () {
    this.timeout(15000)
    const { root, config } = setup()
    ;(config.render as any).allowedOrigins = ['http://ami.test']
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: 'http://ami.test' })
      assert.equal(res.status, 303)
    } finally { await running.close() }
  })

  it('15. même allowedOrigins + Origin http://evil.test (hors liste) : 403', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    ;(config.render as any).allowedOrigins = ['http://ami.test']
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: 'http://evil.test' })
      assert.equal(res.status, 403)
    } finally { await running.close() }
  })

  it('16. allowedOrigins absent + Origin étrangère : 403 (non-régression, cf. test 9)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: 'http://evil.test' })
      assert.equal(res.status, 403)
    } finally { await running.close() }
  })

  // le joker `['*']` est SUPPORTE franchement (« tout accepter »),
  // il n'est pas refuse au chargement ; un `*` colle a autre chose n'est PAS un motif.
  it("17bis. allowedOrigins: ['*'] + Origin etrangere : PASSE (joker « tout accepter »)", async function () {
    this.timeout(15000)
    const { root, config } = setup()
    ;(config.render as any).allowedOrigins = ['*']
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: 'http://evil.test' })
      assert.equal(res.status, 303)
    } finally { await running.close() }
  })

  it("17ter. allowedOrigins: ['*.ami.test'] (etoile collee, PAS un motif) + Origin http://sous.ami.test : 403", async function () {
    this.timeout(15000)
    const { root, config } = setup()
    ;(config.render as any).allowedOrigins = ['*.ami.test']
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: 'http://sous.ami.test' })
      assert.equal(res.status, 403)
    } finally { await running.close() }
  })

  it("17. allowedOrigins: 'nawak' (mal typé, ni tableau ni false) + Origin étrangère : 403 (repli same-origin strict)", async function () {
    this.timeout(15000)
    const { root, config } = setup()
    ;(config.render as any).allowedOrigins = 'nawak'
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: 'http://evil.test' })
      assert.equal(res.status, 403)
    } finally { await running.close() }
  })

  // PUT/PATCH/DELETE partagent DÉSORMAIS la même branche que POST (garde origin, content-
  // type, plafond, action, 303/422) : avant, ces 3 verbes tombaient dans le rendu de page (200,
  // action jamais invoquée, aucun signal). cf. render-server.ts (MUTATING_METHODS).
  it('18. PUT /p/42 name=ok (même origine) : action invoquée, 303 + Location /p/42', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: `http://127.0.0.1:${running.port}` }, 'PUT')
      assert.equal(res.status, 303)
      assert.equal(res.headers.get('location'), '/p/42')
    } finally { await running.close() }
  })

  it('19. PATCH /p/42 name=ok (même origine) : action invoquée, 303 + Location /p/42', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: `http://127.0.0.1:${running.port}` }, 'PATCH')
      assert.equal(res.status, 303)
      assert.equal(res.headers.get('location'), '/p/42')
    } finally { await running.close() }
  })

  // corps + Content-Type ABSENTS des deux (µ.ajax.delete n'a pas de paramètre `data`, cf.
  // mjs_ajax.ts) — le 415 ne doit PAS se déclencher sur une requête sans corps.
  it('20. DELETE /p/42 SANS corps ni Content-Type (même origine) : action invoquée, 303 — PAS de 415', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/p/42`, {
        method: 'DELETE',
        redirect: 'manual',
        headers: { origin: `http://127.0.0.1:${running.port}` },
      })
      assert.equal(res.status, 303)
      assert.equal(res.headers.get('location'), '/p/42')
    } finally { await running.close() }
  })

  it('21. GET /p/42 (sans en-tête) : rendu 200 HTML inchangé (non-régression)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/p/42`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') || '', /text\/html/)
    } finally { await running.close() }
  })

  it('22. PUT cross-origin (Origin étrangère) : 403', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: 'http://evil.test' }, 'PUT')
      assert.equal(res.status, 403)
    } finally { await running.close() }
  })

  // mjs serve apprend à lire multipart/form-data (champs TEXTE ; parties fichier ignorées).
  it('23. POST multipart 2 champs texte (name=ok, extra=1) : même effet que l\'urlencoded équivalent (303)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const boundary = 'mjsTestBoundary1'
      const corps = multipartBody(boundary, [{ name: 'name', valeur: 'ok' }, { name: 'extra', valeur: '1' }])
      const res = await fetch(`http://127.0.0.1:${running.port}/p/42`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, origin: `http://127.0.0.1:${running.port}` },
        body: corps,
      })
      assert.equal(res.status, 303)
      assert.equal(res.headers.get('location'), '/p/42')
    } finally { await running.close() }
  })

  it('24. POST multipart champs texte + partie fichier (filename présent) : texte parsé, fichier ignoré, pas de crash', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const boundary = 'mjsTestBoundary2'
      const corps = multipartBody(boundary, [
        { name: 'name', valeur: 'bad' },
        { name: 'fichier', filename: 'a.txt', valeur: 'contenu ignoré' },
      ])
      const res = await fetch(`http://127.0.0.1:${running.port}/p/42`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, origin: `http://127.0.0.1:${running.port}` },
        body: corps,
      })
      assert.equal(res.status, 422)
      const json = await res.json()
      assert.equal(json.props.errors.name, 'invalide')       // champ texte bien parsé
      assert.equal(json.props.id, '42')                      // pas de crash sur la partie fichier
    } finally { await running.close() }
  })

  it('25. PUT multipart name=ok : même branche, fonctionne (303)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const boundary = 'mjsTestBoundary3'
      const corps = multipartBody(boundary, [{ name: 'name', valeur: 'ok' }])
      const res = await fetch(`http://127.0.0.1:${running.port}/p/42`, {
        method: 'PUT', redirect: 'manual',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, origin: `http://127.0.0.1:${running.port}` },
        body: corps,
      })
      assert.equal(res.status, 303)
      assert.equal(res.headers.get('location'), '/p/42')
    } finally { await running.close() }
  })

  it('26. POST multipart SANS boundary dans le Content-Type : 400', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/p/42`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'multipart/form-data', origin: `http://127.0.0.1:${running.port}` },
        body: 'name=ok',
      })
      assert.equal(res.status, 400)
    } finally { await running.close() }
  })

  it('27. Content-Type PRÉSENT MAIS VIDE (PUT + corps urlencoded) : 415 (régression, sonde brute)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const { status } = await rawRequest(running.port, 'PUT', '/p/42', [
        `Origin: http://127.0.0.1:${running.port}`,
        'Content-Type:',
      ], 'name=ok')
      assert.equal(status, 415)
    } finally { await running.close() }
  })

  it('28. GET //p/42 (x-mjs-nav) : JSON du module de /p/42 — plus de host WHATWG avalé', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const json = await (await getNav(running.port, '//p/42')).json()
      assert.equal(json.module, 'mjs-page')
      assert.deepEqual(json.props, { id: '42', source: 'chargeur' })
    } finally { await running.close() }
  })

  // DÉFAUT RÉEL, corrigé
  // (RFC 2046) : parseMultipart cherchait le délimiteur SUIVANT par indexOf BRUT de `--boundary`,
  // sans exiger le CRLF qui le précède toujours réellement — une valeur de champ texte contenant
  // fortuitement (ou volontairement) la suite d'octets `--<boundary>` EN PLEIN MILIEU (donc SANS
  // CRLF juste avant) était prise pour une frontière, tronquant silencieusement la valeur. Le champ
  // `name` ci-dessous vaut littéralement `bad--BOUNDARYXtrailing` : AVANT le fix, tronqué à `bad` →
  // l'action voit `body.name is 'bad'` → 422 ; APRÈS le fix, valeur complète préservée (≠ 'bad') → 303.
  it("29. POST multipart, valeur de champ contenant littéralement --<boundary> (sans CRLF avant) : PAS de troncature (303, pas 422)", async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const boundary = 'BOUNDARYX'
      const corps = `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nbad--${boundary}trailing\r\n--${boundary}--\r\n`
      const res = await fetch(`http://127.0.0.1:${running.port}/p/42`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, origin: `http://127.0.0.1:${running.port}` },
        body: corps,
      })
      assert.equal(res.status, 303, "AVANT le fix : la valeur tronquée à 'bad' faisait échouer l'action (422)")
      assert.equal(res.headers.get('location'), '/p/42')
    } finally { await running.close() }
  })

  // `entry.actionFor(pathname)` n'était consulté qu'APRÈS la lecture complète du
  // corps (1 Mo bufferisé pour finir en 405) : un corps > 1 Mo vers une route SANS action
  // gagnait à tort un 413 (le plafond de l'étape c), jamais le 405 attendu.
  it('30. POST sur route SANS action, corps volumineux (>1 Mo) : 405 IMMÉDIAT, pas de 413', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const enorme = 'x=' + 'x'.repeat(1_100_000)
      const res = await postForm(running.port, '/', enorme, { origin: `http://127.0.0.1:${running.port}` })
      assert.equal(res.status, 405, 'AVANT le fix : le corps était lu (et plafonné) AVANT la vérification action → 413, jamais 405')
      assert.equal(res.headers.get('allow'), 'GET, HEAD')
    } finally { await running.close() }
  })

  // `parseMultipart` avertissait (console.error) une fois PAR PARTIE fichier ; le
  // commentaire d'en-tête du fichier dit « avertie une fois » — dédoublonné par nom de champ.
  it('31. POST multipart, DEUX parties FICHIER du MÊME champ : un seul console.error (dédoublonné par champ)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config as any, root, { port: 0 })
    const originalError = console.error
    const calls: any[] = []
    console.error = (...args: any[]) => { calls.push(args) }
    try {
      const boundary = 'mjsTestBoundaryDup'
      const corps = multipartBody(boundary, [
        { name: 'fichier', filename: 'a.txt', valeur: 'contenu A' },
        { name: 'fichier', filename: 'b.txt', valeur: 'contenu B' },
        { name: 'name', valeur: 'ok' },
      ])
      const res = await fetch(`http://127.0.0.1:${running.port}/p/42`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, origin: `http://127.0.0.1:${running.port}` },
        body: corps,
      })
      assert.equal(res.status, 303, 'name=ok : seul le champ fichier (doublon) est concerné')
      assert.equal(calls.length, 1, "DEUX parties fichier du MÊME champ ne doivent avertir qu'UNE FOIS (AVANT le fix : 2 appels)")
    } finally {
      console.error = originalError
      await running.close()
    }
  })

  // le catch de l'exécution d'action était MUET
  // (aucune trace) avant un 500 : cas le plus courant en dev (bug applicatif dans une action).
  it('32. action qui jette une exception : 500 inchangé, console.error loggé UNE fois (chemin + message)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    writeFileSync(join(root, 'serve.server.mjs'), `export default {
  actions: {
    '/p/:id': (params, body, req) ->
      throw new Error('boom action')
  }
}
`)
    const running = await startRenderServer(config as any, root, { port: 0 })
    const originalError = console.error
    const calls: any[] = []
    console.error = (...args: any[]) => { calls.push(args) }
    try {
      const res = await postForm(running.port, '/p/42', 'name=ok', { origin: `http://127.0.0.1:${running.port}` })
      assert.equal(res.status, 500)
      assert.equal(await res.text(), 'Internal Server Error')
      assert.equal(calls.length, 1, 'un seul console.error attendu pour ce catch (AVANT le fix : silence total)')
      const texte = calls[0].join(' ')
      assert.match(texte, /\/p\/42/, 'le chemin doit apparaître dans le log')
      assert.match(texte, /boom action/, "le message de l'exception doit apparaître dans le log")
    } finally {
      console.error = originalError
      await running.close()
    }
  })

  // le catch GLOBAL (render-server.ts, dernier filet) était MUET lui aussi. Déclenché ici
  // SANS contorsion : un chargeur de props (.server.mjs) qui jette relance DÉLIBÉRÉMENT (contrat
  // documenté serve-entry.ts, propsFor) — l'appelant (branche GET protocole X-MJS-Nav) ne
  // l'intercepte pas, donc l'exception remonte jusqu'au catch global. entry.propsFor logue déjà
  // 'server.entry-props-echec' AVANT de relancer : DEUX appels console.error attendus ici (le sien
  // + le nouveau 'server.erreur-imprevue' du catch global), pas une régression.
  it('33. props loader qui jette (GET X-MJS-Nav) : catch global — 500 inchangé, console.error avec chemin + message', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    ;(config.render.routes as any)['/boom'] = { component: 'mjs-home', mode: 'csr' as const }
    writeFileSync(join(root, 'serve.server.mjs'), `export default {
  props: {
    '/boom': (params, req) ->
      throw new Error('kaboom')
  }
}
`)
    const running = await startRenderServer(config as any, root, { port: 0 })
    const originalError = console.error
    const calls: any[] = []
    console.error = (...args: any[]) => { calls.push(args) }
    try {
      const res = await getNav(running.port, '/boom')
      assert.equal(res.status, 500)
      assert.equal(await res.text(), 'Internal Server Error')
      assert.equal(calls.length, 2, 'entry-props-echec (serve-entry, contrat existant) + erreur-imprevue (catch global)')
      const texte = calls.map((a) => a.join(' ')).join('\n')
      assert.match(texte, /\/boom/, 'le chemin doit apparaître dans au moins un log')
      assert.match(texte, /kaboom/, "le message de l'exception doit apparaître dans au moins un log")
    } finally {
      console.error = originalError
      await running.close()
    }
  })
})
