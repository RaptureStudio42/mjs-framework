// Lint « accessibilité » (lint.a11y) — sept contrôles
// ciblés (image sans alt, iframe sans title, tabindex positif, @click non
// interactif, bouton/lien sans nom accessible, champ de saisie sans étiquette),
// chacun un simple AVERTISSEMENT console (jamais bloquant), ACTIVÉ PAR DÉFAUT.
// Configurable par le bloc `"lint": { "a11y": false }` de mjs.config.json
// (validation stricte, même patron que lint.maxStateVars).
//
// RÈGLE ZÉRO : les zones <pre>/<code> (exemples de code d'une doc) sont
// neutralisées avant analyse — sinon un site qui MONTRE du HTML dans ses
// exemples reçoit des dizaines de fausses alertes.
//
// checkA11y() est testée directement (fonction pure) pour les 7 contrôles ;
// le câblage lint.a11y (défaut ON, false = coupe tout) est testé au niveau du
// transpiler (transpile() direct, harnais copié de tests/lint-max-state-vars.test.ts).

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { checkA11y } from '../src/transpiler/a11y.js'
import { transpile } from '../src/transpiler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'

// dernier message = rappel de désactivation (ajouté dès qu'il y a ≥1 alerte) — retiré pour ne compter que les VRAIES alertes
function realAlerts(msgs: string[]): string[] {
  return msgs.length ? msgs.slice(0, -1) : msgs
}

describe('checkA11y — contrôles unitaires (fonction pure)', () => {
  describe('1. image sans alternative textuelle', () => {
    it('POSITIF — <img> sans alt : alerte, cite le module et la bonne ligne', () => {
      const msgs = checkA11y('<div>\n  <img src="x.png">\n</div>', 'ma-carte')
      const alerts = realAlerts(msgs)
      assert.equal(alerts.length, 1)
      assert.match(alerts[0], /ma-carte/)
      assert.match(alerts[0], /ligne 2/)
      assert.match(alerts[0], /alt/)
    })

    it('NÉGATIF — alt="" (image décorative) : aucune alerte', () => {
      assert.deepEqual(checkA11y('<img src="x.png" alt="">', 'mod'), [])
    })

    it('NÉGATIF — alt={$legend} (valeur dynamique) : aucune alerte', () => {
      assert.deepEqual(checkA11y('<img src="x.png" alt={$legend}>', 'mod'), [])
    })
  })

  // `<@img>` est le module cœur qui écrit le `<img>` : il serait absurde qu'il
  // échappe au contrôle que la balise native subit
  describe('1bis. <@img> sans alt', () => {
    it('signale un <@img> sans alt', () => {
      const msgs = realAlerts(checkA11y('<@img src={$photo.src}></@img>', 'mod'))
      assert.equal(msgs.length, 1, JSON.stringify(msgs))
    })

    it('se tait quand le alt est là, sous quelque forme que ce soit', () => {
      assert.deepEqual(realAlerts(checkA11y('<@img src={$p.src} alt="Une photo"></@img>', 'mod')), [])
      assert.deepEqual(realAlerts(checkA11y('<@img src={$p.src} alt={$legende}></@img>', 'mod')), [])
      assert.deepEqual(realAlerts(checkA11y('<@img src={$p.src} alt=""></@img>', 'mod')), [])
    })
  })

  describe('2. <iframe> sans title', () => {
    it('POSITIF — sans title : alerte, cite la bonne ligne', () => {
      const msgs = checkA11y('<div>\n  <iframe src="https://ex.test"></iframe>\n</div>', 'incrust')
      const alerts = realAlerts(msgs)
      assert.equal(alerts.length, 1)
      assert.match(alerts[0], /ligne 2/)
      assert.match(alerts[0], /title/)
    })

    it('NÉGATIF — title présent : aucune alerte', () => {
      assert.deepEqual(checkA11y('<iframe src="https://ex.test" title="Vidéo de présentation"></iframe>', 'mod'), [])
    })
  })

  describe('3. tabindex positif', () => {
    it('POSITIF — tabindex="3" : alerte, cite la bonne ligne et la valeur', () => {
      const msgs = checkA11y('<div>\n  <span tabindex="3">x</span>\n</div>', 'liste')
      const alerts = realAlerts(msgs)
      assert.equal(alerts.length, 1)
      assert.match(alerts[0], /ligne 2/)
      assert.match(alerts[0], /tabindex="3"/)
    })

    it('NÉGATIF — tabindex="0" : aucune alerte', () => {
      assert.deepEqual(checkA11y('<div tabindex="0">x</div>', 'mod'), [])
    })

    it('NÉGATIF — tabindex="-1" : aucune alerte', () => {
      assert.deepEqual(checkA11y('<div tabindex="-1">x</div>', 'mod'), [])
    })
  })

  describe('4. @click sur un élément non interactif', () => {
    it('POSITIF — <li @click> sans role ni tabindex : alerte, cite le tag et la ligne', () => {
      const msgs = checkA11y('<ul>\n  <li @click={remove(i)}>x</li>\n</ul>', 'panier')
      const alerts = realAlerts(msgs)
      assert.equal(alerts.length, 1)
      assert.match(alerts[0], /ligne 2/)
      assert.match(alerts[0], /li/)
    })

    it('NÉGATIF — <div @click role="button" tabindex="0"> : aucune alerte', () => {
      assert.deepEqual(checkA11y('<div @click role="button" tabindex="0">x</div>', 'mod'), [])
    })
  })

  describe('5. <button> sans nom accessible', () => {
    it('POSITIF — bouton-icône (svg seul) : alerte', () => {
      const msgs = checkA11y('<div>\n  <button><svg></svg></button>\n</div>', 'toolbar')
      const alerts = realAlerts(msgs)
      assert.equal(alerts.length, 1)
      assert.match(alerts[0], /ligne 2/)
    })

    it('NÉGATIF — <button aria-label="Fermer"><svg></svg></button> : aucune alerte', () => {
      assert.deepEqual(checkA11y('<button aria-label="Fermer"><svg></svg></button>', 'mod'), [])
    })
  })

  describe('6. <a> sans nom accessible', () => {
    it('POSITIF — lien-icône (svg seul) : alerte', () => {
      // svg (pas img) : isole le contrôle 6, un <img> sans alt aurait AUSSI déclenché le contrôle 1 (comportement voulu, testé à part)
      const msgs = checkA11y('<div>\n  <a href="/x"><svg></svg></a>\n</div>', 'nav')
      const alerts = realAlerts(msgs)
      assert.equal(alerts.length, 1)
      assert.match(alerts[0], /ligne 2/)
    })

    it('un lien-icône avec <img> déclenche DEUX alertes indépendantes (contrôle 1 « img sans alt » + contrôle 6 « lien sans nom ») — comportement voulu', () => {
      const msgs = checkA11y('<a href="/x"><img src="icone.png"></a>', 'nav')
      const alerts = realAlerts(msgs)
      assert.equal(alerts.length, 2)
      assert.ok(alerts.some(m => m.includes('alt')))
      assert.ok(alerts.some(m => m.includes('<a>')))
    })

    it('NÉGATIF — <a aria-label="Fermer"><svg></svg></a> : aucune alerte', () => {
      assert.deepEqual(checkA11y('<a href="/x" aria-label="Fermer"><svg></svg></a>', 'mod'), [])
    })
  })

  describe('7. champ de saisie sans étiquette', () => {
    it('POSITIF (cas a) — id présent, aucun <label for="…"> correspondant : alerte (un AUTRE label ne sauve pas)', () => {
      const msgs = checkA11y('<div>\n  <label for="other">Autre</label>\n  <input id="search">\n</div>', 'recherche')
      const alerts = realAlerts(msgs)
      assert.equal(alerts.length, 1)
      assert.match(alerts[0], /ligne 3/)
      assert.match(alerts[0], /input/)
    })

    it('POSITIF (cas b) — pas d\'id, aucun <label> dans tout le gabarit : alerte', () => {
      const msgs = checkA11y('<div>\n  <input placeholder="Recherche">\n</div>', 'recherche')
      const alerts = realAlerts(msgs)
      assert.equal(alerts.length, 1)
      assert.match(alerts[0], /ligne 2/)
    })

    it('NÉGATIF — <input id="mail"> avec <label for="mail"> : aucune alerte', () => {
      const html = '<div>\n  <label for="mail">Email</label>\n  <input id="mail">\n</div>'
      assert.deepEqual(checkA11y(html, 'mod'), [])
    })

    it('NÉGATIF — <input> sans id dans un gabarit qui contient des <label> (probablement enveloppé) : aucune alerte', () => {
      const html = '<div>\n  <label for="other">Autre</label>\n  <input placeholder="Recherche">\n</div>'
      assert.deepEqual(checkA11y(html, 'mod'), [])
    })

    it('NÉGATIF — id DYNAMIQUE ({…}) : cas incertain, on se tait volontairement', () => {
      assert.deepEqual(checkA11y('<input id={$fieldId}>', 'mod'), [])
    })

    it('NÉGATIF — <input type="hidden"> sans étiquette : jamais concerné', () => {
      assert.deepEqual(checkA11y('<input type="hidden" name="csrf">', 'mod'), [])
    })
  })

  describe('RÈGLE ZÉRO — <pre>/<code> neutralisés avant analyse', () => {
    it('un <img> dans un <pre> et un <div @click> dans un <code> ne produisent AUCUNE alerte', () => {
      const html = [
        '<pre>',
        '  <img src="x">',
        '</pre>',
        '<code>',
        '  <div @click>y</div>',
        '</code>',
      ].join('\n')
      assert.deepEqual(checkA11y(html, 'doc-exemple'), [])
    })

    // MESURÉ sur le site de doc : 90 des 117 alertes du premier jet venaient d'ici.
    // `<a href="…"><code>&lt;@tag&gt;</code></a>` est l'idiome le plus fréquent de ces
    // pages ; masquer le `<code>` faisait passer un lien parfaitement nommé pour un
    // lien vide. Le texte d'un `<code>` EST le texte visible du lien.
    it('un lien dont le texte visible est un <code> a bien un nom accessible', () => {
      assert.deepEqual(realAlerts(checkA11y('<a href="/doc#/bal-view"><code>&lt;@view&gt;</code></a>', 'doc-page')), [])
      assert.deepEqual(realAlerts(checkA11y('<button><code>npx mjs dev</code></button>', 'doc-page')), [])
    })

    it('un lien réellement vide reste signalé, <code> ou pas', () => {
      assert.equal(realAlerts(checkA11y('<a href="/x"><svg viewBox="0 0 1 1"></svg></a>', 'mod')).length, 1)
    })

    // le `<pre>`, lui, reste masqué des DEUX côtés : c'est un vrai bloc d'exemple
    it('un lien vide écrit dans un <pre> ne produit aucune alerte', () => {
      assert.deepEqual(checkA11y('<pre>\n  <a href="/x"></a>\n</pre>', 'doc-exemple'), [])
    })
  })

  describe('rappel de désactivation', () => {
    it('ajouté UNE SEULE FOIS, en dernière position, quand il y a au moins une alerte', () => {
      const msgs = checkA11y('<div>\n  <img src="a.png">\n  <img src="b.png">\n</div>', 'mod')
      assert.equal(msgs.length, 3) // 2 alertes + 1 rappel
      assert.match(msgs[2], /lint.*a11y.*false/)
      assert.match(msgs[2], /mjs\.config\.json/)
    })

    it('absent quand il n\'y a aucune alerte', () => {
      assert.deepEqual(checkA11y('<p>Rien à signaler</p>', 'mod'), [])
    })
  })
})

// espionne console.warn le temps d'un transpile (motif lint-max-state-vars.test.ts)
async function warningsFor(src: string, moduleName: string, opts: Record<string, unknown> = {}): Promise<string[]> {
  const orig = console.warn
  const caught: string[] = []
  console.warn = (...a: unknown[]) => { caught.push(String(a[0])) }
  try { await transpile(src, { moduleName, ...opts }) } finally { console.warn = orig }
  return caught
}

describe('transpiler — câblage lint.a11y', function () {
  this.timeout(30000)

  it('défaut ON — sans AUCUNE clé lint, un gabarit fautif déclenche l\'alerte', async () => {
    const w = await warningsFor('<img src="x.png">', 'defaut-on')
    assert.ok(w.some(m => m.includes('sans attribut alt')), `avertissements capturés : ${JSON.stringify(w)}`)
  })

  it('lint.a11y: false coupe tout, même gabarit fautif (aucun avertissement, y compris le rappel)', async () => {
    const w = await warningsFor('<img src="x.png">', 'a11y-off', { a11y: false })
    assert.equal(w.length, 0, `aucun avertissement attendu : ${JSON.stringify(w)}`)
  })
})

describe('mjs.config.json — validation du bloc lint.a11y', () => {
  it('accepte { lint: { a11y: false } } et resolveBundlerOpts le transmet', () => {
    const root = mjsTmp('cfg-a11y')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ lint: { a11y: false } }))
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.lint!.a11y, false)
    const opts = resolveBundlerOpts(found!.config, root)
    assert.equal(opts.a11y, false)
  })

  it('throw sur lint.a11y non booléen, avec le bon message', () => {
    const root = mjsTmp('cfg-a11y')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ lint: { a11y: 'oui' } }))
    assert.throws(() => findConfig(root), /lint\.a11y doit être un booléen/)
  })
})
