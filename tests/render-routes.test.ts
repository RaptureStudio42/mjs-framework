// Résolution des PAGES (niveau 1) : URL → composant + mode + params.
// Logique pure, sans runtime ni serveur.

import assert from 'node:assert/strict'
import {
  matchPattern, resolvePage, normalizeMode, isBuildPrerenderable, FALLBACK_MODE,
} from '../src/server/render-routes.js'

describe('render-routes — matchPattern', () => {
  it('exact', () => {
    assert.deepEqual(matchPattern('/blog', '/blog'), {})
  })
  it('racine /', () => {
    assert.deepEqual(matchPattern('/', '/'), {})
  })
  it('param :id', () => {
    assert.deepEqual(matchPattern('/produit/:id', '/produit/42'), { id: '42' })
  })
  it('param décodé', () => {
    assert.deepEqual(matchPattern('/tag/:t', '/tag/a%2Fb'), { t: 'a/b' })
  })
  it('catch-all * — rest (chaîne) et all (tableau)', () => {
    assert.deepEqual(matchPattern('/files/*', '/files/a/b/c'), { rest: 'a/b/c', all: ['a', 'b', 'c'] })
  })
  it('longueur différente → null', () => {
    assert.equal(matchPattern('/blog', '/blog/x'), null)
    assert.equal(matchPattern('/blog/x', '/blog'), null)
  })
  it('segment littéral non concordant → null', () => {
    assert.equal(matchPattern('/blog', '/shop'), null)
  })
})

describe('render-routes — resolvePage', () => {
  const render = {
    default: 'prerender' as const,
    routes: {
      '/':            { component: 'mjs-landing' },
      '/blog':        { component: 'mjs-blog', mode: 'ssr' as const },
      '/blog/new':    { component: 'mjs-blog-new' },
      '/blog/:slug':  { component: 'mjs-article' },
      '/app':         { component: 'mjs-app', mode: 'csr' as const },
    },
  }

  it('page racine → hérite default (prerender)', () => {
    assert.deepEqual(resolvePage('/', render), { component: 'mjs-landing', mode: 'prerender', params: {} })
  })
  it('mode explicite ssr → normalisé ssr:replace', () => {
    assert.equal(resolvePage('/blog', render)!.mode, 'ssr:replace')
  })
  it('mode explicite csr respecté', () => {
    assert.equal(resolvePage('/app', render)!.mode, 'csr')
  })
  it('spécificité : /blog/new gagne sur /blog/:slug', () => {
    assert.equal(resolvePage('/blog/new', render)!.component, 'mjs-blog-new')
  })
  it('param capturé sur /blog/:slug', () => {
    const p = resolvePage('/blog/mon-article', render)!
    assert.equal(p.component, 'mjs-article')
    assert.deepEqual(p.params, { slug: 'mon-article' })
    assert.equal(p.mode, 'prerender') // hérite default
  })
  it('URL non déclarée → null (le back sert le shell/CSR)', () => {
    assert.equal(resolvePage('/inexistant', render), null)
  })
  it('pas de bloc render → null', () => {
    assert.equal(resolvePage('/', undefined), null)
  })
  it('override par header', () => {
    // /blog est ssr:replace en config, le header force csr
    assert.equal(resolvePage('/blog', render, 'csr')!.mode, 'csr')
  })
  it('header invalide ignoré', () => {
    assert.equal(resolvePage('/blog', render, 'nimportequoi')!.mode, 'ssr:replace')
  })

  // `X-MJS-Render` est un en-tête HTTP
  // fourni PAR LE CLIENT, sans authentification ni vérification d'origine.
  // Avant ce fix, il surchargeait le mode SANS AUCUNE BORNE : n'importe quel
  // appelant pouvait forcer `ssr` (compile + eval happy-dom + render PAR
  // REQUÊTE, coûteux) sur une route configurée `csr`/`prerender` (bon
  // marché) — amplification DoS triviale, répétable en boucle. Seule la
  // DÉGRADATION (vers moins cher) est un usage légitime documenté (cas
  // `/blog` ssr→csr ci-dessus) ; l'AUGMENTATION doit être bloquée.
  describe('le header ne peut RÉDUIRE le coût, jamais l’AUGMENTER (anti-amplification DoS)', () => {
    it("force ssr sur une route CSR → reste csr (AVANT le fix : passait à ssr:replace)", () => {
      assert.equal(resolvePage('/app', render, 'ssr')!.mode, 'csr')
    })
    it("force ssr sur une route PRERENDER (défaut hérité) → reste prerender", () => {
      assert.equal(resolvePage('/', render, 'ssr')!.mode, 'prerender')
    })
    it("force prerender sur une route CSR → reste csr (prerender aussi plus cher que csr : fallback SSR si fichier absent)", () => {
      assert.equal(resolvePage('/app', render, 'prerender')!.mode, 'csr')
    })
    it('dégradation vers csr depuis ssr : toujours autorisée (cas déjà couvert ci-dessus, non régressé)', () => {
      assert.equal(resolvePage('/blog', render, 'csr')!.mode, 'csr')
    })
    it('dégradation vers csr depuis prerender : autorisée', () => {
      assert.equal(resolvePage('/', render, 'csr')!.mode, 'csr')
    })
    it('coût ÉGAL (route déjà ssr, header choisit une AUTRE variante ssr) : autorisé', () => {
      assert.equal(resolvePage('/blog', render, 'ssr:markers')!.mode, 'ssr:markers')
    })
  })
})

describe('render-routes — helpers', () => {
  it('normalizeMode ssr → ssr:replace', () => {
    assert.equal(normalizeMode('ssr'), 'ssr:replace')
    assert.equal(normalizeMode('ssr:markers'), 'ssr:markers')
    assert.equal(normalizeMode('csr'), 'csr')
  })
  it('FALLBACK_MODE = prerender', () => {
    assert.equal(FALLBACK_MODE, 'prerender')
  })
  it('isBuildPrerenderable : route concrète prerender → oui', () => {
    assert.equal(isBuildPrerenderable('/blog', 'prerender'), true)
    assert.equal(isBuildPrerenderable('/', 'prerender'), true)
  })
  it('isBuildPrerenderable : route paramétrée → non (pas d’ids au build)', () => {
    assert.equal(isBuildPrerenderable('/produit/:id', 'prerender'), false)
    assert.equal(isBuildPrerenderable('/files/*', 'prerender'), false)
  })
  it('isBuildPrerenderable : mode non-prerender → non', () => {
    assert.equal(isBuildPrerenderable('/blog', 'ssr'), false)
    assert.equal(isBuildPrerenderable('/blog', 'csr'), false)
  })
})
