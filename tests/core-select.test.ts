// Test neuf — modules cœur select/option : COMPORTEMENT runtime en
// happy-dom, patron calqué sur tests/ujs-shadow-confirm.test.ts (bundler réel,
// core + chunks des composants chargés dans une vraie Window happy-dom,
// interaction via dispatchEvent, traversée du shadow fermé via `el._shadow`).
// Le gabarit hôte utilise <@select>/<@option> (raccourci résolu par le CŒUR,
// catalogue src/core-modules/ sans override — le projet n'a pas de select/option
// homonyme) — même mécanisme que core-select-build.test.ts, mais ici pour
// piloter des instances vivantes.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'

const HOST = `<script>
  $dynList = [{ code: 'a', label: 'Alpha' }, { code: 'b', label: 'Beta' }]
</script>

<div id="sel-basic">
  <@select name="basic" placeholder="Choisir un pays">
    <@option value="fr" icon="🇫🇷">France</@option>
    <@option value="de" icon="🇩🇪">Allemagne</@option>
    <@option value="us" icon="🇺🇸">États-Unis</@option>
  </@select>
</div>

<div id="sel-search">
  <@select name="search" search empty-label="Rien trouvé" search-placeholder="Cherchez…">
    <@option value="fr">France</@option>
    <@option value="de">Allemagne</@option>
    <@option value="us">États-Unis</@option>
  </@select>
</div>

<div id="sel-match-fuzzy">
  <@select name="mf" search match="fuzzy">
    <@option value="fr">France</@option>
    <@option value="be">Belgique</@option>
    <@option value="de">Allemagne</@option>
    <@option value="us">États-Unis</@option>
  </@select>
</div>

<div id="sel-match-starts">
  <@select name="ms" search match="starts">
    <@option value="fr">France</@option>
    <@option value="be">Belgique</@option>
    <@option value="de">Allemagne</@option>
    <@option value="us">États-Unis</@option>
  </@select>
</div>

<div id="sel-match-starts-fuzzy">
  <@select name="msf" search match="starts-fuzzy">
    <@option value="fr">France</@option>
    <@option value="be">Belgique</@option>
    <@option value="de">Allemagne</@option>
    <@option value="us">États-Unis</@option>
  </@select>
</div>

<div id="sel-multi">
  <@select name="multi" multiple>
    <@option value="fr">France</@option>
    <@option value="de">Allemagne</@option>
    <@option value="us">États-Unis</@option>
  </@select>
</div>

<div id="sel-multi-icons">
  <@select name="multi-icons" multiple>
    <@option value="fr">France</@option>
    <@option value="de">Allemagne</@option>
  </@select>
</div>

<div id="sel-multi-icons-custom">
  <@select name="multi-icons-custom" multiple icon-checked="☑" icon-unchecked="☐">
    <@option value="fr">France</@option>
    <@option value="de">Allemagne</@option>
  </@select>
</div>

<div id="sel-multi-icons-xss">
  <@select name="multi-icons-xss" multiple icon-checked="<b>x</b>">
    <@option value="fr">France</@option>
  </@select>
</div>

<div id="sel-default">
  <@select name="def"></@select>
</div>

<form id="sel-form">
  <@select name="pays">
    <@option value="fr">France</@option>
    <@option value="de">Allemagne</@option>
  </@select>
</form>

<div id="sel-dyn">
  <@select name="dyn">
    {for d in $dynList by code}
      <@option value={d.code}>{d.label}</@option>
    {end}
  </@select>
</div>

<div id="sel-geo">
  <@select name="geo" placeholder="Test géométrie">
    <@option value="a">Option A</@option>
  </@select>
</div>

<div id="sel-wrapped">
  <@select name="wrapped" placeholder="Choisir">
    <div class="opt-group">
      <@option value="fr">France</@option>
      <@option value="de">Allemagne</@option>
    </div>
  </@select>
</div>
`

describe('core-select/core-option — comportement runtime (happy-dom, bundler réel)', function () {
  this.timeout(60000)

  let window: any = null
  let document: any = null
  let hote: any = null
  let FIRST_BASIC_LABEL = ''

  function sel(id: string): any {
    return hote._shadow.querySelector(`#${id} mjs-select`)
  }
  function btn(id: string): any {
    return sel(id)._shadow.querySelector('.select-btn')
  }
  function wrapper(id: string): any {
    return sel(id)._shadow.querySelector('.select')
  }
  function options(id: string): any {
    return sel(id)._shadow.querySelectorAll('.select-option')
  }
  function click(el: any) {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))
  }
  function key(el: any, k: string) {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, composed: true }))
  }
  async function tick(ms = 30) {
    await new Promise((r) => setTimeout(r, ms))
  }

  before(async function () {
    const root = mjsTmp('core-select-behavior')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hote.mjs'), HOST)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    window = new Window({ url: 'http://localhost/' })
    document = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const selFile  = files.find((f: string) => /^select-/.test(f))
    const optFile  = files.find((f: string) => /^option-/.test(f))
    const hoteFile = files.find((f: string) => /^hote-/.test(f))
    assert.ok(coreFile && selFile && optFile && hoteFile, 'core + select + option + hote compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const code = [coreFile, selFile, optFile, hoteFile].map((f: string) => stripEsm(readFileSync(join(outDir, f!), 'utf-8'))).join('\n')
    window.eval(`${code}\nglobalThis.µ = µ;`)

    document.body.innerHTML = '<mjs-hote></mjs-hote>'
    await new Promise((r) => setTimeout(r, 80))
    hote = document.body.firstElementChild
    assert.ok(hote._shadow, 'hôte monté')
    FIRST_BASIC_LABEL = btn('sel-basic').textContent
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  describe('ouverture / fermeture', () => {
    it('fermé au départ : aria-expanded="false" (présent, pas absent), placeholder affiché', () => {
      assert.equal(btn('sel-basic').getAttribute('aria-expanded'), 'false')
      assert.match(btn('sel-basic').textContent, /Choisir un pays/)
    })

    it('clic sur le bouton : ouvre le panneau, aria-expanded="true", 3 options rendues', async () => {
      click(btn('sel-basic'))
      await tick()
      assert.equal(btn('sel-basic').getAttribute('aria-expanded'), 'true')
      assert.ok(sel('sel-basic')._shadow.querySelector('.select-panel'))
      assert.equal(options('sel-basic').length, 3)
    })

    it('re-clic sur le bouton : referme le panneau', async () => {
      click(btn('sel-basic'))
      await tick()
      assert.equal(btn('sel-basic').getAttribute('aria-expanded'), 'false')
      assertAbsent(sel('sel-basic')._shadow.querySelector('.select-panel'))
    })

    it('clic en dehors : referme le panneau ouvert', async () => {
      click(btn('sel-basic'))
      await tick()
      assert.equal(sel('sel-basic')._state.open, true)
      click(document.body)
      await tick()
      assert.equal(sel('sel-basic')._state.open, false)
    })

    it('Escape referme le panneau', async () => {
      click(btn('sel-basic'))
      await tick()
      assert.equal(sel('sel-basic')._state.open, true)
      key(wrapper('sel-basic'), 'Escape')
      await tick()
      assert.equal(sel('sel-basic')._state.open, false)
    })
  })

  // Géométrie du panneau : `updatePlacement()` bornait déjà le côté (haut/bas) via
  // `$panelUp`, mais le `max-height` restait un `280px` statique même côté haut, dans un
  // conteneur plus court → le sommet du panneau (donc le champ de recherche, 1er enfant)
  // sortait de l'écran, structurellement inatteignable au scroll. `getBoundingClientRect`
  // est mocké sur le bouton (happy-dom la retourne à zéro par défaut) pour simuler l'espace
  // RÉELLEMENT disponible ; `window.innerHeight` vaut 768 par défaut en happy-dom.
  describe('placement dynamique du panneau (--mjs-select-panel-max)', () => {
    // isolation : si une assertion échoue en cours de test, le clic de fermeture en fin de
    // bloc n'est jamais atteint — sans ce filet, le panneau resterait ouvert et fausserait
    // (par cascade) le test suivant (ouverture ratée = fermeture, pas ouverture).
    afterEach(async () => {
      if (sel('sel-geo')._state.open) { click(btn('sel-geo')); await tick() }
    })

    it('espace généreux sous le bouton : panneau vers le bas, --mjs-select-panel-max au plafond 280px', async () => {
      btn('sel-geo').getBoundingClientRect = () => ({ top: 400, bottom: 420, left: 0, right: 0, width: 0, height: 20, x: 0, y: 400 })
      click(btn('sel-geo'))
      await tick()
      const panel = sel('sel-geo')._shadow.querySelector('.select-panel')
      assert.equal(panel.classList.contains('up'), false, 'assez de place en dessous (348px) : pas de bascule up')
      assert.equal(panel.style.getPropertyValue('--mjs-select-panel-max'), '280px')
      click(btn('sel-geo'))
      await tick()
    })

    it('espace au-dessus moyen (150px) : bascule up, hauteur clampée à 138px (150 − marge 12)', async () => {
      btn('sel-geo').getBoundingClientRect = () => ({ top: 150, bottom: 768, left: 0, right: 0, width: 0, height: 0, x: 0, y: 150 })
      click(btn('sel-geo'))
      await tick()
      const panel = sel('sel-geo')._shadow.querySelector('.select-panel')
      assert.equal(panel.classList.contains('up'), true, 'aucune place en dessous (bottom=768=innerHeight) : bascule up')
      assert.equal(panel.style.getPropertyValue('--mjs-select-panel-max'), '138px')
      click(btn('sel-geo'))
      await tick()
    })

    // Le plancher de 96px est RETIRÉ : il produisait exactement le défaut qu'il
    // prétendait éviter. Mesuré en navigateur réel sur le site (fenêtre 900px, aperçu du
    // tuto à 112px) : panneau ouvert vers le haut, sommet à −25px, hors écran et hors
    // portée de tout défilement. La place disponible fait désormais TOUJOURS loi — deux
    // options visibles avec défilement interne valent mieux qu'un sommet inatteignable.
    it('espace au-dessus très réduit (50px) : 38px (50 − marge 12), le plancher de 96px ne déborde plus', async () => {
      btn('sel-geo').getBoundingClientRect = () => ({ top: 50, bottom: 768, left: 0, right: 0, width: 0, height: 0, x: 0, y: 50 })
      click(btn('sel-geo'))
      await tick()
      const panel = sel('sel-geo')._shadow.querySelector('.select-panel')
      assert.equal(panel.classList.contains('up'), true)
      assert.equal(panel.style.getPropertyValue('--mjs-select-panel-max'), '38px', 'la place disponible fait loi, PAS le plancher 96px qui débordait de 46px')
      click(btn('sel-geo'))
      await tick()
    })

    it('espace quasi nul des deux côtés : reste en bas (le moins pire des deux), 0px plutôt qu\'un débordement', async () => {
      btn('sel-geo').getBoundingClientRect = () => ({ top: 5, bottom: 760, left: 0, right: 0, width: 0, height: 755, x: 0, y: 5 })
      click(btn('sel-geo'))
      await tick()
      const panel = sel('sel-geo')._shadow.querySelector('.select-panel')
      assert.equal(panel.classList.contains('up'), false, 'en dessous (8px) < au-dessus (5px) ? non : 5 < 8 → reste en bas')
      assert.equal(panel.style.getPropertyValue('--mjs-select-panel-max'), '0px', 'available négatif (8−12=−4) : ramené à 0, jamais une valeur négative ni un plancher qui dépasse')
      click(btn('sel-geo'))
      await tick()
    })

    // INVARIANT — c'est LA propriété qui compte, testée sur tout le spectre plutôt que
    // sur trois points choisis : quelle que soit la géométrie, la hauteur maximale posée
    // ne dépasse JAMAIS la place réellement disponible du côté retenu.
    it('invariant : sur 12 géométries, la hauteur posée ne dépasse jamais la place disponible', async () => {
      for (const [top, bottom] of [[0, 10], [5, 760], [50, 768], [90, 768], [110, 768], [150, 768], [200, 400], [300, 320], [400, 420], [600, 620], [700, 720], [760, 768]]) {
        btn('sel-geo').getBoundingClientRect = () => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top })
        click(btn('sel-geo'))
        await tick()
        const panel = sel('sel-geo')._shadow.querySelector('.select-panel')
        const up = panel.classList.contains('up')
        // au-dessus, la place VISIBLE est bornée par la fenêtre : un bouton dont le haut
        // est plus bas que la fenêtre n'a pas « top » pixels utilisables au-dessus de lui
        const dispo = up ? Math.min(top, window.innerHeight) : window.innerHeight - bottom
        const pose = parseFloat(panel.style.getPropertyValue('--mjs-select-panel-max'))
        assert.ok(pose <= Math.max(dispo, 0), `top=${top} bottom=${bottom} (${up ? 'haut' : 'bas'}) : ${pose}px posés pour ${dispo}px disponibles`)
        assert.ok(pose <= 280, `top=${top} bottom=${bottom} : le plafond de 280px tient (${pose}px)`)
        click(btn('sel-geo'))
        await tick()
      }
    })

    // Le calcul n'avait lieu QU'À L'OUVERTURE : une fenêtre qui
    // rétrécit pendant que le panneau est ouvert (clavier virtuel mobile, typiquement) laissait
    // une hauteur périmée, débordement de 221px MESURÉ en navigateur réel. `<@window @resize>`
    // rejoue `updatePlacement()` tant que le panneau est ouvert
    it('fenêtre redimensionnée PENDANT que le panneau est ouvert : la hauteur est recalculée', async () => {
      btn('sel-geo').getBoundingClientRect = () => ({ top: 400, bottom: 420, left: 0, right: 0, width: 0, height: 20, x: 0, y: 400 })
      click(btn('sel-geo'))
      await tick()
      const panel = sel('sel-geo')._shadow.querySelector('.select-panel')
      assert.equal(panel.style.getPropertyValue('--mjs-select-panel-max'), '280px', 'à l\'ouverture : 768 − 420 = 348 → plafond')

      btn('sel-geo').getBoundingClientRect = () => ({ top: 150, bottom: 170, left: 0, right: 0, width: 0, height: 20, x: 0, y: 150 })
      Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true })
      window.dispatchEvent(new window.Event('resize'))
      await tick()
      assert.equal(panel.classList.contains('up'), true, 'après resize : 130px sous le bouton contre 150px au-dessus → bascule up')
      assert.equal(panel.style.getPropertyValue('--mjs-select-panel-max'), '138px', 'après resize : 150 au-dessus moins la marge 12 → 138px, PAS les 280px périmés')

      Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
      click(btn('sel-geo'))
      await tick()
    })
  })

  describe('sélection simple', () => {
    it('clic sur une option : pose $value, ferme le panneau, met à jour le libellé du bouton', async () => {
      click(btn('sel-basic'))
      await tick()
      click(options('sel-basic')[1])
      await tick()
      assert.equal(sel('sel-basic')._state.value, 'de')
      assert.equal(sel('sel-basic')._state.open, false)
      assert.match(btn('sel-basic').textContent.trim(), /Allemagne/)
      assert.doesNotMatch(btn('sel-basic').textContent, /,\s*$/, 'aucune virgule parasite en mode simple')
    })

    it('un hidden input name=basic value=de est posé dans le LIGHT DOM de l\'hôte (participation formulaire)', () => {
      const hidden = sel('sel-basic').querySelectorAll('input[type="hidden"]')
      assert.equal(hidden.length, 1)
      assert.equal(hidden[0].name, 'basic')
      assert.equal(hidden[0].value, 'de')
    })

    it('émet mjs-bind:value (e.data) quand le composant est marqué two-way par un parent (_mjs_binds)', async () => {
      const node = sel('sel-basic')
      node._mjs_binds = new Set(['value'])
      const received: any[] = []
      node.addEventListener('mjs-bind:value', (e: any) => received.push(e.data))
      click(btn('sel-basic'))
      await tick()
      click(options('sel-basic')[0])
      await tick()
      assert.deepEqual(received, ['fr'])
      node._mjs_binds = new Set()
    })

    it('réouverture : l\'option actuellement sélectionnée porte la classe active et aria-selected="true"', async () => {
      click(btn('sel-basic'))
      await tick()
      const rows = options('sel-basic')
      const current = Array.from(rows).find((r: any) => r.classList.contains('active')) as any
      assert.ok(current, 'une ligne doit être active à la réouverture')
      assert.match(current.textContent, /France/)
      assert.equal(current.getAttribute('aria-selected'), 'true')
      assert.equal(rows[1].getAttribute('aria-selected'), 'false', 'les lignes non sélectionnées portent aria-selected="false" (pas d\'absence)')
      key(wrapper('sel-basic'), 'Escape')
      await tick()
    })
  })

  describe('sélection multiple', () => {
    it('multiple : cocher 2 options garde le panneau ouvert, $value devient un tableau', async () => {
      click(btn('sel-multi'))
      await tick()
      const rows = options('sel-multi')
      click(rows[0])
      await tick()
      click(rows[2])
      await tick()
      assert.equal(sel('sel-multi')._state.open, true, 'le panneau reste ouvert en mode multiple')
      assert.deepEqual(Array.from(sel('sel-multi')._state.value), ['fr', 'us'])
    })

    it('le libellé du bouton joint les libellés sélectionnés par ", " sans virgule finale', () => {
      assert.equal(btn('sel-multi').textContent.trim(), 'France, États-Unis')
    })

    it('un hidden input PAR VALEUR, même name="multi"', () => {
      const hidden = sel('sel-multi').querySelectorAll('input[type="hidden"]')
      assert.equal(hidden.length, 2)
      assert.deepEqual(Array.from(hidden).map((h: any) => h.name), ['multi', 'multi'])
      assert.deepEqual(Array.from(hidden).map((h: any) => h.value), ['fr', 'us'])
    })

    it('re-cliquer une option cochée la retire de la sélection', async () => {
      const rows = options('sel-multi')
      click(rows[0])
      await tick()
      assert.deepEqual(Array.from(sel('sel-multi')._state.value), ['us'])
      key(wrapper('sel-multi'), 'Escape')
      await tick()
    })
  })

  // icon-checked / icon-unchecked (mode multiple) : icônes de coche personnalisables, texte échappé
  describe('icônes de coche (icon-checked / icon-unchecked, mode multiple)', () => {
    it('défaut inchangé : une option cochée affiche ✔, une non cochée n\'affiche rien', async () => {
      click(btn('sel-multi-icons'))
      await tick()
      click(options('sel-multi-icons')[0])
      await tick()
      const checks = sel('sel-multi-icons')._shadow.querySelectorAll('.select-panel .select-check')
      assert.equal(checks[0].textContent, '✔')
      assert.equal(checks[1].textContent, '')
      key(wrapper('sel-multi-icons'), 'Escape')
      await tick()
    })

    it('icon-checked="☑" icon-unchecked="☐" : les deux caractères apparaissent au bon endroit', async () => {
      click(btn('sel-multi-icons-custom'))
      await tick()
      click(options('sel-multi-icons-custom')[0])
      await tick()
      const checks = sel('sel-multi-icons-custom')._shadow.querySelectorAll('.select-panel .select-check')
      assert.equal(checks[0].textContent, '☑')
      assert.equal(checks[1].textContent, '☐')
      key(wrapper('sel-multi-icons-custom'), 'Escape')
      await tick()
    })

    it('icon-checked="<b>x</b>" est échappé : texte littéral affiché, aucun élément <b> dans le DOM', async () => {
      click(btn('sel-multi-icons-xss'))
      await tick()
      click(options('sel-multi-icons-xss')[0])
      await tick()
      const check = sel('sel-multi-icons-xss')._shadow.querySelector('.select-panel .select-check')
      assert.equal(check.textContent, '<b>x</b>')
      assertAbsent(sel('sel-multi-icons-xss')._shadow.querySelector('.select-panel b'))
      key(wrapper('sel-multi-icons-xss'), 'Escape')
      await tick()
    })
  })

  describe('recherche', () => {
    it('search opt-in : le champ de recherche est rendu à l\'ouverture, avec le placeholder surchargé', async () => {
      click(btn('sel-search'))
      await tick()
      const input = sel('sel-search')._shadow.querySelector('.select-search')
      assert.ok(input)
      assert.equal(input.getAttribute('placeholder'), 'Cherchez…')
    })

    it('filtre insensible à la casse et aux accents', async () => {
      const input = sel('sel-search')._shadow.querySelector('.select-search')
      input.value = 'ALLEMA'
      input.dispatchEvent(new window.Event('input', { bubbles: true, cancelable: true, composed: true }))
      await tick()
      const rows = options('sel-search')
      assert.equal(rows.length, 1)
      assert.match(rows[0].textContent, /Allemagne/)
    })

    it('empty-label surchargé affiché quand rien ne correspond', async () => {
      const input = sel('sel-search')._shadow.querySelector('.select-search')
      input.value = 'zzzzz'
      input.dispatchEvent(new window.Event('input', { bubbles: true, cancelable: true, composed: true }))
      await tick()
      const empty = sel('sel-search')._shadow.querySelector('.select-empty')
      assert.ok(empty)
      assert.equal(empty.textContent, 'Rien trouvé')
    })

    it('la recherche est réinitialisée à la fermeture puis réouverture (les 3 options reviennent)', async () => {
      key(wrapper('sel-search'), 'Escape')
      await tick()
      click(btn('sel-search'))
      await tick()
      assert.equal(options('sel-search').length, 3)
    })
  })

  // les quatre modes de `match` — chaque cas vérifie ce qui PASSE et ce qui est REFUSÉ, sinon un
  // mode qui laisserait tout passer (ou rien) rendrait le même vert qu'un mode juste
  describe('modes de recherche (match)', () => {
    async function labelsFor(id: string, query: string): Promise<string[]> {
      if (btn(id).getAttribute('aria-expanded') !== 'true') {
        click(btn(id))
        await tick()
      }
      const input = sel(id)._shadow.querySelector('.select-search')
      input.value = query
      input.dispatchEvent(new window.Event('input', { bubbles: true, cancelable: true, composed: true }))
      await tick()
      return Array.from(options(id)).map((o: any) => o.textContent.trim())
    }

    it('contains (défaut) : les lettres collées et dans l\'ordre, n\'importe où — « lema » trouve Allemagne, « lgq » ne trouve rien', async () => {
      assert.deepEqual(await labelsFor('sel-search', 'lema'), ['Allemagne'])
      assert.deepEqual(await labelsFor('sel-search', 'lgq'), [])
      key(wrapper('sel-search'), 'Escape')
      await tick()
    })

    it('fuzzy : chaque lettre dans l\'ordre, trous permis — « bgq » et « lgq » trouvent Belgique, « eqb » (ordre faux) ne trouve rien', async () => {
      assert.deepEqual(await labelsFor('sel-match-fuzzy', 'bgq'), ['Belgique'])
      assert.deepEqual(await labelsFor('sel-match-fuzzy', 'lgq'), ['Belgique'])
      assert.deepEqual(await labelsFor('sel-match-fuzzy', 'eqb'), [])
      assert.deepEqual(await labelsFor('sel-match-fuzzy', 'ÉTA'), ['États-Unis'])
      key(wrapper('sel-match-fuzzy'), 'Escape')
      await tick()
    })

    it('starts : l\'étiquette commence par ce qui est tapé — « bel » trouve Belgique, « elg » ne trouve rien', async () => {
      assert.deepEqual(await labelsFor('sel-match-starts', 'bel'), ['Belgique'])
      assert.deepEqual(await labelsFor('sel-match-starts', 'elg'), [])
      assert.deepEqual(await labelsFor('sel-match-starts', 'etats'), ['États-Unis'])
      key(wrapper('sel-match-starts'), 'Escape')
      await tick()
    })

    it('starts-fuzzy : première lettre ancrée, le reste souple — « bgq » trouve Belgique, « gq » ne trouve rien, « aln » trouve Allemagne', async () => {
      assert.deepEqual(await labelsFor('sel-match-starts-fuzzy', 'bgq'), ['Belgique'])
      assert.deepEqual(await labelsFor('sel-match-starts-fuzzy', 'gq'), [])
      assert.deepEqual(await labelsFor('sel-match-starts-fuzzy', 'aln'), ['Allemagne'])
      assert.deepEqual(await labelsFor('sel-match-starts-fuzzy', 'f'), ['France'])
      key(wrapper('sel-match-starts-fuzzy'), 'Escape')
      await tick()
    })
  })

  describe('clavier', () => {
    it('sur le bouton fermé : ArrowDown ouvre le panneau', async () => {
      key(wrapper('sel-basic'), 'Escape')
      await tick()
      assert.equal(sel('sel-basic')._state.open, false)
      key(wrapper('sel-basic'), 'ArrowDown')
      await tick()
      assert.equal(sel('sel-basic')._state.open, true)
    })

    it('ArrowDown/ArrowUp déplacent la ligne active', async () => {
      key(wrapper('sel-basic'), 'Home')
      await tick()
      assert.match(sel('sel-basic')._shadow.querySelector('.select-option.active').textContent, /France/)
      key(wrapper('sel-basic'), 'ArrowDown')
      await tick()
      assert.match(sel('sel-basic')._shadow.querySelector('.select-option.active').textContent, /Allemagne/)
      key(wrapper('sel-basic'), 'ArrowUp')
      await tick()
      assert.match(sel('sel-basic')._shadow.querySelector('.select-option.active').textContent, /France/)
    })

    it('End va à la dernière option, Home à la première', async () => {
      key(wrapper('sel-basic'), 'End')
      await tick()
      assert.match(sel('sel-basic')._shadow.querySelector('.select-option.active').textContent, /États-Unis/)
      key(wrapper('sel-basic'), 'Home')
      await tick()
      assert.match(sel('sel-basic')._shadow.querySelector('.select-option.active').textContent, /France/)
    })

    it('Enter sélectionne la ligne active et ferme le panneau', async () => {
      key(wrapper('sel-basic'), 'Enter')
      await tick()
      assert.equal(sel('sel-basic')._state.value, 'fr')
      assert.equal(sel('sel-basic')._state.open, false)
    })
  })

  describe('ARIA', () => {
    it('bouton : role=combobox, aria-haspopup=listbox, aria-controls pointe le panneau', async () => {
      const b = btn('sel-default')
      assert.equal(b.getAttribute('role'), 'combobox')
      assert.equal(b.getAttribute('aria-haspopup'), 'listbox')
      click(b)
      await tick()
      const panel = sel('sel-default')._shadow.querySelector('.select-panel')
      assert.equal(b.getAttribute('aria-controls'), panel.id)
      key(wrapper('sel-default'), 'Escape')
      await tick()
    })

    it('panneau : role=listbox ; lignes : role=option', async () => {
      click(btn('sel-basic'))
      await tick()
      assert.equal(sel('sel-basic')._shadow.querySelector('.select-panel').getAttribute('role'), 'listbox')
      for (const row of Array.from(options('sel-basic')) as any[]) assert.equal(row.getAttribute('role'), 'option')
      key(wrapper('sel-basic'), 'Escape')
      await tick()
    })

    it('multiple : le panneau porte aria-multiselectable="true" ; simple : "false"', async () => {
      click(btn('sel-multi'))
      await tick()
      assert.equal(sel('sel-multi')._shadow.querySelector('.select-panel').getAttribute('aria-multiselectable'), 'true')
      key(wrapper('sel-multi'), 'Escape')
      await tick()

      click(btn('sel-basic'))
      await tick()
      assert.equal(sel('sel-basic')._shadow.querySelector('.select-panel').getAttribute('aria-multiselectable'), 'false')
      key(wrapper('sel-basic'), 'Escape')
      await tick()
    })
  })

  describe('libellés par défaut (français, surchargables)', () => {
    it('placeholder par défaut = « Choisir… » quand non fourni (sel-default, jamais surchargé, jamais sélectionné)', () => {
      assert.match(btn('sel-default').textContent, /Choisir…/)
    })

    it('placeholder surchargé via attribut (sel-basic AVANT toute sélection, capturé au tout premier test du fichier)', () => {
      assert.match(FIRST_BASIC_LABEL, /Choisir un pays/)
    })

    it('search-placeholder par défaut = « Rechercher… » (composant search sans surcharge, monté et interrogé à l\'exécution)', async () => {
      const HOST2 = '<@select name="s2" search></@select>'
      const root = mjsTmp('core-select-default-labels')
      const srcDir = join(root, 'src')
      const outDir = join(root, 'out')
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(join(srcDir, 'hote2.mjs'), HOST2)
      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

      const win2 = new Window({ url: 'http://localhost/' })
      const doc2 = win2.document
      const files2 = readdirSync(outDir)
      const stripEsm = (s: string) => s
        .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
        .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
        .replace(/\bexport\s+default\s+/g, '')
        .replace(/\bexport\s+/g, '')
        .replace(/import\.meta\.url/g, "'http://localhost/'")
      const code2 = ['mjs_core-', 'select-', 'option-', 'hote2-']
        .map((prefix) => files2.find((f: string) => f.startsWith(prefix)))
        .filter((f): f is string => !!f)
        .map((f: string) => stripEsm(readFileSync(join(outDir, f), 'utf-8')))
        .join('\n')
      win2.eval(`${code2}\nglobalThis.µ = µ;`)
      doc2.body.innerHTML = '<mjs-hote2></mjs-hote2>'
      await new Promise((r) => setTimeout(r, 80))
      const hote2 = doc2.body.firstElementChild
      const sel2 = hote2._shadow.querySelector('mjs-select')
      sel2._shadow.querySelector('.select-btn').dispatchEvent(new win2.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))
      await new Promise((r) => setTimeout(r, 30))
      const input2 = sel2._shadow.querySelector('.select-search')
      assert.ok(input2, 'le champ de recherche doit être rendu (search opt-in)')
      assert.equal(input2.getAttribute('placeholder'), 'Rechercher…')
      win2.close?.()
    })
  })

  describe('formulaire réel', () => {
    it('new FormData(form) porte la valeur sélectionnée sous la clé name', async () => {
      const form = hote._shadow.querySelector('#sel-form form') ?? hote._shadow.querySelector('form')
      const formSel = hote._shadow.querySelector('#sel-form mjs-select')
      click(formSel._shadow.querySelector('.select-btn'))
      await tick()
      click(formSel._shadow.querySelectorAll('.select-option')[1])
      await tick()
      const fd = new window.FormData(form)
      assert.equal(fd.get('pays'), 'de')
    })
  })

  describe('réactivité des options ({for} réactif côté hôte)', () => {
    it('ajouter un item à $dynList fait apparaître une option de plus au prochain scan (slotchange)', async () => {
      click(btn('sel-dyn'))
      await tick()
      assert.equal(options('sel-dyn').length, 2)
      key(wrapper('sel-dyn'), 'Escape')
      await tick()

      hote._state.dynList.push({ code: 'c', label: 'Gamma' })
      await tick(120)

      click(btn('sel-dyn'))
      await tick()
      assert.equal(options('sel-dyn').length, 3)
      assert.match(sel('sel-dyn')._shadow.querySelector('.select-panel').textContent, /Gamma/)
      key(wrapper('sel-dyn'), 'Escape')
      await tick()
    })
  })

  // DÉFAUT — `$activeIndex` était calé sur la liste NON filtrée à l'ouverture et rien ne le
  // recalculait quand `$query` réduisait `$filtered`. Une ligne active en position 2, une recherche
  // qui ne laisse qu'un résultat, Entrée → `$filtered[2]` vaut `undefined`, RIEN ne se sélectionne.
  // Le clic, lui, marche : panne d'accessibilité clavier, parfaitement muette.
  describe('recherche au clavier — l\'index actif suit la liste FILTRÉE', () => {
    async function ouvrirEtChercher(q: string) {
      key(wrapper('sel-search'), 'Escape')
      await tick()
      click(btn('sel-search'))
      await tick()
      key(wrapper('sel-search'), 'ArrowDown')          // 0 → 1
      key(wrapper('sel-search'), 'ArrowDown')          // 1 → 2 (États-Unis)
      await tick()
      const input = sel('sel-search')._shadow.querySelector('.select-search')
      input.value = q
      input.dispatchEvent(new window.Event('input', { bubbles: true, cancelable: true, composed: true }))
      await tick()
    }

    it('après filtrage, la ligne active est DANS la liste affichée', async () => {
      await ouvrirEtChercher('Allema')
      assert.equal(options('sel-search').length, 1)
      assert.equal(sel('sel-search')._shadow.querySelectorAll('.select-option.active').length, 1,
        'AVANT : l\'index pointait hors de la liste filtrée, plus aucune ligne active')
    })

    it('Entrée sélectionne bien le seul résultat de la recherche', async () => {
      await ouvrirEtChercher('Allema')
      key(wrapper('sel-search'), 'Enter')
      await tick()
      assert.match(btn('sel-search').textContent, /Allemagne/,
        'AVANT : Entrée ne sélectionnait RIEN (le clic, lui, marchait)')
    })

    it('effacer la recherche ne laisse pas un index hors bornes', async () => {
      await ouvrirEtChercher('Allema')
      const input = sel('sel-search')._shadow.querySelector('.select-search')
      input.value = ''
      input.dispatchEvent(new window.Event('input', { bubbles: true, cancelable: true, composed: true }))
      await tick()
      assert.equal(options('sel-search').length, 3)
      assert.equal(sel('sel-search')._shadow.querySelectorAll('.select-option.active').length, 1)
      key(wrapper('sel-search'), 'Escape')
      await tick()
    })
  })

  describe('options nichées dans un wrapper intermédiaire (pas enfants directs du <slot>)', () => {
    it('un <div> entre <@select> et les <@option> : les options sont quand même détectées (descendants du slot assigné, pas seulement enfants directs)', async () => {
      click(btn('sel-wrapped'))
      await tick()
      assert.equal(options('sel-wrapped').length, 2, 'les <@option> nichées dans le <div class="opt-group"> doivent être rendues')
      assert.match(sel('sel-wrapped')._shadow.querySelector('.select-panel').textContent, /France/)
      assert.match(sel('sel-wrapped')._shadow.querySelector('.select-panel').textContent, /Allemagne/)
      key(wrapper('sel-wrapped'), 'Escape')
      await tick()
    })
  })

})
