// `mjs build` REFUSE de construire quand il n'y a rien à construire.
//
// Lancé depuis le mauvais dossier — ou visant une racine sans sources — le build écrivait
// un projet VIDE en annonçant « ✅ 2 fichiers écrits », code de sortie 0. Le manifeste du
// site servi se retrouvait remplacé par un `µ.paths = {}` : plus un seul composant connu,
// page blanche, et rien pour arrêter un script de déploiement qui enchaîne sur un rsync.
// C'est la garde muette appliquée à un build : « je n'ai rien trouvé à construire » est
// indiscernable de « tout va bien ».
//
// Deux cas refusés, jamais confondus dans le message : plus rien du projet sous la racine
// (ni mjs.config.json ni dossier source), ou un dossier source bel et bien là mais sans le
// moindre `.mjs`. Le refus tombe AVANT toute écriture — c'est ce que vérifie le témoin.
//
// Sous-processus réels : cli.ts appelle `run(process.argv)` à son top-level, l'importer
// lancerait une vraie CLI.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function build(root: string) {
  const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', root], {
    cwd: repoRoot, encoding: 'utf-8', timeout: 120000,
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('cli.ts — la garde du build : rien à construire = refus, jamais un projet vide', function () {
  this.timeout(180000)

  it('un dossier sans config ni source : refus, code 1, et le manifeste en place est INTACT', () => {
    const root = mjsTmp('garde-racine')
    // le décor du sinistre : un site déjà déployé, dont on ne vise PAS la bonne racine
    mkdirSync(join(root, 'public', 'modularjs'), { recursive: true })
    const manifeste = join(root, 'public', 'modularjs', 'bundle.js')
    writeFileSync(manifeste, 'SITE REEL — 42 composants\n')

    const { code, stderr } = build(root)
    assert.equal(code, 1, 'le build doit sortir en ERREUR, pas en 0')
    assert.match(stderr, /Dossier source INTROUVABLE/)
    assert.match(stderr, /app\/modularjs/, 'le message doit nommer le dossier cherché')
    assert.equal(readFileSync(manifeste, 'utf-8'), 'SITE REEL — 42 composants\n',
      'AVANT : le manifeste devenait `µ.paths = {}` — zéro composant connu, page blanche')
  })

  // TROU DE LA GARDE — `hasComponents` comptait TOUT `.mjs` non vide, partials `_x.mjs`
  // compris. Or le bundler les EXCLUT (`!basename(f, '.mjs').startsWith('_')`) : ils ne sont que
  // du contenu à inclure, jamais un composant. Un dossier qui n'en contient que passait la garde
  // et rendait exactement le sinistre qu'elle existe pour empêcher — « ✅ 2 fichiers écrits »,
  // code 0, `µ.paths = {}`.
  it("un dossier ne contenant QUE des partials `_x.mjs` : refus, code 1, rien écrit", () => {
    const root = mjsTmp('garde-partials')
    mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
    writeFileSync(join(root, 'app', 'modularjs', '_entete.mjs'), '<header>x</header>\n')
    writeFileSync(join(root, 'app', 'modularjs', '_pied.mjs'), '<footer>y</footer>\n')

    const { code, stderr } = build(root)
    assert.equal(code, 1, 'un projet sans le moindre composant réel doit être REFUSÉ')
    assert.match(stderr, /Aucun composant à construire/)
    assert.ok(!existsSync(join(root, 'public')), 'rien ne doit être écrit : le refus tombe avant le build')
  })

  it("contre-cas : un partial À CÔTÉ d'un vrai composant ne change rien, le build passe", () => {
    const root = mjsTmp('garde-partial-plus-comp')
    mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
    writeFileSync(join(root, 'app', 'modularjs', '_entete.mjs'), '<header>x</header>\n')
    writeFileSync(join(root, 'app', 'modularjs', 'page.mjs'), '<div>page</div>\n')

    const { code, stderr } = build(root)
    assert.equal(code, 0, `le build doit passer : ${stderr}`)
  })

  it('un dossier source présent mais sans le moindre composant : refus, code 1, rien écrit', () => {
    const root = mjsTmp('garde-vide')
    mkdirSync(join(root, 'app', 'modularjs', 'i18n'), { recursive: true })
    writeFileSync(join(root, 'app', 'modularjs', 'i18n', 'fr.yml'), 'fr:\n  x: y\n')

    const { code, stderr } = build(root)
    assert.equal(code, 1)
    assert.match(stderr, /Aucun composant à construire/)
    assert.ok(!existsSync(join(root, 'public')), 'rien ne doit être écrit : le refus tombe avant le build')
  })

  it('un mjs.config.json présent dont le sourceDir a disparu : refus, manifeste INTACT', () => {
    // la première écriture de la garde ne couvrait QUE l'absence de config — une config
    // présente dont le `sourceDir` avait été renommé rejouait le sinistre à l'identique,
    // « ✅ 2 fichiers écrits », code 0
    const root = mjsTmp('garde-config')
    mkdirSync(join(root, 'public', 'modularjs'), { recursive: true })
    const manifeste = join(root, 'public', 'modularjs', 'bundle.js')
    writeFileSync(manifeste, 'SITE REEL — 42 composants\n')
    writeFileSync(join(root, 'mjs.config.json'), '{ "sourceDir": "app/moduarjs" }\n')

    const { code, stderr } = build(root)
    assert.equal(code, 1)
    assert.match(stderr, /Dossier source INTROUVABLE/)
    assert.match(stderr, /sourceDir/, "le message doit dire d'où vient le chemin cherché")
    assert.equal(readFileSync(manifeste, 'utf-8'), 'SITE REEL — 42 composants\n')
  })

  it('des composants derrière un lien symbolique INTERNE (cible sous sourceDir) comptent — comme pour le bundler', () => {
    // `Dirent.isDirectory()` ne suit PAS les liens : un dossier de composants atteint par un
    // lien était compté zéro et la garde refusait un projet que le bundler aurait construit.
    // Cible SOUS sourceDir (app/modularjs/shared_lib) : cas légitime, jamais concerné par le
    // confinement realpathSync du bundler (cf. test suivant).
    const root = mjsTmp('garde-symlink-interne')
    mkdirSync(join(root, 'app', 'modularjs', 'shared_lib'), { recursive: true })
    writeFileSync(join(root, 'app', 'modularjs', 'shared_lib', 'card.mjs'), '<div>ok</div>\n')
    symlinkSync(join(root, 'app', 'modularjs', 'shared_lib'), join(root, 'app', 'modularjs', 'linked'))

    const { code, stdout } = build(root)
    assert.equal(code, 0, stdout)
    assert.match(stdout, /fichiers écrits/)
  })

  // ce test figeait l'ANCIEN comportement (un lien HORS sourceDir
  // était suivi et ses composants comptés/publiés) : exactement la faille corrigée par le
  // confinement realpathSync de Bundler.findFiles() (un fichier externe compilé et publié dans
  // outputDir). Attente inversée : build en échec, erreur nommée, composant externe jamais publié.
  //
  // Le pré-check `hasComponents` de cli.ts (qui, lui, résout déjà les liens — cf. test précédent)
  // laisse encore PASSER ce cas jusqu'au bundler réel : mjs_core (runtime, indépendant du scan
  // sourceDir) est donc bien écrit — ce n'est PAS le sinistre visé par cette garde (un projet
  // VIDE annoncé sain, code 0) — ce qui compte : code non nul, erreur nommant le lien, et le
  // manifeste publié (s'il l'est) ne référence JAMAIS le composant atteint par le lien évadé.
  it('un lien symbolique EXTERNE (cible HORS sourceDir) est refusé explicitement — jamais compilé ni publié', () => {
    const root = mjsTmp('garde-symlink-externe')
    mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
    mkdirSync(join(root, 'shared_lib'), { recursive: true })
    writeFileSync(join(root, 'shared_lib', 'card.mjs'), '<div>ok</div>\n')
    symlinkSync(join(root, 'shared_lib'), join(root, 'app', 'modularjs', 'linked'))

    const { code, stderr } = build(root)
    assert.notEqual(code, 0,
      'AVANT le fix : un lien HORS sourceDir était suivi normalement, le composant externe comptait et le build passait (code 0)')
    assert.match(stderr, /lien symbolique/, `le message doit nommer le lien symbolique évadé : ${stderr}`)
    const manifeste = join(root, 'public', 'modularjs', 'bundle.js')
    if (existsSync(manifeste)) {
      assert.doesNotMatch(readFileSync(manifeste, 'utf-8'), /card/,
        "AVANT le fix : card.mjs (atteint via le lien évadé, HORS sourceDir) se retrouvait publié au manifeste")
    }
  })

  it('un projet légitime passe — la garde ne bloque que le vide', () => {
    const root = mjsTmp('garde-temoin')
    mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
    writeFileSync(join(root, 'app', 'modularjs', 'carte.mjs'), '<div>bonjour</div>\n')

    const { code, stdout } = build(root)
    assert.equal(code, 0, stdout)
    assert.match(stdout, /fichiers écrits/)
  })
})
