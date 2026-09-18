// Bloc racine <routes target="…"> — table de routes FIXES, alternative déclarative à
// l'objet `@routes` calculé du <script> (réservé, lui, aux tables construites en boucle).
// Le bloc compile en `this.routes = { '<target>': { '<chemin>': '<composant>', … }, … };`,
// injecté EN TÊTE du JS d'init, AVANT le code du <script> — `detectRouterAware` doit donc
// voir la table et marquer le composant router-aware, et le préchargement compile-time des
// composants de route doit fonctionner tel quel sur l'objet émis.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'
import { extractSections } from '../src/transpiler/sections.js'
import { parseRoutesLines } from '../src/transpiler/sections.js'

describe('<routes target="…"> — extraction (sections.ts)', () => {
  it('parseRoutesLines : chemin + composant, lignes vides et commentaires ignorés', () => {
    const raw = [
      '',
      '# commentaire',
      '/              home-page',
      '/guide/:id     guide-page',
      '/archive/(:an) archive-page',
      '/docs/*        docs-shell',
    ].join('\n')
    const entries = parseRoutesLines(raw, 'doc-content')
    assert.deepEqual(entries, [
      ['/', 'home-page'],
      ['/guide/:id', 'guide-page'],
      ['/archive/(:an)', 'archive-page'],
      ['/docs/*', 'docs-shell'],
    ])
  })

  it('extractSections repère le bloc, son target, et le retire du html', () => {
    const src = [
      '<routes target="doc-content">',
      '  /   home-page',
      '</routes>',
      '<p>hello</p>',
    ].join('\n')
    const secs = extractSections(src)
    assert.equal(secs.routes.length, 1)
    assert.equal(secs.routes[0].target, 'doc-content')
    assert.deepEqual(secs.routes[0].entries, [['/', 'home-page']])
    assert.doesNotMatch(secs.html, /<routes/)
    assert.match(secs.html, /<p>hello<\/p>/)
  })

  it('target manquant → erreur', () => {
    const src = ['<routes>', '  /   home-page', '</routes>', '<p/>'].join('\n')
    assert.throws(() => extractSections(src), /target="…".*obligatoire/s)
  })

  it('target vide → erreur', () => {
    const src = ['<routes target="">', '  /   home-page', '</routes>', '<p/>'].join('\n')
    assert.throws(() => extractSections(src), /target="…".*obligatoire/s)
  })

  it('deux blocs avec le même target → erreur', () => {
    const src = [
      '<routes target="doc-content">',
      '  /   home-page',
      '</routes>',
      '<routes target="doc-content">',
      '  /guide   guide-page',
      '</routes>',
      '<p/>',
    ].join('\n')
    assert.throws(() => extractSections(src), /deux blocs <routes target="doc-content">/)
  })

  it('deux blocs avec des target différents cohabitent', () => {
    const src = [
      '<routes target="doc-content">',
      '  /   home-page',
      '</routes>',
      '<routes target="side-content">',
      '  /nav   nav-page',
      '</routes>',
      '<p/>',
    ].join('\n')
    const secs = extractSections(src)
    assert.equal(secs.routes.length, 2)
    assert.deepEqual(secs.routes.map(r => r.target).sort(), ['doc-content', 'side-content'])
  })

  it('chemin sans slash initial → erreur nommant la ligne', () => {
    const src = ['<routes target="doc-content">', '  guide   guide-page', '</routes>', '<p/>'].join('\n')
    assert.throws(() => extractSections(src), /ligne 2.*doit commencer par \//s)
  })

  // Ce cas levait « mal formé » : le validateur du bloc interdisait l'optionnel
  // ailleurs qu'en dernier segment, alors que le routeur le matche (retour arrière de
  // `_matchSegs`, cf. tests/router-optional-mid-segment.test.ts) et que `@routes` l'acceptait
  // déjà. Le bloc est désormais aligné sur le moteur — les deux formes sont interchangeables.
  it('optionnel en MILIEU de route → accepté (aligné sur le routeur et sur @routes)', () => {
    const src = ['<routes target="doc-content">', '  /(:an)/b   x-page', '</routes>', '<p/>'].join('\n')
    const secs = extractSections(src)
    assert.equal(secs.routes.length, 1)
    assert.deepEqual(secs.routes[0].entries, [['/(:an)/b', 'x-page']])
  })

  it('chemin mal formé (catch-all PAS en fin de route) → erreur', () => {
    const src = ['<routes target="doc-content">', '  /*/b   x-page', '</routes>', '<p/>'].join('\n')
    assert.throws(() => extractSections(src), /mal formé/)
  })

  it('nom de composant invalide (majuscule, préfixe mjs-) → erreur', () => {
    const src = ['<routes target="doc-content">', '  /   MjsHomePage', '</routes>', '<p/>'].join('\n')
    assert.throws(() => extractSections(src), /nom de composant valide/)
  })

  it('chemin en double dans le même bloc → erreur', () => {
    const src = [
      '<routes target="doc-content">',
      '  /guide   guide-page',
      '  /guide   guide-page-bis',
      '</routes>',
      '<p/>',
    ].join('\n')
    assert.throws(() => extractSections(src), /apparaît deux fois/)
  })

  it('ligne malformée (un seul token) → erreur', () => {
    const src = ['<routes target="doc-content">', '  /guide', '</routes>', '<p/>'].join('\n')
    assert.throws(() => extractSections(src), /attendu un chemin puis un nom de composant/)
  })

  it('</routes> orphelin (sans <routes> ouvrante correspondante) déclenche le garde-fou orphelin', () => {
    const src = '<p>oops</routes></p>'
    assert.throws(() => extractSections(src), /orphelin/)
  })

  // commenter un bloc doit le DÉSACTIVER — sinon une route mise de côté à la main, ou un exemple
  // écrit en commentaire, se rallume en silence (table posée, composant router-aware, préchargement)
  it('un bloc <routes> dans un COMMENTAIRE HTML reste inerte — aucune table, aucun garde-fou orphelin', () => {
    const src = '<!--\n<routes target="doc-content">\n  /   home-page\n</routes>\n-->\n<div>hello</div>\n'
    const out = extractSections(src)
    assert.deepEqual(out.routes, [])
  })

  it('le même bloc HORS commentaire est bien lu (contre-cas du test précédent)', () => {
    const src = '<routes target="doc-content">\n  /   home-page\n</routes>\n<div>hello</div>\n'
    const out = extractSections(src)
    assert.equal(out.routes.length, 1)
    assert.deepEqual(out.routes[0].entries, [['/', 'home-page']])
  })
})

describe('<routes> — compilation (transpiler/index.ts)', function () {
  this.timeout(30000)

  it('cas nominal : this.routes émis avec la table attendue, composant router-aware', async () => {
    const src = [
      '<routes target="doc-content">',
      '  /              home-page',
      '  /guide/:id     guide-page',
      '</routes>',
      '<p>ok</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'routes-nominal' })
    assert.match(output, /this\.routes\s*=\s*\{\s*"doc-content"\s*:\s*\{\s*"\/"\s*:\s*"home-page",\s*"\/guide\/:id"\s*:\s*"guide-page"\s*\},?\s*\}/)
    assert.match(output, /_mjs_is_router_aware = true/)
  })

  it('préchargement compile-time : µ.Autoloader?.load?.(\'mjs-<composant>\') émis pour chaque route', async () => {
    const src = [
      '<routes target="doc-content">',
      '  /          home-page',
      '  /guide     guide-page',
      '</routes>',
      '<p>ok</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'routes-preload' })
    assert.match(output, /µ\.Autoloader\?\.load\?\.\('mjs-home-page'\)/)
    assert.match(output, /µ\.Autoloader\?\.load\?\.\('mjs-guide-page'\)/)
  })

  it('le script peut COMPLÉTER la table posée par le bloc (mutation, pas réassignation)', async () => {
    const src = [
      '<routes target="doc-content">',
      '  /   home-page',
      '</routes>',
      '<script>',
      "@routes['doc-content']['/extra'] = 'extra-page'",
      '</script>',
      '<p>ok</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'routes-completion' })
    assert.match(output, /this\.routes\s*=\s*\{\s*"doc-content"\s*:\s*\{\s*"\/"\s*:\s*"home-page"\s*\}\s*\}/)
    assert.match(output, /routes\['doc-content'\]\['\/extra'\]\s*=\s*'extra-page'/)
  })

  // Écraser la table du bloc depuis le script est un DROIT du
  // développeur (documenté, docs/17-router.md) : la compilation PASSE et se contente d'un
  // avertissement, parce que l'écrasement est invisible à la lecture.
  it('réassignation `@routes = …` avec un bloc <routes> présent → compile + AVERTISSEMENT', async () => {
    const src = [
      '<routes target="doc-content">',
      '  /   home-page',
      '</routes>',
      '<script>',
      '@routes =',
      "  '/autre': 'autre-page'",
      '</script>',
      '<p>ok</p>',
    ].join('\n')
    const { data, output } = await transpile(src, { moduleName: 'routes-reassign' })
    assert.ok(data.sectionWarnings.some(w => /RÉASSIGNE @routes/.test(w)), 'avertissement de réassignation attendu')
    // les DEUX assignations sont émises, celle du script en second : c'est elle qui gagne
    const posBloc   = output.indexOf('"doc-content"')
    const posScript = output.indexOf("'/autre'")
    assert.ok(posBloc >= 0 && posScript > posBloc, 'la table du script doit être émise APRÈS celle du bloc')
  })

  it('mutation seule (pas de réassignation) → AUCUN avertissement', async () => {
    const src = [
      '<routes target="doc-content">',
      '  /   home-page',
      '</routes>',
      '<script>',
      "@routes['doc-content']['/extra'] = 'extra-page'",
      '</script>',
      '<p>ok</p>',
    ].join('\n')
    const { data } = await transpile(src, { moduleName: 'routes-completion-warn' })
    assert.ok(!data.sectionWarnings.some(w => /RÉASSIGNE @routes/.test(w)), 'aucun avertissement attendu')
  })

  it('non-régression : composant SANS bloc <routes>, @routes pur continue de marcher', async () => {
    const src = ['<script>', '@routes =', "  '/': 'home-page'", '</script>', '<p>ok</p>'].join('\n')
    const { output } = await transpile(src, { moduleName: 'routes-legacy-pure' })
    assert.match(output, /_mjs_is_router_aware = true/)
    assert.match(output, /routes\s*=\s*\{\s*'\/'\s*:\s*'home-page',?\s*\}/)
  })
})
