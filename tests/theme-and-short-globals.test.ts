// sigils.ts MU_SHORT_GLOBALS : 13 formes courtes neuves (µconfirm/µajax/µerror/µconfig
// + µdebug/µlog/µversion/µpageCache/µinterp/µpredict/µinterpolate/µstate/µviewTransition), toutes
// des propriétés µ.* RÉELLES déjà existantes côté runtime (garde de confirmation mjs_ujs.ts,
// client mjs_ajax.ts, logger mjs_journal.ts/mjs_init.ts, config mjs_init.ts, flag debug/helper log
// mjs_init.ts, µ.version, cache LRU de navigation mjs_ujs.ts, fabriques mjs_interp/predict/
// interpolate.ts, rune µ.state mjs_runes.ts, config lue par mjs_router.ts). + µtheme →
// µ.store.__mjsTheme, CALQUE EXACT de µlang (tests/i18n-compile.test.ts) — le sucre COMPILATEUR
// seulement, la clé store elle-même est posée par le runtime (tests/mjs-theme-runtime.test.ts).
// Patron calqué sur tests/sigil-res.test.ts / tests/mu-short-globals.test.ts / tests/i18n-compile.test.ts.

import assert from 'node:assert/strict'
import { tokenize } from '../src/lexer/index.ts'
import { cleanJs } from '../src/generator/utils.ts'
import { transpile } from '../src/transpiler/index.ts'

describe('sigils — µconfirm/µajax/µerror/µconfig (formes courtes)', function () {
  describe('lexer (scripts)', function () {
    it('µconfirm → µ.confirm', () => assert.equal(tokenize("µconfirm('sûr ?')"), "µ.confirm('sûr ?')"))
    it('µajax → µ.ajax', () => assert.equal(tokenize('µajax.get(url)'), 'µ.ajax.get(url)'))
    it('µerror → µ.error', () => assert.equal(tokenize("µerror('oups')"), "µ.error('oups')"))
    it('µconfig → µ.config', () => assert.equal(tokenize('µconfig.i18n'), 'µ.config.i18n'))
    it('identifiants plus longs intacts (µconfirmer/µajaxRequest/µerrorX/µconfiguration)', () => {
      assert.equal(tokenize('µconfirmer'), 'µconfirmer')
      assert.equal(tokenize('µajaxRequest'), 'µajaxRequest')
      assert.equal(tokenize('µerrorX'), 'µerrorX')
      assert.equal(tokenize('µconfiguration'), 'µconfiguration')
    })
  })

  describe('cleanJs (interpolations/handlers)', function () {
    it('µconfirm(msg) → µ.confirm(msg)', () => assert.equal(cleanJs("µconfirm('sûr ?')"), "µ.confirm('sûr ?')"))
    it('µajax.post → µ.ajax.post', () => assert.equal(cleanJs('µajax.post(url, body)'), 'µ.ajax.post(url, body)'))
    it('µerror(e) → µ.error(e)', () => assert.equal(cleanJs('µerror(e)'), 'µ.error(e)'))
    it('µconfig.i18n → µ.config.i18n', () => assert.equal(cleanJs('µconfig.i18n'), 'µ.config.i18n'))
    // ALIGNÉS sur le script (règle universelle : un identifiant qui PROLONGE un nom
    // court n'est PAS exclu, cf. tests/mu-short-globals.test.ts ligne 101 — `µreadFoo
    // → µ.readFoo`) — cleanJs porte désormais le même sucre universel µfoo → µ.foo
    // (sigils.ts, MU_UNIVERSAL_BODY, audit des runes manquantes en expression HTML).
    it('identifiants plus longs, ALIGNÉS sur le script (pointés eux aussi)', () => {
      assert.equal(cleanJs('µconfirmer'), 'µ.confirmer')
      assert.equal(cleanJs('µconfiguration'), 'µ.configuration')
    })
  })
})

describe('sigils — 9 formes courtes supplémentaires (globales runtime déjà existantes)', function () {
  describe('lexer (scripts) — mapping un par un', function () {
    it('µdebug → µ.debug', () => assert.equal(tokenize('if µdebug then log()'), 'if µ.debug then log()'))
    it('µlog → µ.log', () => assert.equal(tokenize("µlog('trace')"), "µ.log('trace')"))
    it('µversion → µ.version', () => assert.equal(tokenize('µversion'), 'µ.version'))
    it('µpageCache → µ.pageCache', () => assert.equal(tokenize('µpageCache.size'), 'µ.pageCache.size'))
    it('µinterp → µ.interp', () => assert.equal(tokenize('µinterp(game, opts)'), 'µ.interp(game, opts)'))
    it('µpredict → µ.predict', () => assert.equal(tokenize('µpredict(game, opts)'), 'µ.predict(game, opts)'))
    it('µinterpolate → µ.interpolate', () => assert.equal(tokenize('µinterpolate(val, dur, min, max)'), 'µ.interpolate(val, dur, min, max)'))
    it('µstate → µ.state', () => assert.equal(tokenize('µstate({})'), 'µ.state({})'))
    it('µviewTransition → µ.viewTransition', () => assert.equal(tokenize('µviewTransition'), 'µ.viewTransition'))
  })

  describe('gardes de frontière — identifiants utilisateur plus longs, jamais la rune', function () {
    it('µinterpX reste utilisateur (pas µ.interpX)', () => assert.equal(tokenize('µinterpX'), 'µinterpX'))
    it('µstateful reste utilisateur (pas µ.stateful)', () => assert.equal(tokenize('µstateful'), 'µstateful'))
    it('µlogger reste utilisateur (pas µ.logger)', () => assert.equal(tokenize('µlogger'), 'µlogger'))
    it('µdebugFlag/µversioned/µpageCacheX/µpredictive/µviewTransitionX restent utilisateur', () => {
      assert.equal(tokenize('µdebugFlag'), 'µdebugFlag')
      assert.equal(tokenize('µversioned'), 'µversioned')
      assert.equal(tokenize('µpageCacheX'), 'µpageCacheX')
      assert.equal(tokenize('µpredictive'), 'µpredictive')
      assert.equal(tokenize('µviewTransitionX'), 'µviewTransitionX')
    })
    it("ordre d'alternance interp/interpolate INDIFFÉRENT (lookahead) : µinterpolate matche bien la forme LONGUE, pas juste le préfixe interp", () => {
      assert.equal(tokenize('µinterpolate(1, 2, 0, 10)'), 'µ.interpolate(1, 2, 0, 10)')
      assert.equal(tokenize('µinterp(g, {})'), 'µ.interp(g, {})')
    })
  })

  describe('cleanJs (interpolations/handlers) — un cas template par famille', function () {
    it('µdebug (condition de template) → µ.debug', () => assert.equal(cleanJs('µdebug'), 'µ.debug'))
    it('µpageCache.size → µ.pageCache.size', () => assert.equal(cleanJs('µpageCache.size'), 'µ.pageCache.size'))
    it('µstate({}) → µ.state({})', () => assert.equal(cleanJs('µstate({})'), 'µ.state({})'))
    it('µviewTransition → µ.viewTransition', () => assert.equal(cleanJs('µviewTransition'), 'µ.viewTransition'))
    // ALIGNÉ sur le script — même détail que µconfirmer/µconfiguration ci-dessus.
    it('identifiant plus long, ALIGNÉ sur le script (µstateful → µ.stateful)', () => assert.equal(cleanJs('µstateful'), 'µ.stateful'))
  })
})

describe('sigils — µtheme → µ.store.__mjsTheme (calque exact de µlang)', function () {
  it("lexer (scripts) : µtheme == 'dark' → µ.store.__mjsTheme == 'dark'", () => {
    assert.equal(tokenize("µtheme == 'dark'"), "µ.store.__mjsTheme == 'dark'")
  })

  it("lexer (scripts) : µtheme = 'light' (écriture) → µ.store.__mjsTheme = 'light'", () => {
    assert.equal(tokenize("µtheme = 'light'"), "µ.store.__mjsTheme = 'light'")
  })

  it('lexer : identifiant plus long intact (µthemeX, µthematique — garde de frontière)', () => {
    assert.equal(tokenize('µthemeX'), 'µthemeX')
    assert.equal(tokenize('µthematique'), 'µthematique')
  })

  it("cleanJs (interpolations/handlers) : {if µtheme == 'dark'} → µ.store.__mjsTheme == 'dark'", () => {
    assert.equal(cleanJs("µtheme == 'dark'"), "µ.store.__mjsTheme == 'dark'")
  })

  it("cleanJs : @click={µtheme = 'dark'} → µ.store.__mjsTheme = 'dark'", () => {
    assert.equal(cleanJs("µtheme = 'dark'"), "µ.store.__mjsTheme = 'dark'")
  })

  it('cleanJs : idempotent sur la forme déjà pointée', () => {
    assert.equal(cleanJs('µ.store.__mjsTheme'), 'µ.store.__mjsTheme')
  })

  it("transpile bout-en-bout : lecture µtheme dans une interpolation → µ.store.__mjsTheme (dépendance $$__mjsTheme via l'analyzer, µ.store.x générique)", async () => {
    const src = '<p>{µtheme}</p>'
    const { output } = await transpile(src, { moduleName: 'mjs-theme-read-tpl' })
    assert.match(output, /µ\.store\.__mjsTheme/)
  })

  it("transpile bout-en-bout : écriture µtheme = 'dark' dans un handler → µ._storeSet(\"__mjsTheme\", 'dark') (réécriture path-tracker existante, aucune plomberie dédiée)", async () => {
    const src = "<button @click={µtheme = 'dark'}>Sombre</button>"
    const { output } = await transpile(src, { moduleName: 'mjs-theme-write-handler' })
    assert.match(output, /µ\._storeSet\("__mjsTheme", 'dark'\)/)
  })
})
