// render.forwardOrigin — SSRF, cf. src/server/forward-origin.ts.
// AVANT ce correctif, `computeForwardedOrigin` dérivait l'origine de proxy
// DIRECTEMENT du `Host` brut de la requête entrante — un `Host: 169.254.169.254`
// (métadonnées cloud) ou toute IP interne suffisait à faire exécuter par happy-dom/
// le moteur navigateur une VRAIE requête sortante, réfléchie dans le HTML. CE
// FICHIER encode le nouveau contrat SÉCURISÉ (plus jamais de dérivation depuis
// Host sans autorisation EXPLICITE + défense en profondeur IP interne) :
//   1. computeForwardedOrigin/isBlockedForwardTarget (logique PURE, sans réseau).
//   2. bout en bout (happy-dom, via createRenderHandler comme `mjs serve`) :
//      preuve RÉSEAU que (a) un Host arbitraire (attaquant) n'est jamais forwardé
//      par défaut, et (b) même listé dans une allowlist large, un Host résolvant
//      en IP interne (loopback) reste bloqué — défense en profondeur active au
//      point de consommation, pas seulement dans computeForwardedOrigin.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { createRenderHandler, computeForwardedOrigin, isBlockedForwardTarget } from '../src/server/render-request.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

// Petit serveur d'écho : répond à /api/qui avec le cookie brut reçu (ou
// 'ANONYME' si aucun) — sert de « cible réseau » (toujours en loopback, donc
// toujours dans le périmètre bloqué par isBlockedForwardTarget) pour les tests
// bout en bout.
function startEchoServer(): Promise<{ host: string; close: () => Promise<void> }> {
  return new Promise((resolveStart) => {
    const server = createServer((req, res) => {
      if (req.url === '/api/qui') {
        res.setHeader('content-type', 'text/plain')
        res.end(req.headers.cookie || 'ANONYME')
        return
      }
      res.statusCode = 404
      res.end('Not Found')
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any
      resolveStart({
        host: `127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

describe('computeForwardedOrigin — logique pure (forward-origin.ts), sans réseau', () => {
  it('défaut (render.forwardOrigin absent) : SÛR — jamais de forwardedUrl dérivé du Host', () => {
    const out = computeForwardedOrigin(undefined, '/blog/42', { host: 'attaquant.exemple', cookie: 'a=1; b=2' })
    assert.deepEqual(out, {})
  })

  it('render.forwardOrigin: true (explicite) — PAS une autorisation d\'hôte, même comportement SÛR que le défaut', () => {
    const out = computeForwardedOrigin({ forwardOrigin: true }, '/', { host: 'attaquant.exemple' })
    assert.deepEqual(out, {})
  })

  it('render.forwardOrigin: false — désactivé, jamais de forwardedUrl ni forwardedCookie', () => {
    const out = computeForwardedOrigin({ forwardOrigin: false }, '/blog/42', { host: 'exemple.com', cookie: 'a=1' })
    assert.deepEqual(out, {})
  })

  it('origine FIXE (chaîne) : toujours CETTE valeur, quel que soit le Host envoyé par le client', () => {
    const out = computeForwardedOrigin({ forwardOrigin: 'https://back.exemple.com' }, '/blog/42', { host: 'attaquant.exemple', cookie: 'a=1' })
    assert.equal(out.forwardedUrl, 'https://back.exemple.com/blog/42')
    assert.equal(out.forwardedCookie, 'a=1')
  })

  it('origine FIXE pointant vers une IP interne : refusée (défense en profondeur), quelle que soit la config', () => {
    const out = computeForwardedOrigin({ forwardOrigin: 'http://169.254.169.254' }, '/x', { host: 'attaquant.exemple' })
    assert.deepEqual(out, {})
  })

  it('trustedHosts : Host entrant listé — forwarding fonctionne comme avant (proto + host + pathname)', () => {
    const out = computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['exemple.com'] } }, '/blog/42', {
      host: 'exemple.com', cookie: 'a=1; b=2', 'x-forwarded-proto': 'https',
    })
    assert.equal(out.forwardedUrl, 'https://exemple.com/blog/42')
    assert.equal(out.forwardedCookie, 'a=1; b=2')
  })

  it('trustedHosts : Host entrant NON listé — repli sûr (pas de forwardedUrl, pas de fuite)', () => {
    const out = computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['exemple.com'] } }, '/x', { host: 'attaquant.exemple', cookie: 'sid=secret' })
    assert.deepEqual(out, {})
  })

  it('trustedHosts large (169.254.169.254, 127.0.0.1, 10.x listés) : IP interne refusée même autorisée explicitement', () => {
    const large = { trustedHosts: ['169.254.169.254', '127.0.0.1', '10.0.0.5'] }
    assert.deepEqual(computeForwardedOrigin({ forwardOrigin: large }, '/x', { host: '169.254.169.254' }), {})
    assert.deepEqual(computeForwardedOrigin({ forwardOrigin: large }, '/x', { host: '127.0.0.1' }), {})
    assert.deepEqual(computeForwardedOrigin({ forwardOrigin: large }, '/x', { host: '10.0.0.5' }), {})
  })

  it('Host absent — rien à composer (pas de forwardedUrl), même avec trustedHosts', () => {
    assert.deepEqual(computeForwardedOrigin(undefined, '/x', {}), {})
    assert.deepEqual(computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['exemple.com'] } }, '/x', {}), {})
  })

  it('en-têtes en tableau (Host/Cookie/x-forwarded-proto) — 1ère valeur retenue (chemin trustedHosts)', () => {
    const out = computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['exemple.com'] } }, '/x', {
      host: ['exemple.com', 'autre.com'],
      cookie: ['a=1', 'b=2'],
      'x-forwarded-proto': ['https', 'http'],
    })
    assert.equal(out.forwardedUrl, 'https://exemple.com/x')
    assert.equal(out.forwardedCookie, 'a=1')
  })

  // Proto usurpé (X-Forwarded-Proto porte une URL complète, pas un
  // schéma) : AVANT le fix, l'hôte lu par `new URL(forwardedUrl)` était attaquant.example, jamais
  // l'hôte autorisé — la fuite de forwardedCookie suivait cette URL truquée.
  it('(a) proto usurpé (X-Forwarded-Proto = URL complète) : jamais attaquant.example, même en repli', () => {
    const out = computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['hote-autorise'] } }, '/chemin', {
      host: 'hote-autorise', 'x-forwarded-proto': 'http://attaquant.example/?',
    })
    if (out.forwardedUrl) assert.equal(new URL(out.forwardedUrl).host, 'hote-autorise')
    else assert.deepEqual(out, {})
  })

  it('(b) proto ni http ni https (\'javascript\') : repli http:// (jamais le schéma reçu tel quel)', () => {
    const out = computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['exemple.com'] } }, '/x', {
      host: 'exemple.com', 'x-forwarded-proto': 'javascript',
    })
    assert.equal(out.forwardedUrl, 'http://exemple.com/x')
  })

  it('(c) proto avec casse et espace (\'HTTPS \') — normalisé en https://', () => {
    const out = computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['exemple.com'] } }, '/x', {
      host: 'exemple.com', 'x-forwarded-proto': 'HTTPS ',
    })
    assert.equal(out.forwardedUrl, 'https://exemple.com/x')
  })

  // (d) — AVANT le fix, `stripPort` (un seul ':' recherché) lisait 'hote.example' dans
  // 'hote.example:80@attaquant.example', qui figurait dans l'allowlist ; l'URL composée pointait
  // ensuite attaquant.example via la syntaxe userinfo (user:pass@hote).
  it('(d) Host à syntaxe userinfo (hote.example:80@attaquant.example) : refusé (repli sûr)', () => {
    const out = computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['hote.example'] } }, '/x', {
      host: 'hote.example:80@attaquant.example',
    })
    assert.deepEqual(out, {})
  })

  it('(e) Host trusted sans port et avec port : URL intacte (non-régression)', () => {
    const sansPort = computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['hote.example'] } }, '/x', { host: 'hote.example' })
    assert.equal(sansPort.forwardedUrl, 'http://hote.example/x')
    const avecPort = computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['hote.example'] } }, '/x', { host: 'hote.example:8080' })
    assert.equal(avecPort.forwardedUrl, 'http://hote.example:8080/x')
  })

  it('(f) Host IPv6 avec port ([2001:db8::1]:3000), listé sous 2001:db8::1 : URL intacte (comportement figé de stripPort)', () => {
    const out = computeForwardedOrigin({ forwardOrigin: { trustedHosts: ['2001:db8::1'] } }, '/x', { host: '[2001:db8::1]:3000' })
    assert.equal(out.forwardedUrl, 'http://[2001:db8::1]:3000/x')
  })
})

describe('isBlockedForwardTarget — plages réseau internes bloquées (fonction pure)', () => {
  const blocked = [
    '169.254.169.254', '169.254.1.1',            // lien-local + métadonnées cloud
    '127.0.0.1', '127.0.0.1:3000',                 // loopback
    '10.0.0.1', '10.255.255.255',                   // 10/8
    '172.16.0.1', '172.31.255.255',                 // 172.16/12
    '192.168.1.1',                                  // 192.168/16
    '0.0.0.0',                                      // 0/8
    '::1', '[::1]:3000',                             // loopback IPv6
    'fc00::1', 'fd12:3456::1',                       // fc00::/7 (ULA)
    'fe80::1',                                       // fe80::/10 (lien-local)
    '::ffff:127.0.0.1',                              // IPv4-mappée
    'localhost', 'sub.localhost',
    '100.64.0.1',                                    // 100.64.0.0/10, CGNAT
    '224.0.0.1', '255.255.255.255',                   // 224.0.0.0/4 + 240.0.0.0/4
  ]
  for (const host of blocked) {
    it(`bloque ${host}`, () => assert.equal(isBlockedForwardTarget(host), true))
  }

  const allowed = ['exemple.com', 'back.exemple.com:8080', '8.8.8.8', '2001:4860:4860::8888', '100.63.255.255']
  for (const host of allowed) {
    it(`laisse passer ${host} (hors périmètre IP interne)`, () => assert.equal(isBlockedForwardTarget(host), false))
  }
})

describe('isBlockedForwardTarget — IPv4-mappée sous SA FORME HEX (celle réellement produite par new URL().host, jamais la dotted-decimal)', () => {
  // `new URL('http://[::ffff:x.x.x.x]/').host` normalise TOUJOURS en groupes hex
  // (`'[::ffff:HHHH:HHHH]'`) — c'est CETTE forme, sans crochets, que le code voit
  // vraiment aux points d'appel (renderToString.ts/render-browser.ts), jamais
  // `::ffff:a.b.c.d`.
  function hostViaNewUrl(ipv4: string): string {
    return new URL(`http://[::ffff:${ipv4}]/`).host.replace(/^\[|\]$/g, '')
  }

  const blockedIpv4 = [
    '169.254.169.254',   // métadonnées cloud
    '127.0.0.1',          // loopback
    '10.0.0.1',            // 10/8
    '192.168.1.1',          // 192.168/16
  ]
  for (const ipv4 of blockedIpv4) {
    const host = hostViaNewUrl(ipv4)
    it(`bloque ${host} (forme hex de ${ipv4} produite par new URL())`, () => assert.equal(isBlockedForwardTarget(host), true))
  }

  it('laisse passer ::ffff:808:808 (forme hex de 8.8.8.8, IP publique — pas de sur-blocage)', () => {
    const host = hostViaNewUrl('8.8.8.8')
    assert.equal(host, '::ffff:808:808')
    assert.equal(isBlockedForwardTarget(host), false)
  })

  it('casse indifférente (::FFFF:A9FE:A9FE)', () => assert.equal(isBlockedForwardTarget('::FFFF:A9FE:A9FE'), true))
})

// Formes IPv4 NON CANONIQUES (décimal pur, hexadécimal, octal, notation
// courte) : le parseur WHATWG (new URL) les résout TOUTES en 127.0.0.1 mais la regex dotted-
// decimal de isBlockedForwardTarget ne les reconnaissait pas — non bloquées avant ce fix.
describe('isBlockedForwardTarget — formes IPv4 non canoniques (canonicalisées via le parseur)', () => {
  const nonCanoniques = ['2130706433', '0x7f000001', '0177.0.0.1', '127.1', '0x7f.1']
  for (const host of nonCanoniques) {
    it(`bloque ${host} (désigne 127.0.0.1 pour le parseur)`, () => assert.equal(isBlockedForwardTarget(host), true))
  }

  it('hôte inanalysable (\'ex ample\') : bloqué par prudence', () => assert.equal(isBlockedForwardTarget('ex ample'), true))
})

describe('render-request — render.forwardOrigin bout en bout (happy-dom), défense SSRF active', () => {
  after(async () => { await terminateSharedWorkerPool() })

  function project(): string {
    const root = mjsTmp('fwdorigin')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'qui.mjs'), `
<script lang="coffee">
$promise = fetch('/api/qui').then((r) -> r.text())
</script>
{await $promise}<span class="pending">chargement</span>{success txt}<span class="who">{txt}</span>{error err}<span class="err">{err.message}</span>{end}
`)
    return root
  }

  it("défaut (rien configuré) : un Host ENTRANT arbitraire (attaquant, ici la cible réseau réelle du test) n'est JAMAIS forwardé — aucune fuite du cookie", async function () {
    this.timeout(30000)
    const echo = await startEchoServer()
    try {
      const config = {
        sourceDir: 'src', outputDir: 'public/out',
        render: { routes: { '/': { component: 'mjs-qui', mode: 'ssr' as const, settleMs: 2000 } } },
      }
      const h = await createRenderHandler(config, project())
      try {
        // `host` = l'origine du serveur d'écho, EXACTEMENT ce qu'un attaquant
        // enverrait en en-tête Host pour tenter d'atteindre un réseau interne.
        const res = await h.handle('/', { host: echo.host, cookie: 'sid=secret-abc' })
        assert.equal(res.kind, 'ssr')
        assert.doesNotMatch(res.body, /secret-abc/, 'le cookie ne doit JAMAIS atteindre une cible dérivée du Host client — SSRF fermée par défaut')
      } finally {
        await h.close()
      }
    } finally {
      await echo.close()
    }
  })

  it('trustedHosts LARGE (autorise explicitement le Host du test, une IP loopback) : toujours bloqué — défense en profondeur au point de consommation', async function () {
    this.timeout(30000)
    const echo = await startEchoServer()
    try {
      const config = {
        sourceDir: 'src', outputDir: 'public/out2',
        render: {
          forwardOrigin: { trustedHosts: [echo.host] },
          routes: { '/': { component: 'mjs-qui', mode: 'ssr' as const, settleMs: 2000 } },
        },
      }
      const h = await createRenderHandler(config, project())
      try {
        const res = await h.handle('/', { host: echo.host, cookie: 'sid=secret-abc' })
        assert.equal(res.kind, 'ssr')
        assert.doesNotMatch(res.body, /secret-abc/, 'une allowlist qui autorise explicitement une IP loopback reste bloquée par isBlockedForwardTarget, MÊME au point de consommation (renderToString.ts), pas seulement dans computeForwardedOrigin')
      } finally {
        await h.close()
      }
    } finally {
      await echo.close()
    }
  })

  it('sans Host exploitable dans les en-têtes (ex. appel direct hors HTTP réel) : repli localhost figé, comportement historique', async function () {
    this.timeout(30000)
    const config = {
      sourceDir: 'src', outputDir: 'public/out3',
      render: { routes: { '/': { component: 'mjs-qui', mode: 'ssr' as const, settleMs: 300 } } },
    }
    const h = await createRenderHandler(config, project())
    try {
      const res = await h.handle('/')   // aucun en-tête
      assert.equal(res.kind, 'ssr')
      // Le fetch relatif part sur 'http://localhost/api/qui' (personne n'y répond
      // dans ce test) : ni la branche succès (cookie) ni un crash du rendu lui-même
      // — juste un avertissement de non-stabilisation, comportement HISTORIQUE.
      assert.doesNotMatch(res.body, /secret-abc/)
    } finally {
      await h.close()
    }
  })
})
