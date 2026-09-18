// Tests — bloc de slot côté appel. Nom PROVISOIRE de la
// directive : FILL_DIRECTIVE = 'fill' (src/parser/index.ts) — `<@fill nom>…</@fill>` se déplie
// en SES enfants, chacun porteur de `slot="nom"` (même attribut que l'idiome natif posé à la
// main). Sucre de COMPILATION pur : aucun changement du générateur ni du runtime — cf.
// hoistFillBlocks (src/parser/index.ts).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { parse } from '../src/parser/index.js'
import { transpile } from '../src/transpiler/index.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// exécute fn, rend le message de l'erreur levée (échoue le test si rien n'est levé) — évite de
// répéter un try/catch dans chaque cas d'erreur ci-dessous
function catchMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (e: any) {
    return e.message
  }
  throw new Error('devrait avoir levé une erreur')
}

describe('parser — bloc de slot <@fill>', function () {

  describe('transpile — exemple carte/facture', () => {
    it('deux slot="actions", aucun @fill, aucun mjs-fill, <h3 slot="title"> inchangé', async () => {
      const src = [
        '<@card>',
        '  <h3 slot="title">Facture</h3>',
        '  Montant : 149 EUR',
        '  <@fill actions>',
        '    <button>Payer</button>',
        '    <button>Reporter</button>',
        '  </@fill>',
        '</@card>',
      ].join('\n')
      const r = await transpile(src, { moduleName: 'hote' })
      const matches = r.output.match(/slot=['"]actions['"]/g) ?? []
      assert.equal(matches.length, 2, `deux slot="actions" attendus (reçu : ${matches.length})`)
      assert.doesNotMatch(r.output, /@fill/, 'aucune trace de la directive dans la sortie')
      assert.doesNotMatch(r.output, /mjs-fill/, 'jamais résolu en composant mjs-fill')
      assert.match(r.output, /<h3[^>]*slot=['"]title['"][^>]*>/, '<h3 slot="title"> inchangé')
    })
  })

  describe('parse — traversée des blocs {if}/{for}, composant enfant', () => {
    it('{for} dans le bloc : le <tr> du template de boucle porte slot="rows"', () => {
      const html = '<@card><@fill rows>{for r in $rows}<tr><td>{r}</td></tr>{end}</@fill></@card>'
      const root = parse(html)
      const forNode = root.children[0].children[0]
      assert.equal(forNode.type, 'for')
      const tr = forNode.children[0]
      assert.equal(tr.name, 'tr')
      assert.equal(tr.attrs.find(a => a.name === 'slot')?.val, 'rows')
    })

    it('{if}/{else} dans le bloc : les deux branches stampées', () => {
      const html = '<@card><@fill actions>{if $x}<button>A</button>{else}<button>B</button>{end}</@fill></@card>'
      const root = parse(html)
      const ifNode = root.children[0].children[0]
      assert.equal(ifNode.type, 'if')
      assert.equal(ifNode.branches[0].children[0].attrs.find(a => a.name === 'slot')?.val, 'actions')
      assert.equal(ifNode.branches[1].children[0].attrs.find(a => a.name === 'slot')?.val, 'actions')
    })

    it('composant <@x> enfant du bloc : stampé', () => {
      const html = '<@card><@fill actions><@confirm-button/></@fill></@card>'
      const root = parse(html)
      const btn = root.children[0].children[0]
      assert.equal(btn.name, 'mjs-confirm-button')
      assert.equal(btn.attrs.find(a => a.name === 'slot')?.val, 'actions')
    })

    it('texte blanc entre les éléments : retiré, aucune erreur', () => {
      const html = '<@card><@fill actions>\n  <button>Payer</button>\n  <button>Reporter</button>\n</@fill></@card>'
      const root = parse(html)
      const card = root.children[0]
      assert.equal(card.children.length, 2, `texte blanc résiduel non retiré (reçu ${card.children.length} enfants)`)
      assert.ok(card.children.every(c => c.type === 'tag' && c.attrs.some(a => a.name === 'slot' && a.val === 'actions')))
    })

    it('commentaire HTML seul dans le bloc : retiré comme du blanc, pas refusé « texte nu »', () => {
      const html = '<@card><@fill x><!-- note --><button>A</button></@fill></@card>'
      const root = parse(html)
      const card = root.children[0]
      assert.equal(card.children.length, 1, `le commentaire doit être retiré (reçu ${card.children.length} enfants)`)
      assert.equal(card.children[0].name, 'button')
      assert.equal(card.children[0].attrs.find(a => a.name === 'slot')?.val, 'x')
    })
  })

  // un nom de slot homonyme d'un attribut
  // booléen HTML5 (`default`, `disabled`, `hidden`…) était réécrit en attribut dynamique par
  // parseAttrs AVANT d'atteindre expandFillBlock, qui refusait alors un nom pourtant littéral.
  describe('nom de slot homonyme d\'un attribut booléen HTML5', () => {
    for (const nom of ['default', 'disabled', 'hidden']) {
      it(`<@fill ${nom}> : compile, pose slot="${nom}" (pas rejeté "nom dynamique")`, () => {
        const html = `<@card><@fill ${nom}><button>A</button></@fill></@card>`
        const root = parse(html)
        const btn = root.children[0].children[0]
        assert.equal(btn.attrs.find(a => a.name === 'slot')?.val, nom)
      })
    }
  })

  // chaque cas met le fragment fautif sur la ligne 2 (un `<br>` occupe la ligne 1 — `parse()`
  // fait un `.trim()` de l'entrée, un simple `\n` de tête ne suffit pas) — évite tout comptage
  // manuel fragile tout en prouvant que `ligne` n'est ni 0 ni undefined
  describe('erreurs — chaque message porte la ligne et le mot du cas', () => {
    it('texte nu (mot "texte", ligne 2)', () => {
      const msg = catchMessage(() => parse('<br>\n<@card><@fill actions>Payer</@fill></@card>'))
      assert.match(msg, /texte/)
      assert.match(msg, /ligne 2/)
    })

    it('{expr} nu (mot "texte", ligne 2)', () => {
      const msg = catchMessage(() => parse('<br>\n<@card><@fill actions>{$label}</@fill></@card>'))
      assert.match(msg, /texte/)
      assert.match(msg, /ligne 2/)
    })

    it('enfant portant déjà slot= (mot "slot=", ligne 2)', () => {
      const msg = catchMessage(() => parse('<br>\n<@card><@fill actions><button slot="oops">x</button></@fill></@card>'))
      assert.match(msg, /slot=/)
      assert.match(msg, /ligne 2/)
    })

    it('bloc imbriqué (mot "imbriqué", ligne 2)', () => {
      const msg = catchMessage(() => parse('<br>\n<@card><@fill actions><@fill nested>x</@fill></@fill></@card>'))
      assert.match(msg, /imbriqué/)
      assert.match(msg, /ligne 2/)
    })

    it('<@fill> sans nom (mot "sans nom", ligne 2)', () => {
      const msg = catchMessage(() => parse('<br>\n<@card><@fill></@fill></@card>'))
      assert.match(msg, /sans nom/)
      assert.match(msg, /ligne 2/)
    })

    it('<@fill {$n}> nom dynamique (mot "dynamique", ligne 2)', () => {
      const msg = catchMessage(() => parse('<br>\n<@card><@fill {$n}></@fill></@card>'))
      assert.match(msg, /dynamique/)
      assert.match(msg, /ligne 2/)
    })

    // expandFillBlock ne lisait que attrs[0] : un nom surnuméraire (`<@fill x y>`)
    // ou un attribut de plus (`<@fill x class="foo">`) posait quand même slot="x" et perdait le
    // reste SANS UN MOT.
    it('<@fill x y> : un second nom en trop (mot "un seul nom", ligne 2, extrait "x y")', () => {
      const msg = catchMessage(() => parse('<br>\n<@card><@fill x y></@fill></@card>'))
      assert.match(msg, /un seul nom/)
      assert.match(msg, /ligne 2/)
      assert.match(msg, /x y/)
    })

    it('<@fill x class="foo"> : un attribut en trop (mot "un seul nom", ligne 2)', () => {
      const msg = catchMessage(() => parse('<br>\n<@card><@fill x class="foo"></@fill></@card>'))
      assert.match(msg, /un seul nom/)
      assert.match(msg, /ligne 2/)
    })
  })

  // `parseText` prenait la ligne AVANT de scanner le run de texte ; le run avale le
  // `\n` + l'indentation qui précèdent le texte visible → la ligne rapportée était celle D'AVANT
  // le retour à la ligne. La ligne d'un nœud texte = celle de son PREMIER caractère non blanc.
  describe('texte nu — la ligne rapportée est celle du premier caractère visible', () => {
    it('code indenté réel, <button> puis texte nu : ligne 5, pas ligne 4', () => {
      const html = [
        '<@card>',
        '  <h3 slot="title">Facture</h3>',
        '  <@fill actions>',
        '    <button>Payer</button>',
        '    Texte errone ici',
        '  </@fill>',
        '</@card>',
      ].join('\n')
      const msg = catchMessage(() => parse(html))
      assert.match(msg, /texte/)
      assert.match(msg, /ligne 5/)
    })

    it('un second texte nu, plus bas et entouré de lignes blanches : sa PROPRE ligne (ligne 6, pas 3 ni 5)', () => {
      const html = [
        '<@card>',
        '  <@fill actions>',
        '    <button>A</button>',
        '',
        '',
        '    Un autre texte errone',
        '  </@fill>',
        '</@card>',
      ].join('\n')
      const msg = catchMessage(() => parse(html))
      assert.match(msg, /texte/)
      assert.match(msg, /ligne 6/)
    })
  })
  describe('bundler — fichier projet fill.mjs refusé (garde nom réservé)', function () {
    this.timeout(40000)
    after(async () => { await terminateSharedWorkerPool() })

    it('fill.mjs (basename réservé) → erreur, comme head.mjs', async () => {
      const root = mjsTmp('fill-basename')
      const srcDir = join(root, 'src')
      const outDir = join(root, 'out')
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(join(srcDir, 'fill.mjs'), '<p>x</p>')
      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
      const stats = await bundler.compile()
      assert.ok(stats.errors.length > 0, 'le build doit échouer (fill.mjs = basename réservé)')
      const msg = stats.errors.map((e: any) => e.message).join('\n')
      assert.match(msg, /RÉSERVÉE/)
    })
  })

  describe('montage happy-dom — carte + appelant', function () {
    this.timeout(40000)
    after(async () => { await terminateSharedWorkerPool() })

    it('les deux boutons du light DOM portent slot="actions"', async () => {
      const root = mjsTmp('fill-mount')
      const srcDir = join(root, 'src')
      const outDir = join(root, 'out')
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(join(srcDir, 'card.mjs'), [
        '<article>',
        '  <header><@slot title>Sans titre</@slot></header>',
        '  <@slot/>',
        '  <footer><@slot actions/></footer>',
        '</article>',
      ].join('\n'))
      writeFileSync(join(srcDir, 'hote.mjs'), [
        '<@card>',
        '  <h3 slot="title">Facture</h3>',
        '  Montant : 149 EUR',
        '  <@fill actions>',
        '    <button>Payer</button>',
        '    <button>Reporter</button>',
        '  </@fill>',
        '</@card>',
      ].join('\n'))

      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

      const win: any = new Window({ url: 'http://localhost/' })
      const document: any = win.document
      const files = readdirSync(outDir)
      const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
      const cardFile = files.find((f: string) => /^card-/.test(f))
      const compFile = files.find((f: string) => /^hote-/.test(f))
      assert.ok(coreFile && cardFile && compFile, 'core + card + hote compilés')
      const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
      const cardCode = stripEsm(readFileSync(join(outDir, cardFile!), 'utf-8'))
      const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
      win.eval(`${coreCode}\nglobalThis.µ = µ;\n${cardCode}\n${compCode}`)

      document.body.innerHTML = '<mjs-hote></mjs-hote>'
      const el: any = document.body.firstElementChild
      await new Promise(r => setTimeout(r, 80))

      const cardEl = el._shadow.querySelector('mjs-card')
      assert.ok(cardEl, 'mjs-card doit exister dans le light DOM de hote')
      const buttons = cardEl.querySelectorAll('button')
      assert.equal(buttons.length, 2, `deux boutons attendus (reçu ${buttons.length})`)
      assert.equal(buttons[0].getAttribute('slot'), 'actions')
      assert.equal(buttons[1].getAttribute('slot'), 'actions')
      win.close?.()
    })
  })
})
