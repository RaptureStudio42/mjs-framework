// Un `<script>` présent dans le contenu ÉCHANGÉ (swap UJS) ne s'exécute
// JAMAIS : règle du DOM (un <script> inséré par innerHTML/appendChild n'est jamais ré-évalué), pas
// un bug MJS. µ._mjs_navWarnScripts(nodes), appelée sur `newNodes` AVANT le swap aux 3 sites HTML
// (clic/popstate/submit), avertit UNE FOIS par signature distincte — ce fichier couvre :
//   - un <script> exécutable (type absent/vide, text/javascript, module…) → 1 avertissement
//   - un <script type="application/json"> (et assimilés : importmap, text/template) → 0
//   - un <script src="…"> dont l'URL RÉSOLUE est déjà chargée dans la page courante → 0 (le bundle
//     de l'app relayé par le gabarit ne doit pas bruiter à CHAQUE navigation)
//   - 2 navigations portant le MÊME script → toujours 1 seul avertissement (dédoublonné par signature)
//   - jamais de throw, même sur un contenu échangé exotique (enveloppe try/catch de la fonction)
//   - câblage réel : le chemin clic cross-page appelle bien µ._mjs_navWarnScripts sur newNodes AVANT le swap
//
// Méthode : extraction du bloc helpers (µ._mjs_navMountZone → µ._mjs_navRequest) — même
// technique que les fichiers voisins.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, document, window)
}
function extractClickBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnClick')
}

// Nœud FAKE minimal, élément OU <script>. `querySelectorAll('script')` : walk récursif MINIATURE
// (mêmes sélecteurs que ceux réellement émis par µ._mjs_navWarnScripts : juste 'script').
function makeEl(tag: string, attrs: Record<string, string> = {}, opts: { src?: string, text?: string } = {}): any {
  const el: any = {
    tagName: tag.toUpperCase(), nodeType: 1, children: [] as any[],
    src: opts.src || '', textContent: opts.text || '',
    getAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null },
    appendChild(c: any) { el.children.push(c); return c },
    querySelectorAll(sel: string) {
      const out: any[] = []
      const walk = (n: any) => { for (const c of n.children) { if (c.tagName === sel.toUpperCase()) { out.push(c) } walk(c) } }
      walk(el)
      return out
    },
  }
  return el
}
function makeDoc(loadedSrcEls: any[] = []) {
  return { querySelectorAll: (sel: string) => (sel === 'script[src]' ? loadedSrcEls : []) }
}
function baseMu(overrides: any = {}) {
  return Object.assign({ warn() {}, error() {}, log() {} }, overrides)
}

describe('mjs_ujs — µ._mjs_navWarnScripts : détection <script> dans le contenu échangé', function () {
  it('<script> exécutable (type absent) contenant du code inline → 1 avertissement, signature = extrait du texte', function () {
    const warnCalls: any[] = []
    const µ: any = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
    installHelpers(µ, makeDoc(), {})

    const script = makeEl('script', {}, { text: 'console.log("salut")' })
    const div = makeEl('div')
    div.appendChild(script)

    µ._mjs_navWarnScripts([div])
    assert.equal(warnCalls.length, 1)
    assert.match(warnCalls[0][0], /<script>/)
    assert.match(warnCalls[0][0], /ne ré-exécute JAMAIS/)
    assert.match(warnCalls[0][0], /console\.log\("salut"\)/)
  })

  it('le nœud lui-même est un <script> (pas nécessairement niché) : détecté aussi', function () {
    const warnCalls: any[] = []
    const µ: any = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
    installHelpers(µ, makeDoc(), {})

    const script = makeEl('script', { type: 'module' }, { text: 'import x from "y"' })
    µ._mjs_navWarnScripts([script])
    assert.equal(warnCalls.length, 1, "type='module' est exécutable : averti")
  })

  ;[
    { type: 'application/json', label: 'application/json' },
    { type: 'importmap', label: 'importmap' },
    { type: 'text/template', label: 'text/template' },
  ].forEach(({ type, label }) => {
    it(`<script type="${label}"> (données, pas du code) → 0 avertissement`, function () {
      const warnCalls: any[] = []
      const µ: any = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
      installHelpers(µ, makeDoc(), {})

      const script = makeEl('script', { type }, { text: '{"x":1}' })
      const div = makeEl('div')
      div.appendChild(script)
      µ._mjs_navWarnScripts([div])
      assert.equal(warnCalls.length, 0)
    })
  })

  it("<script src=\"…\"> dont l'URL RÉSOLUE est déjà chargée dans la page courante → 0 avertissement", function () {
    const warnCalls: any[] = []
    const loadedBundle = makeEl('script', {}, { src: 'http://x/assets/bundle.js' })
    const µ: any = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
    installHelpers(µ, makeDoc([loadedBundle]), {})

    const script = makeEl('script', {}, { src: 'http://x/assets/bundle.js' })
    const div = makeEl('div')
    div.appendChild(script)
    µ._mjs_navWarnScripts([div])
    assert.equal(warnCalls.length, 0, 'le bundle de l\'app relayé par le gabarit ne doit pas bruiter à chaque navigation')
  })

  it("<script src=\"…\"> DIFFÉRENT de ceux déjà chargés → 1 avertissement, signature = l'URL", function () {
    const warnCalls: any[] = []
    const loadedBundle = makeEl('script', {}, { src: 'http://x/assets/bundle.js' })
    const µ: any = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
    installHelpers(µ, makeDoc([loadedBundle]), {})

    const script = makeEl('script', {}, { src: 'http://x/legacy/jquery.js' })
    const div = makeEl('div')
    div.appendChild(script)
    µ._mjs_navWarnScripts([div])
    assert.equal(warnCalls.length, 1)
    assert.match(warnCalls[0][0], /http:\/\/x\/legacy\/jquery\.js/)
  })

  it('2 navigations portant le MÊME script (même signature) → 1 SEUL avertissement au total', function () {
    const warnCalls: any[] = []
    const µ: any = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
    installHelpers(µ, makeDoc(), {})

    const makeSameScript = () => {
      const script = makeEl('script', {}, { text: 'alert(1)' })
      const div = makeEl('div')
      div.appendChild(script)
      return [div]
    }
    µ._mjs_navWarnScripts(makeSameScript())
    µ._mjs_navWarnScripts(makeSameScript()) // 2e navigation, contenu texte IDENTIQUE
    assert.equal(warnCalls.length, 1, 'même signature (60 premiers caractères compactés) : dédoublonné')
  })

  it('2 scripts inline avec un texte DIFFÉRENT → 2 avertissements distincts (signatures différentes)', function () {
    const warnCalls: any[] = []
    const µ: any = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
    installHelpers(µ, makeDoc(), {})

    const div1 = makeEl('div'); div1.appendChild(makeEl('script', {}, { text: 'alert(1)' }))
    const div2 = makeEl('div'); div2.appendChild(makeEl('script', {}, { text: 'alert(2)' }))
    µ._mjs_navWarnScripts([div1])
    µ._mjs_navWarnScripts([div2])
    assert.equal(warnCalls.length, 2)
  })

  it("ne jette JAMAIS, même sur des nœuds exotiques (texte, sans nodeType, sans tagName, sans querySelectorAll)", function () {
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(), {})
    assert.doesNotThrow(() => µ._mjs_navWarnScripts([]))
    assert.doesNotThrow(() => µ._mjs_navWarnScripts([null, undefined, { nodeType: 3, data: 'texte nu' }, {}]))
  })
})

describe('mjs_ujs — µ._mjs_navWarnScripts câblé sur le chemin HTML : clic cross-page', function () {
  it('un <script> dans la réponse HTML swappée déclenche exactement 1 avertissement, AVANT le swap', function () {
    const warnCalls: any[] = []
    const liveRoot: any = { nodeType: 1, tag: 'body', children: [] as any[], get childNodes() { return this.children }, replaceChildren(...nodes: any[]) { this.children = nodes } }
    const doc: any = { body: liveRoot, querySelectorAll: (sel: string) => (sel === 'script[src]' ? [] : []) }
    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', href: 'http://x/a', hash: '' }, history: { pushState() {} }, scrollTo() {} }
    const script = makeEl('script', {}, { text: 'alert("legacy")' })
    class DP { parseFromString() { return { body: { childNodes: [script] } } } }
    let capturedCb: any
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: () => false, get: () => null, set() {} }, _mjs_saveScroll() {},
      _mjs_ajaxGet: (_u: string, cb: any) => { capturedCb = cb },
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      Router: { navigate() {} },
      warn: (...a: any[]) => warnCalls.push(a), error() {}, log() {},
    }
    installHelpers(µ, doc, win)
    const link = { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname: '/b', search: '', hash: '', href: 'http://x/b', closest: function (this: any) { return this } }
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, composedPath: () => [link], target: link }
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    handler(e, µ, win, doc, DP)

    assert.ok(typeof capturedCb === 'function')
    capturedCb('<html>ignoré</html>', 'http://x/b')

    assert.equal(warnCalls.length, 1, 'le <script> de la réponse doit avoir déclenché exactement 1 avertissement')
    assert.match(warnCalls[0][0], /alert\("legacy"\)/)
    assert.deepEqual(liveRoot.children, [script], "le swap a bien eu lieu MALGRÉ l'avertissement (jamais bloquant)")
  })
})
