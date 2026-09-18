// SÉCURITÉ : `µ._mjs_safeAttr`
// utilisait une DENYLIST (`javascript:` + `data:text/html` sur 5 attributs figés)
// qui laissait passer DEUX vecteurs XSS :
//   A. `<iframe srcdoc={x}>` — `srcdoc` hors liste → HTML injecté exécuté.
//   B. `<iframe src="data:image/svg+xml,…onload=…">` — la garde ne testait que
//      `data:text/html`, pas les autres sous-types data:.
//
// Refonte en ALLOW-LIST de schémas : seuls http(s)/mailto/tel (+ URL relative)
// passent ; `javascript:`/`vbscript:`/`file:`… refusés PARTOUT ; `data:`/`blob:`
// refusés sur les contextes EXÉCUTABLES/navigables (iframe|object|a|form|ping…)
// mais TOLÉRÉS sur les contextes MÉDIA (img/vidéo/poster/background) où ils sont
// inertes et idiomatiques (aperçu base64, object-URL). `srcdoc` refusé en bloc.

import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

// `µ._mjs_safeAttr` lit `HTMLElement.prototype` (filtre `on*`) et écrit via
// setAttribute → on charge mjs_init dans un happy-dom réel puis on appelle la
// fonction directement (chemin isolé, pas de bundler).
// PORTABILITÉ Node ≥ 21 : `globalThis.navigator` y est un ACCESSEUR sans setter —
// l'affectation directe jette (« Cannot set property navigator … which has only a
// getter ») et tue le chargement du fichier, donc TOUTE la suite. On pose un
// descripteur de donnée : marche à l'identique sur 20 et sur 24
const win: any = new Window({ url: 'http://localhost/' })
for (const k of ['window', 'document', 'customElements', 'HTMLElement', 'CSSStyleSheet', 'navigator']) {
  Object.defineProperty(globalThis, k, { value: win[k], writable: true, configurable: true })
}
const { µ } = (await import('../src/runtime/mjs_init.js')) as any

// Écrit `value` sur un `<tag name=…>` frais via `µ._mjs_safeAttr` et renvoie ce que
// l'attribut vaut RÉELLEMENT après coup (null = écriture refusée, placeholder
// jamais posé).
function wrote(tag: string, name: string, value: string): string | null {
  const node: any = win.document.createElement(tag)
  µ._mjs_safeAttr(node, name, value)
  return node.getAttribute(name)
}

describe('µ._mjs_safeAttr — allow-list de schémas (durcissement XSS)', () => {
  it('srcdoc est refusé EN BLOC (sink HTML, pas une URL) — vecteur A', () => {
    assert.equal(wrote('iframe', 'srcdoc', '<img src=x onerror=alert(1)>'), null,
      'srcdoc ne doit JAMAIS être écrit depuis un binding dynamique')
  })

  it('data:image/svg+xml sur <iframe src> (contexte exécutable) est bloqué — vecteur B', () => {
    assert.equal(wrote('iframe', 'src', 'data:image/svg+xml,<svg onload=alert(1)>'), null,
      'AVANT le fix : seul data:text/html était bloqué, pas data:image/svg+xml')
  })

  it('data:text/html sur <object data> (contexte exécutable) est bloqué', () => {
    assert.equal(wrote('object', 'data', 'data:text/html,<script>x</script>'), null)
  })

  it('javascript:/vbscript: bloqués PARTOUT (a href, img src, ping…)', () => {
    assert.equal(wrote('a', 'href', 'javascript:alert(1)'), null)
    assert.equal(wrote('img', 'src', 'javascript:alert(1)'), null)
    assert.equal(wrote('a', 'href', 'vbscript:msgbox(1)'), null)
    assert.equal(wrote('a', 'ping', 'javascript:x'), null)
  })

  it('javascript: obfusqué par caractères de contrôle/espaces est bloqué', () => {
    assert.equal(wrote('a', 'href', 'java\0script:alert(1)'), null)
    assert.equal(wrote('a', 'href', 'java\tscript:alert(1)'), null)
  })

  it('http(s):// autorisé (URL de navigation légitime)', () => {
    assert.equal(wrote('a', 'href', 'https://ok.example/'), 'https://ok.example/')
    assert.equal(wrote('a', 'href', 'http://ok.example/'), 'http://ok.example/')
  })

  it('URL relative / hash / query / mailto / tel autorisés (pas de schéma bloqué)', () => {
    assert.equal(wrote('a', 'href', '/local/path'), '/local/path')
    assert.equal(wrote('a', 'href', '#anchor'), '#anchor')
    assert.equal(wrote('a', 'href', '?q=1'), '?q=1')
    assert.equal(wrote('a', 'href', 'mailto:x@y.z'), 'mailto:x@y.z')
    assert.equal(wrote('a', 'href', 'tel:+33123'), 'tel:+33123')
  })

  // L'allow-list {http,https,mailto,tel} refusait sms:/ftp:/geo:/…
  // alors que tel: passait — incohérent, sans gain sécurité. Denylist ciblée : ces
  // schémas non-dangereux passent désormais.
  it('schémas non-http légitimes autorisés (sms/ftp/geo/webcal)', () => {
    assert.equal(wrote('a', 'href', 'sms:+33123'), 'sms:+33123', 'sms: cohérent avec tel:')
    assert.equal(wrote('a', 'href', 'ftp://host/file'), 'ftp://host/file')
    assert.equal(wrote('a', 'href', 'geo:48.8,2.3'), 'geo:48.8,2.3')
    assert.equal(wrote('a', 'href', 'webcal://host/cal.ics'), 'webcal://host/cal.ics')
  })

  it('data:/blob: TOLÉRÉS sur contexte MÉDIA (<img src>, <video poster>) — inertes', () => {
    const png = 'data:image/png;base64,iVBORw0KG'
    assert.equal(wrote('img', 'src', png), png, 'aperçu base64 en <img> : sûr (un SVG en img ne script pas)')
    assert.equal(wrote('img', 'src', 'blob:http://localhost/abc'), 'blob:http://localhost/abc', 'object-URL de fichier : sûr')
    assert.equal(wrote('video', 'poster', png), png, 'poster (image) : data: toléré')
  })

  // Durcissements : contextes exécutables/navigables
  // manqués par _mjs_isExecUrlAttr.
  it('data:/blob: bloqués sur xlink:href (SVG) et <script src|href>', () => {
    assert.equal(wrote('a', 'xlink:href', 'data:text/html,<script>alert(1)</script>'), null,
      'xlink:href SVG est navigable → data: doit être refusé comme sur href')
    assert.equal(wrote('script', 'src', 'data:text/javascript,alert(1)'), null, '<script src=data:> = exécution')
    assert.equal(wrote('script', 'href', 'data:text/javascript,alert(1)'), null, 'SVG <script href=data:> = exécution')
  })

  it('handlers WindowEventHandlers (on* absents de HTMLElement.prototype) refusés', () => {
    assert.equal(wrote('body', 'onbeforeunload', 'alert(1)'), null)
    assert.equal(wrote('body', 'onmessage', 'alert(1)'), null)
    assert.equal(wrote('body', 'onpopstate', 'alert(1)'), null)
    assert.equal(wrote('body', 'onhashchange', 'alert(1)'), null)
    assert.equal(wrote('body', 'onunload', 'alert(1)'), null)
  })

  it('gestionnaire d\'événement inline (on*) refusé', () => {
    assert.equal(wrote('div', 'onclick', 'alert(1)'), null)
    assert.equal(wrote('img', 'onerror', 'alert(1)'), null)
  })

  it('attribut hors périmètre URL (title, data-*) écrit tel quel', () => {
    assert.equal(wrote('div', 'title', 'javascript:alert(1)'), 'javascript:alert(1)', 'title n\'est pas une URL — pas de filtrage')
    assert.equal(wrote('div', 'data-x', 'blob:whatever'), 'blob:whatever', 'data-* n\'est pas l\'attribut data d\'<object>')
  })
})
