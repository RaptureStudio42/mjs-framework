// testing — harnais de test des APPLICATIONS ModularJS.
//
// Le framework a 4500 tests pour lui-même et ne proposait rien à ceux qui l'utilisent.
// Ce module ouvre une porte publique sur la mécanique qui existait déjà : compiler le
// projet avec le VRAI Bundler, charger le résultat dans un DOM simulé, monter un
// composant, agir dessus, lire ce qu'il affiche.
//
// Ce n'est PAS un lanceur de tests : il n'impose ni Mocha, ni Vitest, ni Jest. On
// monte, on agit, on lit — l'assertion est celle de l'outil que l'auteur préfère.
//
//   import { createHarness } from 'modularjs-framework/testing'
//
//   const app     = await createHarness()          // lit mjs.config.json, compile une fois
//   const counter = await app.mount('my-counter', { start: 3 })
//   counter.text('.value')          // '3'
//   await counter.click('button')
//   counter.text('.value')          // '4'
//   counter.state.count             // 4
//   await app.destroy()
//
// DÉPENDANCE OPTIONNELLE — `happy-dom` fournit le DOM simulé. Le framework ne l'impose
// à personne (même patron que `playwright` pour le moteur de rendu navigateur) : elle
// est déclarée en pair optionnel, et son absence donne un message qui dit quoi installer.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../bundler/config.js'
import { stripEsm } from '../server/renderToString.js'
import { t } from '../messages/index.js'

export interface HarnessOptions {
  /** Racine du projet — c'est là que `mjs.config.json` est cherché. Défaut : le dossier courant. */
  root?: string
  /** Surcharges ponctuelles, pour un projet sans `mjs.config.json` (tests du framework, bacs à sable). */
  sourceDir?: string
  outputDir?: string
  manifestPath?: string
  stylesheetsDir?: string
  /** URL de la page simulée (utile pour tester un routeur). Défaut : `http://localhost/`. */
  url?: string
  /**
   * Ne charger QUE ces composants, par nom de fichier sans extension. Par défaut le
   * harnais charge TOUT le projet compilé : un composant imbriqué dans celui qu'on teste
   * se monte alors tout seul, sans rien déclarer. Sur un très gros projet, cette liste
   * réduit le temps de démarrage — au prix de devoir nommer les enfants.
   */
  only?: string[]
}

/** Un composant monté, avec de quoi agir dessus et lire ce qu'il affiche. */
export interface MountedComponent {
  /** L'élément lui-même (`<mjs-…>`), pour les cas que le harnais ne couvre pas. */
  el: any
  /** Sa racine d'ombre — c'est là que vivent les nœuds du gabarit. */
  shadow: any
  /** L'état réactif du composant, en lecture (`$count` se lit `state.count`). */
  state: Record<string, any>
  /** Premier nœud du composant qui correspond au sélecteur, ou `null`. */
  find(selector: string): any
  /** Tous les nœuds qui correspondent au sélecteur. */
  findAll(selector: string): any[]
  /** Texte affiché — du composant entier, ou du premier nœud qui correspond. */
  text(selector?: string): string
  /** Markup rendu, pour une assertion de forme ou un message d'échec lisible. */
  html(): string
  /** Clique, puis attend que le rendu ait eu lieu. */
  click(selector: string): Promise<void>
  /** Déclenche n'importe quel événement, puis attend le rendu. */
  fire(selector: string, type: string, init?: Record<string, any>): Promise<void>
  /** Saisit une valeur dans un champ (valeur posée + événement `input`), puis attend le rendu. */
  type(selector: string, value: string): Promise<void>
  /** Change des props depuis le parent, puis attend le rendu. */
  set(props: Record<string, any>): Promise<void>
  /** Attend que le rendu en attente ait eu lieu. Rarement utile : les verbes ci-dessus le font déjà. */
  tick(): Promise<void>
  /** Retire le composant de la page (ses hooks de démontage tournent). */
  destroy(): void
}

export interface Harness {
  /** Monte un composant par son nom de fichier (`my-counter.mjs` → `'my-counter'`). */
  mount(name: string, props?: Record<string, any>): Promise<MountedComponent>
  /** La fenêtre simulée, pour les cas limites (horloge, taille, `localStorage`…). */
  window: any
  /** Son document. */
  document: any
  /** Le runtime du framework, tel que la page le voit. */
  µ: any
  /** Les composants trouvés dans le projet compilé, par nom. */
  components: string[]
  /** Ferme la fenêtre et libère le compilateur. À appeler en fin de fichier de test. */
  destroy(): Promise<void>
}

/** Attend deux tours de microtâches : le rendu de MJS est planifié en microtâche. */
function nextTick(): Promise<void> {
  return new Promise(r => setTimeout(r, 0))
}

/**
 * Prépare un projet pour les tests : compile une fois, charge le résultat dans un DOM
 * simulé, et rend de quoi monter des composants. Un harnais par fichier de test suffit
 * — la compilation est le gros du coût, le montage est instantané.
 */
export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = resolve(opts.root ?? process.cwd())

  // config du projet, avec les surcharges éventuelles par-dessus
  const found     = findConfig(root)
  const fromFile  = found ? resolveBundlerOpts(found.config, found.configDir) : {}
  const opt: any  = { ...fromFile }
  if (opts.sourceDir)      opt.sourceDir      = resolve(root, opts.sourceDir)
  if (opts.outputDir)      opt.outputDir      = resolve(root, opts.outputDir)
  if (opts.manifestPath)   opt.manifestPath   = resolve(root, opts.manifestPath)
  if (opts.stylesheetsDir) opt.stylesheetsDir = resolve(root, opts.stylesheetsDir)
  if (!opt.sourceDir) throw new Error(t('testing.pas-de-projet', { racine: root }))

  const bundler = new Bundler(opt)
  const stats   = await bundler.compile()
  if (stats.errors.length > 0) {
    await bundler.close()
    throw new Error(t('testing.compilation-en-echec', { detail: stats.errors.map((e: any) => e.message).join('\n') }))
  }

  // happy-dom est une dépendance OPTIONNELLE : absente, on dit quoi installer plutôt
  // que de laisser tomber une erreur de résolution de module au visage de l'auteur
  let HappyDOM: any
  try {
    HappyDOM = await import('happy-dom')
  } catch {
    await bundler.close()
    throw new Error(t('testing.happy-dom-absent'))
  }

  const window: any   = new HappyDOM.Window({ url: opts.url ?? 'http://localhost/' })
  const document: any = window.document
  const outDir        = bundler.outputDir
  const fichiers      = existsSync(outDir) ? readdirSync(outDir) : []

  const lire = (fichier: string) => stripEsm(readFileSync(join(outDir, fichier), 'utf-8'))

  // 1. le cœur du runtime, puis `µ` en global — même amorce que le rendu serveur
  const coreFile = fichiers.find(f => /^mjs_core-[a-f0-9]{8}\.js$/.test(f))
  if (!coreFile) {
    await bundler.close()
    throw new Error(t('testing.runtime-introuvable', { dossier: outDir }))
  }
  window.eval(`${lire(coreFile)}\nglobalThis.µ = µ;`)

  // 2. les feuilles partagées émises en module (modes 'bundle' et 'split' ; en 'lazy'
  //    ce sont de vrais `.css` que le runtime ira chercher lui-même)
  for (const f of fichiers.filter(f => /^mjs_styles?(_[a-zA-Z0-9_]+)?-[a-f0-9]{8}\.js$/.test(f))) {
    try { window.eval(lire(f)) } catch { /* une feuille qui refuse ne doit pas tuer le harnais */ }
  }

  // 3. les composants. Par défaut TOUS : un composant imbriqué dans celui qu'on teste se
  //    monte alors sans rien avoir à déclarer. Chacun dans SON eval, pour qu'un composant
  //    fautif n'emporte pas les autres — l'erreur ressort au montage, nommée.
  const interne  = (nom: string) => nom.startsWith('__')
  const noms     = Object.keys(stats.manifest).filter(n => !interne(n)).sort()
  const aCharger = opts.only ? noms.filter(n => opts.only!.includes(n)) : noms
  const echecs   = new Map<string, string>()
  for (const nom of aCharger) {
    const fichier = basename(String(stats.manifest[nom]))
    if (!fichiers.includes(fichier)) continue
    try { window.eval(lire(fichier)) } catch (e: any) { echecs.set(nom, e?.message ?? String(e)) }
  }

  async function mount(nom: string, props: Record<string, any> = {}): Promise<MountedComponent> {
    if (echecs.has(nom)) throw new Error(t('testing.composant-en-echec', { nom, detail: echecs.get(nom)! }))
    const tag = `mjs-${nom}`
    if (!window.customElements.get(tag)) {
      throw new Error(t('testing.composant-inconnu', { nom, connus: aCharger.join(', ') || '—' }))
    }
    const el = document.createElement(tag)
    // props posées AVANT l'insertion : le runtime récupère les propriétés déposées sur
    // l'élément avant sa mise à niveau (`_mjs_var_bits`), ce qui laisse passer des objets et
    // des tableaux — un attribut ne saurait porter que du texte
    for (const [cle, valeur] of Object.entries(props)) el[cle] = valeur
    document.body.appendChild(el)
    await nextTick()
    return composant(el)
  }

  function composant(el: any): MountedComponent {
    const racine = () => el._shadow ?? el
    const trouve = (sel: string) => racine().querySelector(sel)
    const api: MountedComponent = {
      el,
      get shadow() { return racine() },
      get state() { return el._state ?? {} },
      find: (sel) => trouve(sel),
      findAll: (sel) => Array.from(racine().querySelectorAll(sel)),
      text: (sel) => (sel ? (trouve(sel)?.textContent ?? '') : (racine().textContent ?? '')).trim(),
      html: () => racine().innerHTML ?? '',
      click: (sel) => api.fire(sel, 'click'),
      async fire(sel, type, init = {}) {
        const cible = trouve(sel)
        if (!cible) throw new Error(t('testing.selecteur-sans-noeud', { selecteur: sel, tag: el.tagName.toLowerCase() }))
        cible.dispatchEvent(new window.Event(type, { bubbles: true, composed: true, ...init }))
        await nextTick()
      },
      async type(sel, valeur) {
        const cible = trouve(sel)
        if (!cible) throw new Error(t('testing.selecteur-sans-noeud', { selecteur: sel, tag: el.tagName.toLowerCase() }))
        cible.value = valeur
        cible.dispatchEvent(new window.Event('input', { bubbles: true, composed: true }))
        await nextTick()
      },
      // Après le montage, un parent change une prop scalaire en changeant l'ATTRIBUT —
      // c'est l'observateur du composant qui la voit passer, exactement comme dans une
      // vraie page. Une valeur qu'un attribut ne saurait porter (objet, tableau,
      // fonction) passe par l'écriture d'état du runtime, qui est ce que le compilateur
      // émet dans ce cas.
      async set(props) {
        for (const [cle, valeur] of Object.entries(props)) {
          const scalaire = valeur === null || ['string', 'number', 'boolean'].includes(typeof valeur)
          if (scalaire && typeof el.setAttribute === 'function') {
            if (valeur === null || valeur === false) el.removeAttribute(cle)
            else el.setAttribute(cle, valeur === true ? '' : String(valeur))
          }
          else if (typeof el._set === 'function') el._set(cle, valeur)
          else el[cle] = valeur
        }
        await nextTick()
      },
      tick: nextTick,
      destroy() { el.remove() },
    }
    return api
  }

  return {
    mount,
    window,
    document,
    µ: window.µ,
    components: aCharger,
    async destroy() {
      // Garde-fou — même motif que renderToString.ts : `window.close()`
      // (API DOM standard) est un NO-OP sur une Window happy-dom créée nue — `window.happyDOM.close()`
      // est la VRAIE API de nettoyage (annule les tâches en cours ET ferme), sans quoi un
      // `setInterval`/`setTimeout` posé par un `µeffect` pendant le montage fuit indéfiniment.
      try { await window.happyDOM?.close?.() } catch { /* happy-dom peut refuser de fermer deux fois */ }
      await bundler.close()
      await terminateSharedWorkerPool()
    },
  }
}
