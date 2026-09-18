// i18n façon Rails — volet CONFIG + BUILD.
// Contrat FIGÉ avec le runtime `mjs_i18n.ts` (src/runtime/mjs_i18n.ts, livré en
// parallèle) : `µ._i18nData = { dev, default, placeholder, root, sections }`.
//
// Couvre :
//   1. validation stricte du bloc `i18n` (mjs.config.json) — clés connues,
//      `placeholder` ∈ auto|key|wait, `hash` booléen ;
//   2. règle croisée `sourceDir/i18n/` ↔ `i18n.default` (erreur / warning) ;
//   3. scan + émission (racine embarquée, fragments de section écrits) ;
//   4. obfuscation prod (hash aléatoire par build, `hash:false`, dev toujours
//      clair), µ._i18nData absent si pas d'i18n dans le projet.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { findConfig } from '../src/bundler/config.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

function mkProject(): { root: string; srcDir: string; outDir: string } {
  const root = mjsTmp('i18n')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir }
}

// Peuple `srcDir/i18n/` : racine fr.yml + en.json, sections fr/panier.yml + en/panier.json.
function seedI18nDict(srcDir: string): void {
  const i18nDir = join(srcDir, 'i18n')
  mkdirSync(join(i18nDir, 'fr'), { recursive: true })
  mkdirSync(join(i18nDir, 'en'), { recursive: true })
  writeFileSync(join(i18nDir, 'fr.yml'), `bonjour: Bonjour\nau_revoir: Au revoir\n`)
  writeFileSync(join(i18nDir, 'en.json'), JSON.stringify({ bonjour: 'Hello', au_revoir: 'Goodbye' }))
  writeFileSync(join(i18nDir, 'fr/panier.yml'), `titre: Mon panier\nvide: Panier vide\n`)
  writeFileSync(join(i18nDir, 'en/panier.json'), JSON.stringify({ titre: 'My cart', vide: 'Empty cart' }))
}

// Peuple `srcDir/i18n/` en JSON UNIQUEMENT (aucun .yml/.yaml) — pour vérifier
// que le chargeur yaml (paresseux) n'est jamais sollicité.
function seedI18nDictJsonOnly(srcDir: string): void {
  const i18nDir = join(srcDir, 'i18n')
  mkdirSync(join(i18nDir, 'fr'), { recursive: true })
  mkdirSync(join(i18nDir, 'en'), { recursive: true })
  writeFileSync(join(i18nDir, 'fr.json'), JSON.stringify({ bonjour: 'Bonjour', au_revoir: 'Au revoir' }))
  writeFileSync(join(i18nDir, 'en.json'), JSON.stringify({ bonjour: 'Hello', au_revoir: 'Goodbye' }))
  writeFileSync(join(i18nDir, 'fr/panier.json'), JSON.stringify({ titre: 'Mon panier', vide: 'Panier vide' }))
  writeFileSync(join(i18nDir, 'en/panier.json'), JSON.stringify({ titre: 'My cart', vide: 'Empty cart' }))
}

// Bloc i18n TEL QUE LE VOIT LE RUNTIME : réglages `µ._i18nData` du manifeste +
// `root`/`sections` relus dans les fichiers de langue (`files`), qui les portent
// depuis qu'ils ont quitté le manifeste. `sections` est rendue sous sa forme
// D'URL ENTIÈRE, celle que le runtime reconstitue à partir de `prefix` — les
// scénarios ci-dessous restent écrits en URLs.
function readI18nData(manifestPath: string, outDir?: string): any {
  const content = readFileSync(manifestPath, 'utf-8')
  const m = content.match(/µ\._i18nData = (\{.*?\});/)
  if (!m) return undefined
  const data = JSON.parse(m[1])
  if (!outDir) return data
  data.root = {}
  data.sections = {}
  for (const [lang, url] of Object.entries<string>(data.files ?? {})) {
    const src = readFileSync(join(outDir, url.split('/').pop()!), 'utf-8')
    const fichier = JSON.parse(src.replace(/^export default /, '').replace(/;\n?$/, ''))
    data.root[lang] = fichier.root
    data.sections[lang] = Object.fromEntries(
      Object.entries<string>(fichier.sections).map(([section, nom]) => [section, `${data.prefix}/${lang}/${nom}.json`]),
    )
  }
  return data
}

describe('mjs.config.json — clé `i18n` (validation stricte)', () => {
  const tmp = (cfg: any) => {
    const root = mjsTmp('i18n-cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(cfg))
    return root
  }

  it("accepte i18n: { default, placeholder, hash } valides", () => {
    const root = tmp({ i18n: { default: 'fr', placeholder: 'key', hash: false } })
    const found = findConfig(root)
    assert.ok(found)
    assert.deepEqual(found!.config.i18n, { default: 'fr', placeholder: 'key', hash: false })
  })

  it('throw sur clé inconnue dans i18n.X', () => {
    const root = tmp({ i18n: { defaut: 'fr' } })
    assert.throws(() => findConfig(root), /i18n\.defaut : clé inconnue/)
  })

  it('throw sur placeholder invalide', () => {
    const root = tmp({ i18n: { default: 'fr', placeholder: 'inline' } })
    assert.throws(() => findConfig(root), /i18n\.placeholder invalide/)
  })

  it('throw sur hash non booléen', () => {
    const root = tmp({ i18n: { default: 'fr', hash: 'true' } })
    assert.throws(() => findConfig(root), /i18n\.hash doit être un booléen/)
  })

  it('throw sur default vide/non-string', () => {
    const root1 = tmp({ i18n: { default: '' } })
    assert.throws(() => findConfig(root1), /i18n\.default doit être une chaîne non vide/)
    const root2 = tmp({ i18n: { default: 42 } })
    assert.throws(() => findConfig(root2), /i18n\.default doit être une chaîne non vide/)
  })

  it("throw sur i18n non-objet (ex. \"fr\")", () => {
    const root = tmp({ i18n: 'fr' })
    assert.throws(() => findConfig(root), /'i18n' doit être un objet/)
  })
})

describe('bundler — i18n/ présent ↔ i18n.default (règle croisée)', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  it("i18n/ présent SANS i18n.default → erreur de build explicite", async () => {
    const { srcDir, outDir, root } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    try {
      const stats = await bundler.compile()
      assert.ok(stats.errors.length > 0, 'devrait échouer')
      assert.ok(
        stats.errors.some(e => /i18n\/ présent : précise i18n\.default/.test(e.message)),
        stats.errors.map(e => e.message).join('\n'),
      )
    } finally {
      await bundler.close()
    }
  })

  it("i18n configuré SANS dossier i18n/ → warning non bloquant, build réussit quand même", async () => {
    const { srcDir, outDir, root } = mkProject()
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' } })
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      assert.ok(
        stats.warnings.some(w => /config\.i18n renseigné mais/.test(w)),
        stats.warnings.join('\n'),
      )
      assert.equal(readI18nData(join(root, 'bundle.js'), outDir), undefined, 'zéro octet i18n si pas de dossier i18n/')
    } finally {
      await bundler.close()
    }
  })
})

describe('bundler — scan + émission (racine + fragments)', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  it('racine (yml + json) embarquée dans le manifeste, fragments émis fidèlement', async () => {
    const { srcDir, outDir, root } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' } })
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const data = readI18nData(join(root, 'bundle.js'), outDir)
      assert.ok(data, 'µ._i18nData doit être émis')
      assert.equal(data.dev, true)
      assert.equal(data.default, 'fr')
      assert.equal(data.placeholder, 'auto')
      assert.deepEqual(data.root.fr, { bonjour: 'Bonjour', au_revoir: 'Au revoir' })
      assert.deepEqual(data.root.en, { bonjour: 'Hello', au_revoir: 'Goodbye' })
      assert.ok(data.sections.fr.panier, 'section fr.panier attendue')
      assert.ok(data.sections.en.panier, 'section en.panier attendue')
      // dev : noms clairs (panier.json)
      assert.match(data.sections.fr.panier, /\/i18n\/fr\/panier\.json$/)
      assert.match(data.sections.en.panier, /\/i18n\/en\/panier\.json$/)
      // contenu du fragment fidèle à la source
      const frFragmentPath = join(outDir, 'i18n', 'fr', 'panier.json')
      assert.ok(existsSync(frFragmentPath))
      assert.deepEqual(JSON.parse(readFileSync(frFragmentPath, 'utf-8')), { titre: 'Mon panier', vide: 'Panier vide' })
      const enFragmentPath = join(outDir, 'i18n', 'en', 'panier.json')
      assert.deepEqual(JSON.parse(readFileSync(enFragmentPath, 'utf-8')), { titre: 'My cart', vide: 'Empty cart' })
    } finally {
      await bundler.close()
    }
  })

  it('YAML invalide → erreur de build claire (fichier + cause)', async () => {
    const { srcDir, outDir, root } = mkProject()
    mkdirSync(join(srcDir, 'i18n'), { recursive: true })
    writeFileSync(join(srcDir, 'i18n/fr.yml'), `bonjour: [invalide\n`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' } })
    try {
      const stats = await bundler.compile()
      assert.ok(stats.errors.length > 0)
      assert.ok(stats.errors.some(e => /i18n : fichier invalide/.test(e.message) && /fr\.yml/.test(e.message)))
    } finally {
      await bundler.close()
    }
  })

  it('nom de section invalide (majuscule) → erreur de build claire', async () => {
    const { srcDir, outDir, root } = mkProject()
    mkdirSync(join(srcDir, 'i18n/fr'), { recursive: true })
    writeFileSync(join(srcDir, 'i18n/fr/Panier.yml'), `titre: x\n`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' } })
    try {
      const stats = await bundler.compile()
      assert.ok(stats.errors.length > 0)
      assert.ok(stats.errors.some(e => /nom de section invalide 'Panier'/.test(e.message)))
    } finally {
      await bundler.close()
    }
  })

  it("µ._i18nData absent du manifest si pas de dossier i18n/ (zéro octet)", async () => {
    const { srcDir, outDir, root } = mkProject()
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const content = readFileSync(join(root, 'bundle.js'), 'utf-8')
      assert.ok(!content.includes('_i18nData'), 'aucune trace de µ._i18nData sans i18n/')
    } finally {
      await bundler.close()
    }
  })
})

describe('bundler — obfuscation prod (hash md5 du contenu, stable si contenu inchangé)', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  it('prod (forceMinify) : noms de fragments hachés (32 hex) + mapping cohérent', async () => {
    const { srcDir, outDir, root } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' }, forceMinify: true })
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const data = readI18nData(join(root, 'bundle.js'), outDir)
      assert.equal(data.dev, false)
      const m = data.sections.fr.panier.match(/\/i18n\/fr\/([a-f0-9]{32})\.json$/)
      assert.ok(m, `nom haché attendu, reçu : ${data.sections.fr.panier}`)
      assert.ok(existsSync(join(outDir, 'i18n', 'fr', `${m![1]}.json`)))
    } finally {
      await bundler.close()
    }
  })

  it('deux builds prod SANS modification donnent des noms de fragments IDENTIQUES (hash de contenu, pas aléatoire)', async () => {
    const { srcDir, outDir, root } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' }, forceMinify: true })
    try {
      await bundler.compile()
      const first = readI18nData(join(root, 'bundle.js'), outDir).sections.fr.panier
      await bundler.compile()
      const second = readI18nData(join(root, 'bundle.js'), outDir).sections.fr.panier
      assert.equal(first, second, 'même contenu ⇒ même hash ⇒ même nom, quel que soit le nombre de builds (cache navigateur préservé)')
    } finally {
      await bundler.close()
    }
  })

  it("modification du contenu d'UNE section ⇒ SEUL son nom change, les autres restent stables", async () => {
    const { srcDir, outDir, root } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' }, forceMinify: true })
    try {
      await bundler.compile()
      const before = readI18nData(join(root, 'bundle.js'), outDir)
      const frPanierBefore = before.sections.fr.panier
      const enPanierBefore = before.sections.en.panier

      // seule la section fr/panier change de contenu
      writeFileSync(join(srcDir, 'i18n/fr/panier.yml'), `titre: Mon panier (v2)\nvide: Panier vide\n`)
      await bundler.compile()
      const after = readI18nData(join(root, 'bundle.js'), outDir)

      assert.notEqual(after.sections.fr.panier, frPanierBefore, 'contenu modifié ⇒ nom nouveau')
      assert.equal(after.sections.en.panier, enPanierBefore, 'section non touchée ⇒ nom inchangé')
    } finally {
      await bundler.close()
    }
  })

  it("hash:false en prod → noms clairs (pas de hachage)", async () => {
    const { srcDir, outDir, root } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr', hash: false }, forceMinify: true })
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const data = readI18nData(join(root, 'bundle.js'), outDir)
      assert.match(data.sections.fr.panier, /\/i18n\/fr\/panier\.json$/)
    } finally {
      await bundler.close()
    }
  })

  it('dev (pas de forceMinify) : noms clairs toujours, même avec i18n.hash non posé', async () => {
    const { srcDir, outDir, root } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' } })
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const data = readI18nData(join(root, 'bundle.js'), outDir)
      assert.equal(data.dev, true)
      assert.match(data.sections.fr.panier, /\/i18n\/fr\/panier\.json$/)
    } finally {
      await bundler.close()
    }
  })
})

describe('bundler — yaml OPTIONNELLE (paquet `yaml` en peerDependency)', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  it('projet 100% .json : build réussit SANS jamais solliciter le chargeur yaml', async () => {
    const { srcDir, outDir, root } = mkProject()
    seedI18nDictJsonOnly(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' } })
    // couture testable : si le chargeur yaml est sollicité, le test échoue —
    // un projet 100% .json ne doit JAMAIS tenter le require('yaml').
    ;(bundler as any)._loadYamlParser = () => { throw new Error('_loadYamlParser ne devrait jamais être appelé sur un projet 100% .json') }
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const data = readI18nData(join(root, 'bundle.js'), outDir)
      assert.deepEqual(data.root.fr, { bonjour: 'Bonjour', au_revoir: 'Au revoir' })
      assert.ok(data.sections.fr.panier, 'section fr.panier attendue')
    } finally {
      await bundler.close()
    }
  })

  it("paquet 'yaml' absent : erreur de build explicite invitant à l'installer ou à passer en .json", async () => {
    const { srcDir, outDir, root } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' } })
    // simule l'absence du paquet optionnel (couture _loadYamlParser)
    ;(bundler as any)._loadYamlParser = () => {
      throw new Error(`[bundler] i18n : dictionnaire YAML détecté (i18n/fr.yml) mais le paquet 'yaml' n'est pas installé — installe-le (npm i -D yaml) ou convertis tes dictionnaires en .json`)
    }
    try {
      const stats = await bundler.compile()
      assert.ok(stats.errors.length > 0, 'devrait échouer')
      assert.ok(
        stats.errors.some(e => /paquet 'yaml' n'est pas installé/.test(e.message) && /npm i -D yaml/.test(e.message) && /\.json/.test(e.message)),
        stats.errors.map(e => e.message).join('\n'),
      )
    } finally {
      await bundler.close()
    }
  })

  it('chemin .yml nominal (paquet présent) : parsing YAML fonctionne toujours', async () => {
    const { srcDir, outDir, root } = mkProject()
    seedI18nDict(srcDir)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), i18n: { default: 'fr' } })
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const data = readI18nData(join(root, 'bundle.js'), outDir)
      assert.deepEqual(data.root.fr, { bonjour: 'Bonjour', au_revoir: 'Au revoir' })
    } finally {
      await bundler.close()
    }
  })
})

// Déterminisme — `readdirSync`
// (racine i18n/ + fragments par langue) NE GARANTIT AUCUN ORDRE, contrairement
// aux autres `readdirSync` sensibles du fichier (cf. ~2209, commentaire jumeau
// « casse les builds reproductibles »). Sans `.sort()`, l'ordre de
// `i18nManifestData.root`/`.sections` (→ `JSON.stringify` dans le manifest,
// nom FIXE non haché) dépend de l'OS/du filesystem. Vérifié directement via
// `scanI18n()` (pas besoin de tout `compile()`) : les clés doivent sortir
// alphabétiquement quel que soit l'ordre d'écriture disque.
describe('bundler — déterminisme i18n (readdirSync triée)', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  it('langues racine (root) et sections triées alphabétiquement, peu importe l\'ordre d\'écriture', () => {
    const { srcDir, outDir } = mkProject()
    const i18nDir = join(srcDir, 'i18n')
    // écrites volontairement DANS LE DÉSORDRE (zz, aa, mm) — le tri doit
    // produire aa < mm < zz indépendamment de cet ordre d'écriture.
    mkdirSync(join(i18nDir, 'zz'), { recursive: true })
    mkdirSync(join(i18nDir, 'aa'), { recursive: true })
    mkdirSync(join(i18nDir, 'mm'), { recursive: true })
    writeFileSync(join(i18nDir, 'zz.json'), JSON.stringify({ k: 'z' }))
    writeFileSync(join(i18nDir, 'aa.json'), JSON.stringify({ k: 'a' }))
    writeFileSync(join(i18nDir, 'mm.json'), JSON.stringify({ k: 'm' }))
    // fragments de section eux-mêmes dans le désordre : zebra, apple, mango
    writeFileSync(join(i18nDir, 'aa/zebra.json'), JSON.stringify({ x: 1 }))
    writeFileSync(join(i18nDir, 'aa/apple.json'), JSON.stringify({ x: 2 }))
    writeFileSync(join(i18nDir, 'aa/mango.json'), JSON.stringify({ x: 3 }))
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, i18n: { default: 'aa' } })
    const { warnings } = bundler.scanI18n()
    assert.equal(warnings.length, 0, warnings.join('\n'))
    const data = bundler.i18nManifestData!
    assert.deepEqual(Object.keys(data.root), ['aa', 'mm', 'zz'])
    assert.deepEqual(Object.keys(data.sections), ['aa'])
    assert.deepEqual(Object.keys(data.sections.aa), ['apple', 'mango', 'zebra'])
  })
})
