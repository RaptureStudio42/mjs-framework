// Tree-shake EXPLICITE du runtime — param de build `runtime` (all/core/[modules]).
// Généralise l'ancien flag interne `minimalRuntime`. Vérifie :
//   - sélection correcte (cœur + optionnels choisis) ;
//   - ORDRE canonique préservé (mjs_flip APRÈS mjs_element = garde du patch
//     `µ.Element.prototype`) ;
//   - rétrocompat BYTE-identique en 'all'/'core' vs l'historique ;
//   - fail-safe : nom inconnu via l'API directe ignoré AVEC avertissement,
//     jamais un crash ni un module fantôme ;
//   - validation STRICTE côté mjs.config.json (typo → lève, jamais un module
//     retiré en silence).

import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'

// mjs_vt_presets.ts N'EST PLUS rattaché au cœur : embarqué seulement si
// 'router' ou 'ujs' est sélectionné (ou demandé explicitement, runtime: [..., 'vt_presets']) —
// règle de CONFIGURATION pure, aucun scan. mjs_title.ts/mjs_store.ts/mjs_interpolate.ts (les
// trois premiers détachés) et mjs_ticker.ts/mjs_rare_runes.ts/mjs_head.ts/mjs_body.ts/
// mjs_dynamic.ts/mjs_effect.ts/mjs_every.ts/mjs_on.ts/mjs_failed.ts (détachés depuis, même
// doctrine) restent conditionnés par l'USAGE réel (scan textuel de sourceDir) :
// `resolveRuntimeFiles()` appelée SANS argument (API directe, comme dans tout ce fichier)
// ignore les faits et GARDE TOUS les détectés par défaut — seul `bundleRuntime()` lui passe le
// Set du scan (faits connus = on retire ce qui est absent).
// EXCEPTION mjs_ticker.ts : forcé EN PLUS dès que 'spring'/'smooth' est sélectionné (optionnel
// classique) ou 'interpolate' détecté — les trois appellent `µ.Ticker.add` sans aucune garde.
// Les 4 blocs structurels du gabarit (`{for}`/`{if}`/`{key}`/`{await}`, mjs_for.ts/mjs_if.ts/
// mjs_key.ts/mjs_await.ts) suivent la MÊME doctrine — scan textuel de la forme SOURCE du
// parseur — avec 2 exceptions symétriques à celle de mjs_ticker.ts : `key`/`await` FORCENT
// EN PLUS `if` (`_mjs_updKey`/`_mjs_updAwait` appellent des méthodes de mjs_if.ts) ; `for` est FORCÉ EN
// PLUS dès que 'flip' est sélectionné (optionnel classique — `mjs_flip.ts` capture
// `_mjs_reconcileList` à son propre chargement).
// CORE_HARD = les 4 VRAIS modules du cœur (jamais retirables, quels que soient les faits). CORE
// = ce que rend `resolveRuntimeFiles()` pour `'core'` SANS argument (CORE_HARD + les modules
// DÉTECTÉS gardés par défaut, faits inconnus — TOUS sauf mjs_vt_presets.ts, qui ne dépend
// jamais des faits, seulement de router/ujs).
// mjs_deep.ts/mjs_textpool.ts/mjs_esc.ts (familles de fonctions détachées de mjs_init.ts),
// mjs_for_nested.ts (`{for}` dans une liste ou dans une branche {await}, détaché de mjs_for.ts) et
// mjs_alias.ts (alias COURT d'une balise, détaché de mjs_dom.ts) suivent la MÊME doctrine que les
// autres détectés : gardés quand les faits sont inconnus.
const CORE_HARD = ['mjs_init.ts', 'mjs_dom.ts', 'mjs_runes.ts', 'mjs_autoloader.ts', 'mjs_element.ts']
// 'core' SANS `used` (API directe) = CORE_HARD + les modules DÉTECTÉS gardés par défaut
// (used===undefined). mjs_page_cache.ts N'Y FIGURE PAS : signal 100% `selected`
// (router/ujs/modal), toujours VIDE en 'core' (aucun optionnel classique sélectionné) — il ne
// répond jamais à `used`, contrairement aux autres.
const CORE = ['mjs_init.ts', 'mjs_dom.ts', 'mjs_alias.ts', 'mjs_deep.ts', 'mjs_textpool.ts', 'mjs_esc.ts', 'mjs_theme.ts', 'mjs_ticker.ts', 'mjs_interpolate.ts', 'mjs_store.ts', 'mjs_runes.ts', 'mjs_rare_runes.ts', 'mjs_head.ts', 'mjs_body.ts', 'mjs_dynamic.ts', 'mjs_effect.ts', 'mjs_every.ts', 'mjs_autoloader.ts', 'mjs_element.ts', 'mjs_html.ts', 'mjs_slots.ts', 'mjs_title.ts', 'mjs_on.ts', 'mjs_emit.ts', 'mjs_context.ts', 'mjs_lifecycle.ts', 'mjs_layout_variant.ts', 'mjs_destroy_hooks.ts', 'mjs_failed.ts', 'mjs_if.ts', 'mjs_key.ts', 'mjs_for.ts', 'mjs_for_nested.ts', 'mjs_await.ts']
// CORE_HARD + mjs_title.ts SEUL (used = new Set(['title']), rien d'autre détecté) —
// sert la distinction faits CONNUS mais partiels, cf. tests plus bas.
const CORE_HARD_TITLE = ['mjs_init.ts', 'mjs_dom.ts', 'mjs_theme.ts', 'mjs_runes.ts', 'mjs_autoloader.ts', 'mjs_element.ts', 'mjs_title.ts']
// CORE_HARD + mjs_ticker.ts/mjs_interpolate.ts/mjs_store.ts/mjs_title.ts/mjs_lifecycle.ts SEULS
// (used = new Set(['title', 'store', 'interpolate']) EXPLICITE : les modules détachés depuis
// (scan seul, sans force structurelle) — head/body/dynamic/rare_runes/on/effect/every/failed/
// for/if/key/await — tous NON détectés ; mjs_ticker.ts et mjs_lifecycle.ts suivent 'interpolate').
const CORE_TITLE_STORE_INTERP = ['mjs_init.ts', 'mjs_dom.ts', 'mjs_theme.ts', 'mjs_ticker.ts', 'mjs_interpolate.ts', 'mjs_store.ts', 'mjs_runes.ts', 'mjs_autoloader.ts', 'mjs_element.ts', 'mjs_title.ts', 'mjs_lifecycle.ts']
// Modules qui ne suivent QUE le scan (jamais forcés par une sélection 'all'/optionnelle, à la
// différence de mjs_vt_presets.ts et mjs_ticker.ts ci-dessus) — sert à retirer du FULL
// « byte-identique » ce qu'un scan à faits partiels/vides ne détecte pas. mjs_for.ts n'y figure
// PAS : comme mjs_ticker.ts, il reste forcé (par 'flip', toujours du bundle en 'all').
// mjs_lifecycle.ts n'y figure pas non plus : forcé par 'smooth'/'socket'/'router'/'ujs'/'modal'
// (appelants de l'API de destruction), tous du bundle en 'all'.
// mjs_esc.ts n'y figure pas davantage : hors production, le panneau de développement l'appelle
// pour son propre affichage — il reste joint dès qu'un optionnel est sélectionné (cf. son
// bandeau dans resolveRuntimeFiles), et les Bundler de ce fichier sont tous en dev.
const SCAN_ONLY_SANS_FORCE = ['mjs_alias.ts', 'mjs_head.ts', 'mjs_body.ts', 'mjs_dynamic.ts', 'mjs_rare_runes.ts', 'mjs_html.ts', 'mjs_deep.ts', 'mjs_textpool.ts', 'mjs_for_nested.ts', 'mjs_slots.ts', 'mjs_on.ts', 'mjs_effect.ts', 'mjs_every.ts', 'mjs_failed.ts', 'mjs_if.ts', 'mjs_key.ts', 'mjs_await.ts', 'mjs_emit.ts', 'mjs_context.ts', 'mjs_layout_variant.ts', 'mjs_destroy_hooks.ts']
// mjs_journal.ts (module optionnel 'journal') à sa position CANONICAL (après mjs_i18n.ts) ;
// les modules détachés depuis à la position historique de mjs_runes.ts (dont ils viennent) +
// mjs_ticker.ts tôt (avant ses consommateurs) + mjs_on.ts/mjs_failed.ts après mjs_element.ts +
// mjs_if.ts/mjs_key.ts/mjs_for.ts/mjs_await.ts après (dans cet ordre, cf. bundler/index.ts),
// TOUS AVANT mjs_flip.ts (qui capture _mjs_reconcileList à son chargement) : ripple mécanique
// direct de l'ajout à CANONICAL, pas un choix de ce test.
// mjs_page_cache.ts (router/ujs/modal — les 3 sont dans allOptional()) et mjs_emit.ts/
// mjs_context.ts/mjs_lifecycle.ts/mjs_layout_variant.ts/mjs_destroy_hooks.ts (used===undefined,
// « faits inconnus = on garde ») : détachés du cœur, même doctrine que les précédents.
// mjs_lazy_css.ts et mjs_hydrate.ts N'Y FIGURENT PAS : signaux de CONFIG PURE (`css: 'lazy'` pour
// l'un, un mode d'hydratation dans `render` pour l'autre), jamais atteints par
// `runtime`/`allOptional()` — hors du périmètre de FULL par construction (cf. le test anti-oubli).
const FULL = [
  'mjs_init.ts', 'mjs_dom.ts', 'mjs_alias.ts', 'mjs_deep.ts', 'mjs_textpool.ts', 'mjs_esc.ts', 'mjs_theme.ts', 'mjs_page_cache.ts', 'mjs_ticker.ts', 'mjs_vt_presets.ts', 'mjs_easing.ts', 'mjs_interpolate.ts', 'mjs_spring.ts', 'mjs_smooth.ts',
  'mjs_store.ts', 'mjs_runes.ts', 'mjs_rare_runes.ts', 'mjs_head.ts', 'mjs_body.ts', 'mjs_dynamic.ts', 'mjs_effect.ts', 'mjs_every.ts', 'mjs_store_globals.ts', 'mjs_i18n.ts', 'mjs_journal.ts', 'mjs_ajax.ts', 'mjs_socket.ts', 'mjs_schema.ts', 'mjs_optimistic.ts', 'mjs_game.ts', 'mjs_chat.ts', 'mjs_accounts.ts', 'mjs_lobby.ts',
  'mjs_interp.ts', 'mjs_predict.ts', 'mjs_det.ts', 'mjs_lockstep.ts', 'mjs_router.ts',
  'mjs_modal.ts', 'mjs_ujs.ts', 'mjs_autoloader.ts', 'mjs_element.ts', 'mjs_html.ts', 'mjs_slots.ts', 'mjs_title.ts', 'mjs_on.ts', 'mjs_emit.ts', 'mjs_context.ts', 'mjs_lifecycle.ts', 'mjs_layout_variant.ts', 'mjs_destroy_hooks.ts', 'mjs_failed.ts',
  'mjs_if.ts', 'mjs_key.ts', 'mjs_for.ts', 'mjs_for_nested.ts', 'mjs_await.ts', 'mjs_flip.ts',
]

describe('bundler — sélection des modules runtime (param `runtime`)', () => {
  it('défaut (runtime absent, minimalRuntime false) + i18n configuré = tous les modules, ordre canonique', () => {
    const b = new Bundler({ i18n: { default: 'fr' } })
    const { files, coreOnly } = b.resolveRuntimeFiles()
    assert.deepEqual(files, FULL)
    assert.equal(coreOnly, false)
  })

  it("'all' + i18n configuré = identique au défaut (byte-identique à l'historique)", () => {
    const b = new Bundler({ runtime: 'all', i18n: { default: 'fr' } })
    assert.deepEqual(b.resolveRuntimeFiles().files, FULL)
  })

  // mjs_i18n.ts est dans CANONICAL donc dans le cœur de TOUT
  // projet en 'all' MÊME sans i18n (+22 Ko constatés, cf. commentaire
  // resolveRuntimeFiles) : config-driven, PAS d'auto-détection par scan de
  // code. Exclu de 'all' seulement si NI config.i18n NI sourceDir/i18n/
  // n'existent (mêmes signaux que scanI18n()).
  it("'all' SANS i18n configuré (ni config.i18n, ni dossier i18n/) = mjs_i18n.ts EXCLU, reste identique", () => {
    const b = new Bundler({ runtime: 'all' })
    const { files, coreOnly } = b.resolveRuntimeFiles()
    assert.deepEqual(files, FULL.filter(f => f !== 'mjs_i18n.ts'))
    assert.equal(coreOnly, false)
  })

  it("défaut (runtime absent) SANS i18n configuré = mjs_i18n.ts EXCLU (même filtre que 'all' explicite)", () => {
    const b = new Bundler({})
    const { files } = b.resolveRuntimeFiles()
    assert.ok(!files.includes('mjs_i18n.ts'))
    assert.deepEqual(files, FULL.filter(f => f !== 'mjs_i18n.ts'))
  })

  it("sélection EXPLICITE runtime: ['i18n'] SANS dossier i18n/ ni config.i18n = inclus quand même (explicite gagne)", () => {
    const b = new Bundler({ runtime: ['i18n'] })
    const { files } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_i18n.ts'), "l'explicite doit gagner même sans i18n/ configuré")
  })

  it("'core' = cœur seul, coreOnly true", () => {
    const b = new Bundler({ runtime: 'core' })
    const { files, coreOnly } = b.resolveRuntimeFiles()
    assert.deepEqual(files, CORE)
    assert.equal(coreOnly, true)
  })

  it("rétrocompat : minimalRuntime true (sans runtime) équivaut à 'core'", () => {
    const b = new Bundler({ minimalRuntime: true })
    const { files, coreOnly } = b.resolveRuntimeFiles()
    assert.deepEqual(files, CORE)
    assert.equal(coreOnly, true)
  })

  it("runtime prime sur minimalRuntime ('all' + minimalRuntime true → tout, + i18n configuré)", () => {
    const b = new Bundler({ runtime: 'all', minimalRuntime: true, i18n: { default: 'fr' } })
    assert.deepEqual(b.resolveRuntimeFiles().files, FULL)
  })

  it("cœur + un optionnel : ['router'] inséré à sa position canonique", () => {
    const b = new Bundler({ runtime: ['router'] })
    const { files, coreOnly } = b.resolveRuntimeFiles()
    assert.deepEqual(files, ['mjs_init.ts', 'mjs_dom.ts', 'mjs_alias.ts', 'mjs_deep.ts', 'mjs_textpool.ts', 'mjs_esc.ts', 'mjs_theme.ts', 'mjs_page_cache.ts', 'mjs_ticker.ts', 'mjs_vt_presets.ts', 'mjs_interpolate.ts', 'mjs_store.ts', 'mjs_runes.ts', 'mjs_rare_runes.ts', 'mjs_head.ts', 'mjs_body.ts', 'mjs_dynamic.ts', 'mjs_effect.ts', 'mjs_every.ts', 'mjs_router.ts', 'mjs_autoloader.ts', 'mjs_element.ts', 'mjs_html.ts', 'mjs_slots.ts', 'mjs_title.ts', 'mjs_on.ts', 'mjs_emit.ts', 'mjs_context.ts', 'mjs_lifecycle.ts', 'mjs_layout_variant.ts', 'mjs_destroy_hooks.ts', 'mjs_failed.ts', 'mjs_if.ts', 'mjs_key.ts', 'mjs_for.ts', 'mjs_for_nested.ts', 'mjs_await.ts'])
    assert.equal(coreOnly, false)
  })

  it("cœur + ['vault'] résout le fichier renommé mjs_store_globals.ts (clé publique inchangée)", () => {
    const b = new Bundler({ runtime: ['vault'] })
    const { files, coreOnly } = b.resolveRuntimeFiles()
    // mjs_vt_presets.ts ABSENT : 'vault' ne sélectionne ni 'router' ni 'ujs'.
    assert.deepEqual(files, ['mjs_init.ts', 'mjs_dom.ts', 'mjs_alias.ts', 'mjs_deep.ts', 'mjs_textpool.ts', 'mjs_esc.ts', 'mjs_theme.ts', 'mjs_ticker.ts', 'mjs_interpolate.ts', 'mjs_store.ts', 'mjs_runes.ts', 'mjs_rare_runes.ts', 'mjs_head.ts', 'mjs_body.ts', 'mjs_dynamic.ts', 'mjs_effect.ts', 'mjs_every.ts', 'mjs_store_globals.ts', 'mjs_autoloader.ts', 'mjs_element.ts', 'mjs_html.ts', 'mjs_slots.ts', 'mjs_title.ts', 'mjs_on.ts', 'mjs_emit.ts', 'mjs_context.ts', 'mjs_lifecycle.ts', 'mjs_layout_variant.ts', 'mjs_destroy_hooks.ts', 'mjs_failed.ts', 'mjs_if.ts', 'mjs_key.ts', 'mjs_for.ts', 'mjs_for_nested.ts', 'mjs_await.ts'])
    assert.equal(coreOnly, false)
  })

  it('flip reste APRÈS element (garde du patch prototype)', () => {
    const b = new Bundler({ runtime: ['flip'] })
    const files = b.resolveRuntimeFiles().files
    assert.ok(files.indexOf('mjs_flip.ts') > files.indexOf('mjs_element.ts'), 'flip doit suivre element')
  })

  it("avertit si 'ujs' sans 'router' (interception inerte), sans crasher", () => {
    const b = new Bundler({ runtime: ['ujs'] })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_ujs.ts'))
    assert.ok(warnings.some(w => /ujs/.test(w) && /router/.test(w)), 'un avertissement ujs/router attendu')
  })

  it("pas d'avertissement ujs quand router est présent", () => {
    const b = new Bundler({ runtime: ['router', 'ajax', 'ujs'] })
    assert.equal(b.resolveRuntimeFiles().warnings.length, 0)
  })

  it("avertit si 'game' sans 'socket' (sock.game resterait indéfini), sans crasher", () => {
    const b = new Bundler({ runtime: ['game'] })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_game.ts'))
    assert.ok(!files.includes('mjs_socket.ts'))
    assert.ok(warnings.some(w => /game/.test(w) && /socket/.test(w)), 'un avertissement game/socket attendu')
  })

  it("pas d'avertissement game quand socket est présent", () => {
    const b = new Bundler({ runtime: ['socket', 'game'] })
    assert.equal(b.resolveRuntimeFiles().warnings.length, 0)
  })

  it("avertit si 'chat' sans 'socket' (sock.chat resterait indéfini), sans crasher", () => {
    const b = new Bundler({ runtime: ['chat'] })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_chat.ts'))
    assert.ok(!files.includes('mjs_socket.ts'))
    assert.ok(warnings.some(w => /chat/.test(w) && /socket/.test(w)), 'un avertissement chat/socket attendu')
  })

  it("pas d'avertissement chat quand socket est présent", () => {
    const b = new Bundler({ runtime: ['socket', 'chat'] })
    assert.equal(b.resolveRuntimeFiles().warnings.length, 0)
  })

  it("avertit si 'accounts' sans 'socket' (sock.account resterait indéfini), sans crasher", () => {
    const b = new Bundler({ runtime: ['accounts'] })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_accounts.ts'))
    assert.ok(!files.includes('mjs_socket.ts'))
    assert.ok(warnings.some(w => /accounts/.test(w) && /socket/.test(w)), 'un avertissement comptes/socket attendu')
  })

  it("pas d'avertissement comptes quand socket est présent", () => {
    const b = new Bundler({ runtime: ['socket', 'accounts'] })
    assert.equal(b.resolveRuntimeFiles().warnings.length, 0)
  })

  it("avertit si 'lobby' sans 'socket' (sock.lobby resterait indéfini), sans crasher", () => {
    const b = new Bundler({ runtime: ['lobby'] })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_lobby.ts'))
    assert.ok(!files.includes('mjs_socket.ts'))
    assert.ok(warnings.some(w => /lobby/.test(w) && /socket/.test(w)), 'un avertissement lobby/socket attendu')
  })

  it("pas d'avertissement lobby quand socket est présent", () => {
    const b = new Bundler({ runtime: ['socket', 'lobby'] })
    assert.equal(b.resolveRuntimeFiles().warnings.length, 0)
  })

  it("avertit si 'schema' sans 'socket' (µ.schema resterait débranché du réseau), sans crasher", () => {
    const b = new Bundler({ runtime: ['schema'] })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_schema.ts'))
    assert.ok(!files.includes('mjs_socket.ts'))
    assert.ok(warnings.some(w => /schema/.test(w) && /socket/.test(w)), 'un avertissement schema/socket attendu')
  })

  it("pas d'avertissement schema quand socket est présent", () => {
    const b = new Bundler({ runtime: ['socket', 'schema'] })
    assert.equal(b.resolveRuntimeFiles().warnings.length, 0)
  })

  it("avertit si 'optimistic' sans 'socket' (usage typique débranché), sans crasher", () => {
    const b = new Bundler({ runtime: ['optimistic'] })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_optimistic.ts'))
    assert.ok(!files.includes('mjs_socket.ts'))
    assert.ok(warnings.some(w => /optimistic/.test(w) && /socket/.test(w)), 'un avertissement optimistic/socket attendu')
  })

  it("pas d'avertissement optimistic quand socket est présent", () => {
    const b = new Bundler({ runtime: ['socket', 'optimistic'] })
    assert.equal(b.resolveRuntimeFiles().warnings.length, 0)
  })

  it("avertit si 'interp'/'predict' sans 'game' (rien à observer/piloter), sans crasher", () => {
    const bi = new Bundler({ runtime: ['interp'] })
    const { files: fi, warnings: wi } = bi.resolveRuntimeFiles()
    assert.ok(fi.includes('mjs_interp.ts'))
    assert.ok(!fi.includes('mjs_game.ts'))
    assert.ok(wi.some(w => /interp/.test(w) && /game/.test(w)), 'un avertissement interp/game attendu')
    const bp = new Bundler({ runtime: ['predict'] })
    const { files: fp, warnings: wp } = bp.resolveRuntimeFiles()
    assert.ok(fp.includes('mjs_predict.ts'))
    assert.ok(!fp.includes('mjs_game.ts'))
    assert.ok(wp.some(w => /predict/.test(w) && /game/.test(w)), 'un avertissement predict/game attendu')
  })

  it("pas d'avertissement interp/predict quand game est présent", () => {
    const b = new Bundler({ runtime: ['socket', 'game', 'interp', 'predict'] })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_interp.ts') && files.includes('mjs_predict.ts'))
    assert.equal(warnings.length, 0)
  })

  it("avertit si 'lockstep' sans 'game' (rien à piloter) NI 'det' (pas de graine), sans crasher", () => {
    const b = new Bundler({ runtime: ['lockstep'] })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_lockstep.ts'))
    assert.ok(!files.includes('mjs_game.ts') && !files.includes('mjs_det.ts'))
    assert.ok(warnings.some(w => /lockstep/.test(w) && /game/.test(w)), 'un avertissement lockstep/game attendu')
    assert.ok(warnings.some(w => /lockstep/.test(w) && /det/.test(w)), 'un avertissement lockstep/det attendu')
  })

  it("pas d'avertissement lockstep quand game ET det sont présents", () => {
    const b = new Bundler({ runtime: ['socket', 'game', 'det', 'lockstep'] })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_det.ts') && files.includes('mjs_lockstep.ts'))
    assert.equal(warnings.length, 0)
  })

  it("'det' seul (sans game/socket) : aucun avertissement — module PUR, testable sans réseau", () => {
    const b = new Bundler({ runtime: ['det'] })
    const { files, warnings } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_det.ts'))
    assert.equal(warnings.length, 0)
  })

  it('fail-safe : nom inconnu (API directe) ignoré + averti, jamais un module fantôme', () => {
    const b = new Bundler({ runtime: ['bogus'] })
    const { files, warnings, coreOnly } = b.resolveRuntimeFiles()
    assert.deepEqual(files, CORE)
    assert.equal(coreOnly, true)
    assert.ok(warnings.some(w => /inconnu/.test(w) && /bogus/.test(w)))
  })

  it('un nom de module CŒUR dans le tableau est un no-op (pas de doublon)', () => {
    const b = new Bundler({ runtime: ['element', 'router'] })
    const files = b.resolveRuntimeFiles().files
    assert.equal(files.filter(f => f === 'mjs_element.ts').length, 1)
    assert.ok(files.includes('mjs_router.ts'))
  })

  it("[] (tableau vide) équivaut à 'core' (cœur, aucun optionnel)", () => {
    const b = new Bundler({ runtime: [] })
    const { files, coreOnly } = b.resolveRuntimeFiles()
    assert.deepEqual(files, CORE)
    assert.equal(coreOnly, true)
  })

  it("garde anti-oubli : 'all' (+ debug dev) couvre TOUS les mjs_*.ts de src/runtime", () => {
    // Deux sources de vérité (OPTIONAL_RUNTIME_MODULES + la liste CANONICAL du
    // bundler) : un module ajouté à src/runtime mais oublié dans la liste ne
    // serait JAMAIS bundlé, en silence. Ce test croise la sélection réelle avec
    // le disque pour l'attraper au moindre ajout.
    const b = new Bundler({ runtime: 'all', i18n: { default: 'fr' } })
    const inAll = new Set(b.resolveRuntimeFiles().files)
    inAll.add('mjs_debug.ts')       // dev-only, injecté par bundleRuntime hors de la liste
    inAll.add('mjs_devinspect.ts')  // idem, juste après lui (inspecteur d'objets générique)
    inAll.add('mjs_devpanel.ts')    // idem, en dernier (le panneau s'appuie sur les deux)
    inAll.add('mjs_hotcss.ts')      // idem, dev-only (rechargement CSS à chaud), même splice
    inAll.add('mjs_lazy_css.ts')    // signal de CONFIG PURE (`css: 'lazy'`), jamais `runtime`/'all'
    inAll.add('mjs_hydrate.ts')     // idem : signal de CONFIG PURE (mode d'hydratation dans `render`)
    const realModules = readdirSync(b.runtimeDir).filter(f => /^mjs_.*\.ts$/.test(f))
    for (const m of realModules) {
      assert.ok(inAll.has(m), `module runtime '${m}' absent de la sélection 'all' → jamais bundlé !`)
    }
  })

  // mjs_vt_presets.ts/mjs_title.ts/mjs_store.ts/mjs_interpolate.ts détachés du cœur : croise la
  // sélection `runtime` avec le Set `used` (2e argument de `resolveRuntimeFiles`, normalement
  // fourni par `bundleRuntime()` après son propre scan de sourceDir).
  it("'all' + new Set() (aucun fait) = FULL SANS les modules DÉTECTÉS PAR SCAN (mjs_vt_presets.ts/mjs_ticker.ts/mjs_for.ts restent : forcés par router/ujs/spring/smooth/flip, déjà tous dans 'all')", () => {
    const b = new Bundler({ runtime: 'all', i18n: { default: 'fr' } })
    const { files } = b.resolveRuntimeFiles(new Set())
    const SCAN_ONLY = ['mjs_title.ts', 'mjs_store.ts', 'mjs_interpolate.ts', ...SCAN_ONLY_SANS_FORCE]
    assert.deepEqual(files, FULL.filter(f => !SCAN_ONLY.includes(f)))
  })

  it("'all' + new Set(['title']) = FULL SANS mjs_store.ts/mjs_interpolate.ts/les modules scan-only (seul title détecté)", () => {
    const b = new Bundler({ runtime: 'all', i18n: { default: 'fr' } })
    const { files } = b.resolveRuntimeFiles(new Set(['title']))
    const SCAN_ONLY = ['mjs_store.ts', 'mjs_interpolate.ts', ...SCAN_ONLY_SANS_FORCE]
    assert.deepEqual(files, FULL.filter(f => !SCAN_ONLY.includes(f)))
  })

  it("'all' + new Set(['title', 'store', 'interpolate']) = FULL SANS les modules scan-only (les trois premiers détectés, aucun des autres)", () => {
    const b = new Bundler({ runtime: 'all', i18n: { default: 'fr' } })
    const { files } = b.resolveRuntimeFiles(new Set(['title', 'store', 'interpolate']))
    assert.deepEqual(files, FULL.filter(f => !SCAN_ONLY_SANS_FORCE.includes(f)))
  })

  it("'core' + new Set() = les 4 fichiers du cœur EXACTEMENT (ni vt_presets, ni title, ni store, ni interpolate)", () => {
    const b = new Bundler({ runtime: 'core' })
    const { files, coreOnly } = b.resolveRuntimeFiles(new Set())
    assert.deepEqual(files, CORE_HARD)
    assert.equal(coreOnly, true)
  })

  it("'core' + new Set(['title']) = + mjs_title.ts SEUL, juste après mjs_element.ts (store/interpolate NON détectés)", () => {
    const b = new Bundler({ runtime: 'core' })
    const { files } = b.resolveRuntimeFiles(new Set(['title']))
    assert.deepEqual(files, CORE_HARD_TITLE)
    assert.equal(files.indexOf('mjs_title.ts'), files.indexOf('mjs_element.ts') + 1)
  })

  it("'core' + new Set(['store', 'interpolate']) = + les deux (+ mjs_ticker.ts et mjs_lifecycle.ts, qui suivent interpolate), SANS title", () => {
    const b = new Bundler({ runtime: 'core' })
    const { files } = b.resolveRuntimeFiles(new Set(['store', 'interpolate']))
    assert.deepEqual(files, ['mjs_init.ts', 'mjs_dom.ts', 'mjs_ticker.ts', 'mjs_interpolate.ts', 'mjs_store.ts', 'mjs_runes.ts', 'mjs_autoloader.ts', 'mjs_element.ts', 'mjs_lifecycle.ts'])
  })

  it("'core' + new Set(['title', 'store', 'interpolate']) = les trois premiers détectés ensemble (+ ticker, + lifecycle) = CORE_TITLE_STORE_INTERP, PAS le CORE historique complet (les modules scan-only restent absents)", () => {
    const b = new Bundler({ runtime: 'core' })
    const { files } = b.resolveRuntimeFiles(new Set(['title', 'store', 'interpolate']))
    assert.deepEqual(files, CORE_TITLE_STORE_INTERP)
  })

  it("['modal'] : mjs_vt_presets.ts ABSENT (ni router ni ujs)", () => {
    const b = new Bundler({ runtime: ['modal'] })
    const { files } = b.resolveRuntimeFiles()
    assert.ok(!files.includes('mjs_vt_presets.ts'))
  })

  it("['router'] : mjs_vt_presets.ts présent, placé AVANT mjs_router.ts", () => {
    const b = new Bundler({ runtime: ['router'] })
    const { files } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_vt_presets.ts'))
    assert.ok(files.indexOf('mjs_vt_presets.ts') < files.indexOf('mjs_router.ts'))
  })

  it("['ujs'] : mjs_vt_presets.ts présent", () => {
    const b = new Bundler({ runtime: ['ujs'] })
    const { files } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_vt_presets.ts'))
  })

  it("['vt_presets'] seul (nom DÉTECTÉ demandé explicitement) : présent, coreOnly true", () => {
    const b = new Bundler({ runtime: ['vt_presets'] })
    const { files, coreOnly } = b.resolveRuntimeFiles()
    assert.ok(files.includes('mjs_vt_presets.ts'))
    assert.equal(coreOnly, true)
  })

  it("['title'] + new Set() : mjs_title.ts présent quand même (explicite gagne sur les faits)", () => {
    const b = new Bundler({ runtime: ['title'] })
    const { files } = b.resolveRuntimeFiles(new Set())
    assert.ok(files.includes('mjs_title.ts'))
  })

  it("['store'] + new Set() : mjs_store.ts présent quand même (explicite gagne sur les faits)", () => {
    const b = new Bundler({ runtime: ['store'] })
    const { files, coreOnly } = b.resolveRuntimeFiles(new Set())
    assert.ok(files.includes('mjs_store.ts'))
    assert.ok(!files.includes('mjs_interpolate.ts'), "'store' seul ne force pas 'interpolate'")
    assert.equal(coreOnly, true)
  })

  it("['interpolate'] + new Set() : mjs_interpolate.ts présent quand même (explicite gagne sur les faits)", () => {
    const b = new Bundler({ runtime: ['interpolate'] })
    const { files, coreOnly } = b.resolveRuntimeFiles(new Set())
    assert.ok(files.includes('mjs_interpolate.ts'))
    assert.ok(!files.includes('mjs_store.ts'), "'interpolate' seul ne force pas 'store'")
    assert.equal(coreOnly, true)
  })

  it("['store', 'interpolate'] : les deux présents, un nom CŒUR (mjs_element.ts) explicite reste un no-op", () => {
    const b = new Bundler({ runtime: ['store', 'interpolate', 'element'] })
    const files = b.resolveRuntimeFiles().files
    assert.ok(files.includes('mjs_store.ts') && files.includes('mjs_interpolate.ts'))
    assert.equal(files.filter(f => f === 'mjs_element.ts').length, 1)
  })

  it('minimalRuntime: true (API directe, sans `runtime`) + new Set() = les 4 fichiers du cœur', () => {
    const b = new Bundler({ minimalRuntime: true })
    const { files } = b.resolveRuntimeFiles(new Set())
    assert.deepEqual(files, CORE_HARD)
  })
})

describe('config — validation stricte du param `runtime`', () => {
  const tmp = (cfg: any) => {
    const root = mjsTmp('rt')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(cfg))
    return root
  }

  it("accepte 'all' / 'core' / un tableau de modules valides", () => {
    assert.equal(findConfig(tmp({ runtime: 'all' }))!.config.runtime, 'all')
    assert.equal(findConfig(tmp({ runtime: 'core' }))!.config.runtime, 'core')
    assert.deepEqual(findConfig(tmp({ runtime: ['router', 'ajax'] }))!.config.runtime, ['router', 'ajax'])
  })

  it('throw sur valeur chaîne invalide', () => {
    assert.throws(() => findConfig(tmp({ runtime: 'minimal' })), /runtime invalide/)
  })

  it('throw sur module inconnu (typo)', () => {
    assert.throws(() => findConfig(tmp({ runtime: ['routr'] })), /module inconnu 'routr'/)
  })

  // 'title'/'vt_presets'/'store'/'interpolate' (DETECTED_CORE_MODULES) : noms EXPLICITES valides
  // en config, distincts des modules optionnels ET du cœur strict — une faute de frappe reste
  // refusée comme n'importe quel autre nom.
  it("accepte les noms DÉTECTÉS 'title'/'vt_presets'/'store'/'interpolate' en config explicite", () => {
    assert.deepEqual(findConfig(tmp({ runtime: ['title', 'vt_presets', 'store', 'interpolate'] }))!.config.runtime, ['title', 'vt_presets', 'store', 'interpolate'])
  })

  it("accepte les 13 noms DÉTECTÉS des balises/runes/blocs détachés depuis ('head'/'body'/'dynamic'/'rare_runes'/'on'/'effect'/'every'/'ticker'/'failed'/'for'/'if'/'key'/'await') en config explicite", () => {
    const nomsDetectes = ['head', 'body', 'dynamic', 'rare_runes', 'on', 'effect', 'every', 'ticker', 'failed', 'for', 'if', 'key', 'await']
    assert.deepEqual(findConfig(tmp({ runtime: nomsDetectes }))!.config.runtime, nomsDetectes)
  })

  it("accepte les 8 noms DÉTECTÉS 'emit'/'lazy_css'/'page_cache'/'context'/'lifecycle'/'layout_variant'/'destroy_hooks'/'alias' en config explicite", () => {
    const nomsDetectes = ['emit', 'lazy_css', 'page_cache', 'context', 'lifecycle', 'layout_variant', 'destroy_hooks', 'alias']
    assert.deepEqual(findConfig(tmp({ runtime: nomsDetectes }))!.config.runtime, nomsDetectes)
  })

  it("throw sur 'hed' (faute de frappe sur 'head', toujours refusée — même garde que 'titre')", () => {
    assert.throws(() => findConfig(tmp({ runtime: ['hed'] })), /module inconnu 'hed'/)
  })

  it("throw sur 'titre' (faute de frappe sur 'title', toujours refusée)", () => {
    assert.throws(() => findConfig(tmp({ runtime: ['titre'] })), /module inconnu 'titre'/)
  })

  it('throw sur un module CŒUR listé (fausse impression de pouvoir le retirer)', () => {
    assert.throws(() => findConfig(tmp({ runtime: ['element'] })), /fait déjà partie du CŒUR/)
  })

  it("'store'/'interpolate' NE lèvent PLUS comme module CŒUR (détachés du cœur strict, embarqués seulement si détectés)", () => {
    assert.doesNotThrow(() => findConfig(tmp({ runtime: ['store'] })))
    assert.doesNotThrow(() => findConfig(tmp({ runtime: ['interpolate'] })))
  })

  it('throw sur type invalide (ni chaîne ni tableau)', () => {
    assert.throws(() => findConfig(tmp({ runtime: 42 })), /runtime doit être/)
  })

  it('throw sur un élément non-chaîne dans le tableau', () => {
    assert.throws(() => findConfig(tmp({ runtime: ['router', 3] })), /doit être une chaîne/)
  })

  it('resolveBundlerOpts transmet `runtime` (sinon option morte, cf. runtimeDir jadis)', () => {
    assert.deepEqual(resolveBundlerOpts({ runtime: ['router'] }, '/tmp').runtime, ['router'])
    assert.equal(resolveBundlerOpts({ runtime: 'core' }, '/tmp').runtime, 'core')
    assert.equal(resolveBundlerOpts({}, '/tmp').runtime, undefined)
  })
})

describe('bundler — build RÉEL du core selon `runtime` (intégration)', function () {
  this.timeout(30000)

  const build = async (runtime: any): Promise<string> => {
    const out = mjsTmp('rtbuild')
    const b = new Bundler({ runtime, outputDir: out, manifestPath: join(out, 'bundle.js') })
    // bundleRuntime() retourne le chemin URL PUBLIC (urlPrefix) ; le fichier
    // réel est écrit dans outputDir sous le même basename haché.
    const hashedPath = await b.bundleRuntime()
    return readFileSync(join(out, basename(hashedPath)), 'utf-8')
  }

  it('la taille du core croît strictement avec la sélection (core < +router < all) et le cœur est toujours là', async () => {
    const core = await build('core')
    const withRouter = await build(['router'])
    const all = await build('all')
    // marqueur cœur robuste (µ.Element = propriété publique, survit au mangle)
    assert.ok(/µ\.Element/.test(core), 'le cœur (µ.Element) est présent même en mode core')
    assert.ok(core.length > 0, 'core non vide')
    // le tree-shake AGIT réellement sur le bundle produit, pas juste sur la liste
    assert.ok(core.length < withRouter.length, `core (${core.length}) doit être < core+router (${withRouter.length})`)
    assert.ok(withRouter.length < all.length, `core+router (${withRouter.length}) doit être < all (${all.length})`)
  })
})
