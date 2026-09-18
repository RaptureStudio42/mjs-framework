// Tests du script de migration des instantanés persistés (scripts/migrate-games-fr-to-en.mjs) —
// volet IDENTIFIANTS de partie : `generateGameId()` fabriquait 'partie<n>', il fabrique 'game<n>'
// (dernière chaîne française à circuler sur le fil `µgame:*.game` et à dormir dans les instantanés).
//
// Le script est lancé POUR DE VRAI (spawn node) sur un dossier temporaire : c'est un outil qu'un
// utilisateur exécute à la main sur SES données de production, le tester en important ses fonctions
// laisserait justement dehors ce qui compte — le renommage du FICHIER, l'anti-écrasement et --dry-run.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT    = join(__dirname, '../scripts/migrate-games-fr-to-en.mjs')

function snapshot(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, type: 'duel', code: null, state: { n: 1 }, phase: null, turn: null, seq: 0, journal: [], seats: [], ...extra })
}

// sortie COMPLÈTE : les avertissements partent sur stderr (console.warn), le récapitulatif sur stdout
function migrer(dir: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [SCRIPT, dir, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, `le script doit sortir en 0 — ${r.stderr}`)
  return r.stdout + r.stderr
}

describe('mjs-server/migration — identifiants de partie partie<n> → game<n>', function () {
  this.timeout(20000)

  it("renomme l'id DANS l'instantané ET le fichier qui le porte — l'ancien fichier disparaît", () => {
    const dir = mjsTmp('migr-id')
    writeFileSync(join(dir, 'partie1.json'), snapshot('partie1'))
    writeFileSync(join(dir, 'partie12.json'), snapshot('partie12'))

    migrer(dir)

    assert.deepEqual(readdirSync(dir).sort(), ['game1.json', 'game12.json'], 'les deux fichiers suivent leur id')
    assert.equal(JSON.parse(readFileSync(join(dir, 'game1.json'), 'utf8')).id, 'game1')
    assert.equal(JSON.parse(readFileSync(join(dir, 'game12.json'), 'utf8')).id, 'game12', 'le NUMÉRO est conservé tel quel (12, pas 1)')
    assert.ok(!existsSync(join(dir, 'partie1.json')), "l'ancien fichier ne doit PAS survivre — sinon la partie serait restaurée deux fois au boot")
  })

  it('le reste de l\'instantané est préservé — seul l\'id bouge', () => {
    const dir = mjsTmp('migr-id')
    writeFileSync(join(dir, 'partie3.json'), snapshot('partie3', { code: 'ABCD', state: { score: 42 }, seats: [{ seat: 0 }] }))

    migrer(dir)

    const snap = JSON.parse(readFileSync(join(dir, 'game3.json'), 'utf8'))
    assert.equal(snap.code, 'ABCD')
    assert.equal(snap.state.score, 42)
    assert.deepEqual(snap.seats, [{ seat: 0 }])
    assert.equal(snap.type, 'duel')
  })

  it('idempotent — un dossier déjà migré est laissé tel quel', () => {
    const dir = mjsTmp('migr-id')
    writeFileSync(join(dir, 'partie1.json'), snapshot('partie1'))

    migrer(dir)
    const sortie = migrer(dir)

    assert.match(sortie, /0 instantané\(s\) migré/, 'le 2e passage ne migre plus rien')
    assert.match(sortie, /1 déjà à jour/)
    assert.deepEqual(readdirSync(dir), ['game1.json'])
  })

  it("n'écrase JAMAIS une cible existante — collision signalée, les deux fichiers intacts", () => {
    const dir = mjsTmp('migr-id')
    writeFileSync(join(dir, 'partie1.json'), snapshot('partie1', { state: { n: 'ancien' } }))
    writeFileSync(join(dir, 'game1.json'),   snapshot('game1',   { state: { n: 'déjà là' } }))

    const sortie = migrer(dir)

    assert.match(sortie, /la cible existe déjà/, 'la collision doit être annoncée')
    assert.equal(JSON.parse(readFileSync(join(dir, 'game1.json'), 'utf8')).state.n, 'déjà là', "le fichier déjà en place n'est pas touché")
    assert.equal(JSON.parse(readFileSync(join(dir, 'partie1.json'), 'utf8')).id, 'partie1', "l'ancien est laissé sur le disque, à trancher à la main")
  })

  it('--dry-run montre le renommage et n\'écrit rien', () => {
    const dir = mjsTmp('migr-id')
    writeFileSync(join(dir, 'partie5.json'), snapshot('partie5'))

    const sortie = migrer(dir, '--dry-run')

    assert.match(sortie, /partie5\.json → game5\.json/, 'le renommage annoncé porte les DEUX noms')
    assert.deepEqual(readdirSync(dir), ['partie5.json'], 'rien écrit')
    assert.equal(JSON.parse(readFileSync(join(dir, 'partie5.json'), 'utf8')).id, 'partie5')
  })

  it('un id qui ne suit pas la forme générée est laissé intact (id choisi ailleurs, jamais deviné)', () => {
    const dir = mjsTmp('migr-id')
    writeFileSync(join(dir, 'partie-du-soir.json'), snapshot('partie-du-soir'))
    writeFileSync(join(dir, 'tournoi7.json'), snapshot('tournoi7'))

    migrer(dir)

    assert.deepEqual(readdirSync(dir).sort(), ['partie-du-soir.json', 'tournoi7.json'])
    assert.equal(JSON.parse(readFileSync(join(dir, 'partie-du-soir.json'), 'utf8')).id, 'partie-du-soir')
  })

  it("migre l'id ET les champs de l'ancien format dans le même passage (minuteries, journal)", () => {
    const dir = mjsTmp('migr-id')
    writeFileSync(join(dir, 'partie2.json'), snapshot('partie2', {
      minuteries: [{ nom: 'µtour', 'à': 1000 }],
      journal:    [{ coup: 'inc', joueur: 'a', p: null, 'à': 900 }],
    }))

    migrer(dir)

    const snap = JSON.parse(readFileSync(join(dir, 'game2.json'), 'utf8'))
    assert.equal(snap.id, 'game2')
    assert.deepEqual(snap.timers, [{ name: 'µturn', at: 1000 }], 'minuterie réservée traduite aussi')
    assert.deepEqual(snap.journal, [{ move: 'inc', player: 'a', p: null, at: 900 }])
    assert.ok(!('minuteries' in snap) && !('coup' in snap.journal[0]), 'aucune clé française ne survit')
  })
})
