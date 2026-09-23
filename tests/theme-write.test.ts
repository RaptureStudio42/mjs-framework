// theme-write — l'atelier /__mjs/theme ENREGISTRE la couleur dans le fichier qui la déclare
// — ce que tu vois devient ce qui est. L'aperçu en direct, lui,
// ne touche toujours rien (cf. theme-edit-live.test.ts) : ce sont deux routes distinctes.
//
// Ce que la suite tient :
//   - la ligne réécrite garde son indentation, son nom, son point-virgule et son commentaire —
//     seule la tranche de la valeur bouge ;
//   - le numéro de ligne du registre ne fait JAMAIS autorité : il est revérifié contre le
//     fichier réel, et un registre périmé fait retomber sur un balayage qui n'accepte qu'un
//     résultat unique (socle § 7 — un prédicat qui tombe ne doit pas ressembler à un succès) ;
//   - un chemin qui sort du projet, une valeur qui n'est pas une couleur, une page d'une autre
//     origine : trois refus, chacun NOMMÉ, et le fichier visé reste intact.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { StaticServer } from '../src/server/index.js'
import { findThemeDecls, rewriteThemeValue } from '../src/server/theme-write.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

after(() => sweepRegistered())

const portDe = (s: StaticServer) => (s.server!.address() as any).port

/** Projet jetable : une racine, un fichier source dedans, le serveur branché sur la racine. */
function projet(prefix: string, fichiers: Record<string, string>, opts: Record<string, unknown> = {}) {
  const root = mjsTmp(prefix)
  for (const [nom, contenu] of Object.entries(fichiers)) {
    const chemin = join(root, nom)
    mkdirSync(join(chemin, '..'), { recursive: true })
    writeFileSync(chemin, contenu)
  }
  const server = new StaticServer({ rootDir: root, projectRoot: root, port: 0, host: '127.0.0.1', hmr: true, ...opts })
  return { root, server }
}

// Origin locale PAR DÉFAUT : une vraie page de l'atelier, dans un navigateur, en envoie
// toujours une valide — seuls les tests qui exercent SPÉCIFIQUEMENT la garde d'origine
// (absente ou étrangère) l'écrasent explicitement via `entetes`.
async function ecrire(port: number, corps: Record<string, unknown>, entetes: Record<string, string> = { Origin: 'http://127.0.0.1' }) {
  const res = await fetch(`http://127.0.0.1:${port}/__mjs/theme/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...entetes },
    body: JSON.stringify(corps),
  })
  return { status: res.status, corps: res.status === 200 ? await res.json() as any : null }
}

describe('theme-write — repérage de la déclaration dans le source', () => {
  it('réécrit un $$ de bloc <theme> sans toucher à l\'indentation ni au commentaire', () => {
    const src = '<theme>\n  $$accent: #3b82f6   // la couleur de marque\n  $$fg: #111\n</theme>\n'
    const out = rewriteThemeValue(src, 'accent', 'mjs', '#ff0000')
    assert.equal(out.ok, true)
    assert.equal(out.line, 2)
    assert.equal(out.before, '#3b82f6')
    assert.equal(out.source.split('\n')[1], '  $$accent: #ff0000   // la couleur de marque')
  })

  it('réécrit une custom property BRUTE d\'un <style>, point-virgule conservé', () => {
    const src = ':root {\n  --mjs-check-accent: var(--mjs-accent, #3b82f6);\n}\n'
    const out = rewriteThemeValue(src, 'check-accent', 'mjs', '#00ff00')
    assert.equal(out.ok, true)
    assert.equal(out.before, 'var(--mjs-accent, #3b82f6)')
    assert.equal(out.source.split('\n')[1], '  --mjs-check-accent: #00ff00;')
  })

  it('applique le varPrefix du projet, pas un « mjs » codé en dur', () => {
    const src = '  --acme-accent: #000\n'
    assert.equal(rewriteThemeValue(src, 'accent', 'acme', '#fff').ok, true)
    assert.equal(rewriteThemeValue(src, 'accent', 'mjs', '#fff').reason, 'introuvable')
  })

  it('une LECTURE n\'est jamais prise pour une déclaration', () => {
    // `color: $$accent` lit la variable ; seule une ligne qui OUVRE sur le nom la déclare
    const src = '.titre\n  color: $$accent\n  border-color: var(--mjs-accent)\n'
    assert.deepEqual(findThemeDecls(src, 'accent', 'mjs'), [])
    assert.equal(rewriteThemeValue(src, 'accent', 'mjs', '#fff').reason, 'introuvable')
  })

  it('deux déclarations (clair et sombre) : la ligne du registre tranche', () => {
    const src = '[data-theme=light]\n  $$bg: #ffffff\n\n[data-theme=dark]\n  $$bg: #111111\n'
    const sombre = rewriteThemeValue(src, 'bg', 'mjs', '#000000', 5)
    assert.equal(sombre.ok, true)
    assert.equal(sombre.line, 5)
    assert.equal(sombre.source.split('\n')[1], '  $$bg: #ffffff', 'le thème clair n\'a pas bougé')
  })

  it('SANS ligne utilisable, deux candidates = REFUS ambigu, jamais un choix au hasard', () => {
    const src = '[data-theme=light]\n  $$bg: #ffffff\n\n[data-theme=dark]\n  $$bg: #111111\n'
    const out = rewriteThemeValue(src, 'bg', 'mjs', '#000000')
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'ambigu')
    assert.deepEqual(out.lines, [2, 5])
    assert.equal(out.source, '')
  })

  it('REGISTRE PÉRIMÉ — une ligne qui ne déclare plus rien ne se fait pas écrire au jugé', () => {
    // le build disait ligne 2 ; depuis, trois lignes ont été insérées au-dessus. La ligne 2
    // porte maintenant du code SANS RAPPORT : l'écrire à l'aveugle l'écraserait en silence.
    const src = '// trois lignes ajoutées depuis le build\n$prixHT = 1290\n// ---\n.carte\n  $$accent: #3b82f6\n'
    const out = rewriteThemeValue(src, 'accent', 'mjs', '#ff0000', 2)
    assert.equal(out.ok, true, 'une seule candidate reste : on retombe dessus')
    assert.equal(out.line, 5, 'la VRAIE ligne, pas celle qu\'annonçait le registre')
    assert.equal(out.source.split('\n')[1], '$prixHT = 1290', 'la ligne 2 est intacte')
  })

  it('valeur déjà posée = « inchange », et rien n\'est réécrit', () => {
    const out = rewriteThemeValue('  $$accent: #ff0000\n', 'accent', 'mjs', '#ff0000')
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'inchange')
    assert.equal(out.source, '')
  })

  it('un commentaire de fin de ligne ne mange pas la valeur, et l\'inverse non plus', () => {
    const hits = findThemeDecls('  $$a: red // note\n  $$b: url(http://x/y.png)\n', 'a', 'mjs')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].value, 'red', 'le // ferme la valeur…')
    assert.equal(hits[0].tail, ' // note')
    // …mais seulement précédé d'un blanc : le `//` d'une URL ne coupe rien (même règle que
    // transpiler/style-vars, qui a déjà payé ce piège)
    assert.equal(findThemeDecls('  $$b: url(http://x/y.png)\n', 'b', 'mjs')[0].value, 'url(http://x/y.png)')
  })

  it('deux déclarations sur UNE ligne : le `;` ferme la première', () => {
    const hits = findThemeDecls('  --mjs-a: red; --mjs-b: blue\n', 'a', 'mjs')
    assert.equal(hits[0].value, 'red')
    assert.equal(hits[0].tail, '; --mjs-b: blue')
  })
})

describe('POST /__mjs/theme/write — enregistrement dans le source', () => {
  it('écrit la couleur dans le fichier déclarant, sur le disque', async function () {
    this.timeout(15000)
    const { root, server } = projet('theme-write-ok', { 'src/carte.mjs': '<theme>\n  $$accent: #3b82f6\n</theme>\n' })
    await server.start()
    try {
      const { corps } = await ecrire(portDe(server), { name: 'accent', value: '#ff0000', file: 'src/carte.mjs', line: 2 })
      assert.equal(corps.written, true)
      assert.equal(corps.line, 2)
      assert.equal(corps.before, '#3b82f6')
      assert.equal(readFileSync(join(root, 'src/carte.mjs'), 'utf-8'), '<theme>\n  $$accent: #ff0000\n</theme>\n')
    } finally {
      await server.stop()
    }
  })

  it('un chemin qui SORT du projet est refusé, et le fichier visé reste intact', async function () {
    this.timeout(15000)
    const dehors = mjsTmp('theme-write-dehors')
    const temoin = join(dehors, 'secret.sass')
    writeFileSync(temoin, '  --mjs-accent: #000000\n')
    const { root, server } = projet('theme-write-clos', { 'src/carte.mjs': '  $$accent: #3b82f6\n' })
    // chemin relatif qui REMONTE et retombe sur un fichier RÉEL — sinon le refus viendrait du
    // `existsSync` et ne prouverait rien de la clôture (socle § 7 : une garde se prouve sur un
    // cas dont on connaît la réponse, pas sur un cas qui échoue pour une autre raison)
    const remonte = join('..', basename(dehors), 'secret.sass')
    assert.equal(existsSync(resolve(root, remonte)), true, 'le chemin remonté vise bien un fichier existant')
    // …et le même piège par LIEN SYMBOLIQUE : un lien posé DANS le projet, pointant dehors —
    // le chemin reste sagement relatif, c'est la résolution du lien qui trahit la sortie
    symlinkSync(temoin, join(root, 'src/lien.sass'))
    await server.start()
    try {
      for (const file of [remonte, 'src/lien.sass']) {
        const { corps } = await ecrire(portDe(server), { name: 'accent', value: '#ff0000', file, line: 1 })
        assert.equal(corps.written, false, `refusé : ${file}`)
        assert.equal(corps.reason, 'hors-projet')
      }
      assert.equal(readFileSync(temoin, 'utf-8'), '  --mjs-accent: #000000\n', 'le fichier hors projet n\'a pas bougé')
    } finally {
      await server.stop()
    }
  })

  it('une valeur qui n\'est pas une couleur est refusée AVANT d\'atteindre le disque', async function () {
    this.timeout(15000)
    const { root, server } = projet('theme-write-crible', { 'src/carte.mjs': '  $$accent: #3b82f6\n' })
    await server.start()
    try {
      const port = portDe(server)
      for (const value of ['red; } body { display: none', 'url(//exemple.test/pixel.png)', 'a'.repeat(65)]) {
        const { corps } = await ecrire(port, { name: 'accent', value, file: 'src/carte.mjs', line: 1 })
        assert.equal(corps.written, false, `refusée : ${value}`)
        assert.equal(corps.reason, 'valeur-refusee')
      }
      assert.equal(readFileSync(join(root, 'src/carte.mjs'), 'utf-8'), '  $$accent: #3b82f6\n')
    } finally {
      await server.stop()
    }
  })

  it('une page d\'une AUTRE origine ne peut pas écrire (403), là où l\'aperçu se contentait de diffuser', async function () {
    this.timeout(15000)
    const { root, server } = projet('theme-write-origine', { 'src/carte.mjs': '  $$accent: #3b82f6\n' })
    await server.start()
    try {
      const { status } = await ecrire(portDe(server), { name: 'accent', value: '#ff0000', file: 'src/carte.mjs', line: 1 }, { Origin: 'https://exemple.test' })
      assert.equal(status, 403)
      assert.equal(readFileSync(join(root, 'src/carte.mjs'), 'utf-8'), '  $$accent: #3b82f6\n')
    } finally {
      await server.stop()
    }
  })

  it('une requête SANS EN-TÊTE Origin du tout ne peut pas écrire non plus (trouvé 23/09)', async function () {
    this.timeout(15000)
    // un navigateur envoie TOUJOURS Origin sur une requête cross-origin (fetch/XHR) — seul un
    // client qui n'est PAS un navigateur (curl, un autre process, une autre machine si dev.host
    // est ouvert au réseau) peut l'omettre. AVANT le fix, isTrustedDevOrigin(undefined) rendait
    // true (pensé pour la commodité d'outillage local), ce qui revenait à laisser N'IMPORTE QUEL
    // client sans Origin écrire dans le code source sans la moindre vérification.
    const { root, server } = projet('theme-write-sans-origine', { 'src/carte.mjs': '  $$accent: #3b82f6\n' })
    await server.start()
    try {
      const { status } = await ecrire(portDe(server), { name: 'accent', value: '#ff0000', file: 'src/carte.mjs', line: 1 }, {})
      assert.equal(status, 403)
      assert.equal(readFileSync(join(root, 'src/carte.mjs'), 'utf-8'), '  $$accent: #3b82f6\n')
    } finally {
      await server.stop()
    }
  })

  it('un url() NICHÉ dans une fonction admise est refusé, pas seulement en tête (trouvé 23/09)', async function () {
    this.timeout(15000)
    // THEME_VALUE_RE admet des parenthèses/lettres à l'intérieur d'un var()/color-mix() pour
    // permettre la composition légitime (var(--a, var(--b))) — mais la même ouverture laisse
    // n'importe quel nom de fonction s'y nicher, y compris url(), qui déclenche une requête
    // réseau dès que la variable sert d'image de fond. Un url() EN TÊTE était déjà refusé
    // (cf. plus haut) ; celui-ci ne l'était pas.
    const { root, server } = projet('theme-write-url-niche', { 'src/carte.mjs': '  $$accent: #3b82f6\n' })
    await server.start()
    try {
      const port = portDe(server)
      const pieges = [
        'var(--x,url(//exemple.test/a))',
        'color-mix(in srgb, url(//exemple.test/a) 50%, red)',
        'var(--a,var(--b,url(//exemple.test/a)))',
        'var(--x,URL(//exemple.test/a))',
      ]
      for (const value of pieges) {
        const { corps } = await ecrire(port, { name: 'accent', value, file: 'src/carte.mjs', line: 1 })
        assert.equal(corps.written, false, `refusée : ${value}`)
        assert.equal(corps.reason, 'valeur-refusee')
      }
      assert.equal(readFileSync(join(root, 'src/carte.mjs'), 'utf-8'), '  $$accent: #3b82f6\n')
    } finally {
      await server.stop()
    }
  })

  it('deux écritures QUASI SIMULTANÉES sur le MÊME fichier (2 variables) n\'en perdent aucune', async function () {
    this.timeout(15000)
    const { root, server } = projet('theme-write-concurrent', {
      'src/carte.mjs': '<theme>\n  $$accent: #3b82f6\n  $$fg: #111111\n</theme>\n',
    })
    await server.start()
    try {
      const port = portDe(server)
      const [a, b] = await Promise.all([
        ecrire(port, { name: 'accent', value: '#ff0000', file: 'src/carte.mjs', line: 2 }),
        ecrire(port, { name: 'fg', value: '#00ff00', file: 'src/carte.mjs', line: 3 }),
      ])
      assert.equal(a.corps.written, true)
      assert.equal(b.corps.written, true)
      const final = readFileSync(join(root, 'src/carte.mjs'), 'utf-8')
      assert.match(final, /\$\$accent: #ff0000/, 'la 1re écriture ne doit pas être perdue')
      assert.match(final, /\$\$fg: #00ff00/, 'la 2e écriture ne doit pas être perdue')
    } finally {
      await server.stop()
    }
  })

  it('404 en production, comme l\'atelier lui-même', async function () {
    this.timeout(15000)
    const { server } = projet('theme-write-prod', { 'src/carte.mjs': '  $$accent: #3b82f6\n' }, { env: 'prod' })
    await server.start()
    try {
      const { status } = await ecrire(portDe(server), { name: 'accent', value: '#ff0000', file: 'src/carte.mjs', line: 1 })
      assert.equal(status, 404)
    } finally {
      await server.stop()
    }
  })

  it('sans racine de projet connue, le serveur ne résout rien et le DIT', async function () {
    this.timeout(15000)
    const root   = mjsTmp('theme-write-sans-racine')
    const server = new StaticServer({ rootDir: root, port: 0, host: '127.0.0.1', hmr: true })
    await server.start()
    try {
      const { corps } = await ecrire(portDe(server), { name: 'accent', value: '#ff0000', file: 'src/carte.mjs', line: 1 })
      assert.equal(corps.written, false)
      assert.equal(corps.reason, 'racine-inconnue')
    } finally {
      await server.stop()
    }
  })
})
