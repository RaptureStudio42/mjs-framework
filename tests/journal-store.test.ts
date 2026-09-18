// journal-store — étage 1 du journal d'erreurs 3 étages (src/server/journal.ts). Magasin
// NDJSON PAR SOURCE (server/client) : groupement par signature (jamais une ligne par occurrence),
// plafonds entries/bytes (purge FIFO du plus vieux `dernier`), tolérance à la corruption, écriture
// atomique DÉBOUNCÉE (flush() la rend synchrone pour les assertions), jamais un throw.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createJournal } from '../src/server/journal.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

// l'ecriture du journal est DEBOUNCEE (~1 s, timer unref). Un journal laisse
// sans flush par un test voit son timer se declencher APRES le menage des dossiers temporaires, et
// RECREE son dossier — 12 dossiers /tmp/mjs-journal-* survivaient a chaque passage. D'ou ce
// registre : tout journal cree ici est vide en fin de test, avant que le balai ne passe.
const journals: ReturnType<typeof createJournal>[] = []

function makeJournal(opts: Parameters<typeof createJournal>[0]): ReturnType<typeof createJournal> {
  const j = createJournal(opts)
  journals.push(j)
  return j
}

afterEach(() => {
  // close() (jamais flush() seul) : flush() solde l'ecriture mais LAISSE le journal dans le hook
  // 'exit', qui rejouerait un differe posterieur et recreerait le dossier — c'est exactement le
  // scenario prouve par tests/journal-close.test.ts
  for (const j of journals) { try { j.close() } catch { /* best-effort */ } }
  journals.length = 0
})

after(() => sweepRegistered())

describe('journal — magasin NDJSON (src/server/journal.ts)', () => {
  it('groupement par signature : occurrences répétées → n++, dernier mis à jour, premier inchangé', () => {
    const dir = mjsTmp('journal-group')
    const j = makeJournal({ dir })
    j.record('server', { message: 'boom', pile: 'Error: boom\n  at x', url: '/a' })
    const premiereListe = j.list()
    assert.equal(premiereListe.length, 1)
    const premier = premiereListe[0].premier
    j.record('server', { message: 'boom', pile: 'Error: boom\n  at x', url: '/a' })
    j.record('server', { message: 'boom', pile: 'Error: boom\n  at x', url: '/a' })
    const liste = j.list()
    assert.equal(liste.length, 1, 'une SEULE ligne pour 3 occurrences de la même signature')
    assert.equal(liste[0].n, 3)
    assert.equal(liste[0].premier, premier, 'premier ne bouge jamais après la 1ère occurrence')
    assert.ok(liste[0].dernier >= premier, 'dernier avance (ou égal, horloge grossière)')
  })

  it('signatures DIFFÉRENTES (message, url, ou 1ère ligne de pile) → lignes séparées', () => {
    const dir = mjsTmp('journal-sig')
    const j = makeJournal({ dir })
    j.record('server', { message: 'a', pile: 'X', url: '/1' })
    j.record('server', { message: 'b', pile: 'X', url: '/1' })
    j.record('server', { message: 'a', pile: 'X', url: '/2' })
    j.record('server', { message: 'a', pile: 'Y', url: '/1' })
    assert.equal(j.list().length, 4)
  })

  it('server et client sont deux magasins INDÉPENDANTS (même signature textuelle, sources différentes)', () => {
    const dir = mjsTmp('journal-src')
    const j = makeJournal({ dir })
    j.record('server', { message: 'x', pile: '', url: '/x' })
    j.record('client', { message: 'x', pile: '', url: '/x' })
    const liste = j.list()
    assert.equal(liste.length, 2)
    assert.deepEqual(liste.map((e) => e.source).sort(), ['client', 'server'])
    liste.forEach((e) => assert.equal(e.n, 1))
  })

  it('list() fusionne server+client, trié par `dernier` DESC', async () => {
    const dir = mjsTmp('journal-sort')
    const j = makeJournal({ dir })
    j.record('server', { message: 'premier', url: '/1' })
    await new Promise((r) => setTimeout(r, 5))
    j.record('client', { message: 'second', url: '/2' })
    await new Promise((r) => setTimeout(r, 5))
    j.record('server', { message: 'troisieme', url: '/3' })
    const liste = j.list()
    assert.deepEqual(liste.map((e) => e.message), ['troisieme', 'second', 'premier'])
  })

  it('plafond maxEntries : purge FIFO — retire la (les) entrée(s) au `dernier` le plus ANCIEN', async () => {
    const dir = mjsTmp('journal-cap-entries')
    const j = makeJournal({ dir, maxEntries: 2 })
    j.record('server', { message: 'e1', url: '/1' })
    await new Promise((r) => setTimeout(r, 5))
    j.record('server', { message: 'e2', url: '/2' })
    await new Promise((r) => setTimeout(r, 5))
    j.record('server', { message: 'e3', url: '/3' })
    const liste = j.list()
    assert.equal(liste.length, 2, 'jamais plus de maxEntries')
    assert.deepEqual(liste.map((e) => e.message).sort(), ['e2', 'e3'], 'e1 (le plus ancien dernier) est parti')
  })

  it('plafond maxBytes : purge FIFO jusqu\'à repasser sous la limite', () => {
    const dir = mjsTmp('journal-cap-bytes')
    // chaque ligne pèse largement plus que 400 octets (pile de 300 caractères) — 5 entrées
    // dépassent sûrement un plafond de 900 octets, sans dépendre d'un calcul de taille exact.
    const j = makeJournal({ dir, maxEntries: 1000, maxBytes: 900 })
    for (let i = 0; i < 5; i++) {
      j.record('server', { message: 'msg' + i, pile: 'x'.repeat(300), url: '/' + i })
    }
    j.flush()
    const contenu = readFileSync(join(dir, 'mjs-errors-server.ndjson'), 'utf-8')
    assert.ok(Buffer.byteLength(contenu, 'utf-8') <= 900 + 512, 'le fichier reste borné (marge : la dernière entrée gardée peut dépasser légèrement)')
    assert.ok(j.list().length < 5, 'au moins une entrée a été évincée')
  })

  it('corruption tolérée : lignes JSON invalides ignorées, les lignes valides survivent', () => {
    const dir = mjsTmp('journal-corrupt')
    mkdirSync(dir, { recursive: true })
    const valide = { ts: 1, source: 'server', signature: 'ok\n\n/x', message: 'ok', pile: '', url: '/x', version: null, n: 1, premier: 1, dernier: 1 }
    const contenu = '{"json invalide sans fermeture\n' + JSON.stringify(valide) + '\n\n[1,2,3]\n"une simple chaine JSON valide mais pas un objet"\n'
    writeFileSync(join(dir, 'mjs-errors-server.ndjson'), contenu, 'utf-8')
    const j = makeJournal({ dir })
    const liste = j.list()
    assert.equal(liste.length, 1, 'seule la ligne objet valide doit survivre')
    assert.equal(liste[0].message, 'ok')
  })

  it('fichier absent au démarrage : list() vide, aucun crash', () => {
    const dir = mjsTmp('journal-absent')
    const j = makeJournal({ dir })
    assert.deepEqual(j.list(), [])
    assert.equal(existsSync(join(dir, 'mjs-errors-server.ndjson')), false, 'rien créé tant que rien n\'est écrit (paresseux)')
  })

  it('écriture atomique observée : flush() produit un fichier NDJSON valide (1 objet JSON par ligne)', () => {
    const dir = mjsTmp('journal-atomic')
    const j = makeJournal({ dir })
    j.record('server', { message: 'a', url: '/a' })
    j.record('server', { message: 'b', url: '/b' })
    j.flush()
    const lignes = readFileSync(join(dir, 'mjs-errors-server.ndjson'), 'utf-8').split('\n').filter((l) => l.trim())
    assert.equal(lignes.length, 2)
    for (const l of lignes) assert.doesNotThrow(() => JSON.parse(l))
    // aucun résidu de fichier temporaire (tmp + rename atomique, jamais de .tmp-* qui traîne)
    const restants = readdirSync(dir).filter((f) => f.includes('.tmp-'))
    assert.deepEqual(restants, [])
  })

  it('purge(\'server\') : ne touche QUE server, client survit', () => {
    const dir = mjsTmp('journal-purge-source')
    const j = makeJournal({ dir })
    j.record('server', { message: 's', url: '/s' })
    j.record('client', { message: 'c', url: '/c' })
    j.purge('server')
    const liste = j.list()
    assert.equal(liste.length, 1)
    assert.equal(liste[0].source, 'client')
  })

  it('purge() sans argument (ou null) : purge TOUT', () => {
    const dir = mjsTmp('journal-purge-all')
    const j = makeJournal({ dir })
    j.record('server', { message: 's', url: '/s' })
    j.record('client', { message: 'c', url: '/c' })
    j.purge()
    assert.deepEqual(j.list(), [])
    j.record('server', { message: 's2', url: '/s2' })
    j.record('client', { message: 'c2', url: '/c2' })
    j.purge(null)
    assert.deepEqual(j.list(), [])
  })

  it('purge() écrit un fichier vide sur disque (flush)', () => {
    const dir = mjsTmp('journal-purge-flush')
    const j = makeJournal({ dir })
    j.record('server', { message: 's', url: '/s' })
    j.flush()
    assert.ok(readFileSync(join(dir, 'mjs-errors-server.ndjson'), 'utf-8').trim().length > 0)
    j.purge('server')
    j.flush()
    assert.equal(readFileSync(join(dir, 'mjs-errors-server.ndjson'), 'utf-8').trim(), '')
  })

  it('jamais de throw : répertoire imperceptible à créer (un FICHIER occupe déjà l\'emplacement) → flush() silencieux, un seul console.warn', () => {
    const root = mjsTmp('journal-rofs')
    const logPath = join(root, 'log')
    writeFileSync(logPath, 'je suis un fichier, pas un dossier', 'utf-8')
    const j = makeJournal({ dir: logPath })
    const originalWarn = console.warn
    const appels: any[] = []
    console.warn = (...args: any[]) => { appels.push(args) }
    try {
      assert.doesNotThrow(() => j.record('server', { message: 'x', url: '/x' }))
      assert.doesNotThrow(() => j.flush())
      assert.doesNotThrow(() => j.record('server', { message: 'y', url: '/y' }))
      assert.doesNotThrow(() => j.flush())
      assert.doesNotThrow(() => j.purge())
      assert.equal(appels.length, 1, 'UN SEUL warn pour toute la session, malgré plusieurs échecs')
    } finally {
      console.warn = originalWarn
      // l'ecriture reste DIRTY tant que le fichier bloque l'emplacement, et le hook de sortie du
      // process la rejouerait APRES le menage — recreant le dossier temporaire. On degage donc
      // l'obstacle et on solde le journal ici, une fois les assertions faites.
      rmSync(logPath, { force: true })
      j.flush()
    }
  })

  it('défauts : maxEntries 200 / maxBytes 1 048 576 si non fournis (aucun plafond prématuré)', () => {
    const dir = mjsTmp('journal-defaults')
    const j = makeJournal({ dir })
    for (let i = 0; i < 150; i++) j.record('server', { message: 'msg' + i, url: '/' + i })
    assert.equal(j.list().length, 150, 'largement sous 200 : rien évincé')
  })

  it('champs optionnels absents (pile/version/ua) : record() ne crash pas, valeurs par défaut sensées', () => {
    const dir = mjsTmp('journal-optional')
    const j = makeJournal({ dir })
    assert.doesNotThrow(() => j.record('server', { message: 'sans-rien' } as any))
    const e = j.list()[0]
    assert.equal(e.message, 'sans-rien')
    assert.equal(e.pile, '')
    assert.equal(e.url, '')
    assert.equal(e.version, null)
  })

  it('version/ua rafraîchis sur récurrence (même signature, nouveau signalement)', () => {
    const dir = mjsTmp('journal-refresh')
    const j = makeJournal({ dir })
    j.record('server', { message: 'x', url: '/x', version: 'aaaaaaaa' })
    j.record('server', { message: 'x', url: '/x', version: 'bbbbbbbb' })
    assert.equal(j.list()[0].version, 'bbbbbbbb')
  })

  it('message STOCKÉ garde son texte intégral (jusqu\'à 2048 c.) même si la SIGNATURE ne groupe que sur les 300 premiers', () => {
    const dir = mjsTmp('journal-msg-vs-sig')
    const j = makeJournal({ dir })
    const base = 'x'.repeat(300)
    j.record('server', { message: base + '-variante-A', url: '/m' })
    j.record('server', { message: base + '-variante-B', url: '/m' })
    const liste = j.list()
    assert.equal(liste.length, 1, 'les 300 premiers caractères + url sont identiques → même signature, groupées')
    assert.equal(liste[0].n, 2)
    assert.equal(liste[0].message, base + '-variante-A', 'le texte STOCKÉ est celui du 1er signalement, en entier (pas coupé à 300)')
  })
})
