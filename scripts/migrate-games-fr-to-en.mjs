#!/usr/bin/env node
// Migration des instantanés de partie persistés — champs français → anglais.
//
// MJS-Server a anglicisé sa surface publique : la classe `Partie` est devenue `Game`, et quatre
// endroits de l'instantané écrit par `FilePersistAdapter` parlaient encore français.
// Ce script les réécrit en place, un fichier à la fois, sans toucher au reste :
//
//   minuteries      → timers            (le tableau lui-même)
//     └ { nom, à }  → { name, at }      (chaque minuterie)
//   journal[]       inchangé            (le tableau garde son nom)
//     └ { coup, joueur, p, à } → { move, player, p, at }
//   lockstep.journal[].ordres → .orders (mode 'lockstep' seulement)
//     └ { joueur, coup, p }   → { player, move, p }
//   id : 'partie<n>' → 'game<n>'        (+ le FICHIER, nommé `<id>.json`)
//
// `type`, `code`, `state`, `phase`, `turn`, `seq` et `seats` sont INCHANGÉS.
// Les minuteries réservées ont aussi changé de nom : 'µtour'/'µappariement'/'µvide' →
// 'µturn'/'µmatch'/'µempty' — traduites ici, sinon la partie restaurée ne réarme plus son tour.
//
//   node scripts/migrate-games-fr-to-en.mjs <dossier>            # migre
//   node scripts/migrate-games-fr-to-en.mjs <dossier> --dry-run  # montre, n'écrit rien
//
// Idempotent : un instantané déjà migré est laissé tel quel (compté « déjà à jour »).
// Écriture atomique (fichier temporaire + rename), même geste que l'adaptateur lui-même.
//
// ⚠ ENCODAGE — ce script est un `.mjs` autonome (node direct, aucun build) : il ne peut pas importer
// encodeSnapshot/decodeSnapshot de `src/mjs-server/persist.ts`, il refait donc le même
// JSON.parse/JSON.stringify à la main. C'est identique AUJOURD'HUI — mais si la paire gagne un jour
// un traitement particulier (valeur cyclique, Date, très gros payload), il faut le répercuter ICI,
// sinon ce script écrira dans un format que l'adaptateur ne relira plus.
//
// ADAPTATEUR SQL : la table par défaut est passée de `mjs_server_parties` à `mjs_server_games`,
// et les COLONNES de `donnees`/`maj` à `data`/`updated_at`. Le nom de table reste au choix (option
// `table`) ; les colonnes, NON — elles sont écrites en dur dans les requêtes, une table restée en
// français fait échouer chaque save() (avertissement, aucune sauvegarde) et repart sans restauration :
//   ALTER TABLE mjs_server_parties RENAME TO mjs_server_games;
//   ALTER TABLE mjs_server_games RENAME COLUMN donnees TO data;      -- MySQL 5.7 : CHANGE donnees data TEXT
//   ALTER TABLE mjs_server_games RENAME COLUMN maj TO updated_at;    -- MySQL 5.7 : CHANGE maj updated_at BIGINT
//   UPDATE mjs_server_games SET id = REPLACE(id, 'partie', 'game') WHERE id LIKE 'partie%';
// La colonne de données contient le même JSON — ce script s'applique à son contenu ; l'id vit là
// AUSSI en clé primaire, d'où la dernière ligne.
// REDIS : la clé du hash passe de `<prefix>parties` à `<prefix>games` (RENAME mjs-server:parties
// mjs-server:games). Le CHAMP, lui, porte l'id — Redis n'a pas de « renommer un champ » : relis,
// réécris sous le nouveau nom, supprime l'ancien (HGET/HSET/HDEL).
//
// ⚠️  LOCKSTEP — la graine (`seed`) n'est PAS stockée : elle est re-dérivée de l'id à chaque
// restauration (`deterministicSeed`, lockstep.ts). Renommer l'id d'une partie lockstep EN COURS
// change donc sa graine : au retour, les clients reçoivent `{seed, journal}` et rejouent tout le
// journal avec un autre flux d'aléatoire qu'avant l'arrêt. Sans conséquence pour un jeu lockstep
// sans hasard ; sinon, migre entre deux saisons/parties plutôt qu'au milieu d'une partie vivante.

import { readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const TIMERS_RESERVES = { 'µtour': 'µturn', 'µappariement': 'µmatch', 'µvide': 'µempty' }

const args   = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const dir    = args.find(a => !a.startsWith('--'))

if (!dir) {
  console.error('usage : node scripts/migrate-games-fr-to-en.mjs <dossier> [--dry-run]')
  process.exit(1)
}

// renomme les clés d'un objet ; renvoie `true` si au moins une l'a été
function traduire(obj, paires) {
  let touche = false
  for (const [fr, en] of paires) {
    if (!obj || !Object.hasOwn(obj, fr)) continue
    if (!Object.hasOwn(obj, en)) obj[en] = obj[fr]   // jamais écraser une clé déjà anglaise
    delete obj[fr]
    touche = true
  }
  return touche
}

function migrer(snap) {
  const faits = []

  // id — `generateGameId()` (matchmaking.ts) fabriquait 'partie<n>', il fabrique 'game<n>'. Ne pas
  // migrer ne CASSE rien (les deux formes ne se croisent jamais : le compteur ne réattribue qu'un
  // 'game<n>'), mais la base continue de parler français sur le fil (`µgame:*.game`)
  if (typeof snap.id === 'string' && /^partie\d+$/.test(snap.id)) {
    snap.id = snap.id.replace(/^partie/, 'game')
    faits.push('id')
  }

  if (Array.isArray(snap.minuteries) || Array.isArray(snap.timers)) {
    if (traduire(snap, [['minuteries', 'timers']])) faits.push('minuteries→timers')
    for (const m of snap.timers ?? []) {
      traduire(m, [['nom', 'name'], ['à', 'at']])
      if (Object.hasOwn(TIMERS_RESERVES, m.name)) { m.name = TIMERS_RESERVES[m.name]; faits.push('minuterie réservée') }
    }
  }

  for (const e of snap.journal ?? []) {
    if (traduire(e, [['coup', 'move'], ['joueur', 'player'], ['à', 'at']])) faits.push('journal')
  }

  for (const t of snap.lockstep?.journal ?? []) {
    if (traduire(t, [['ordres', 'orders']])) faits.push('lockstep.ordres→orders')
    for (const o of t.orders ?? []) {
      if (traduire(o, [['joueur', 'player'], ['coup', 'move']])) faits.push('lockstep.ordre')
    }
  }

  return [...new Set(faits)]
}

let fichiers
try { fichiers = await readdir(dir) }
catch (err) { console.error(`dossier illisible : ${dir} — ${err.message}`); process.exit(1) }

let migres = 0, aJour = 0, ignores = 0

// noms DÉJÀ pris dans le dossier — un id renommé change le nom du fichier (`<id>.json`), jamais
// au prix d'un écrasement ; tenu à jour au fil des renommages de ce run
const occupes = new Set(fichiers)

for (const fichier of fichiers) {
  if (!fichier.endsWith('.json') || fichier.endsWith('.tmp.json')) continue
  const chemin = join(dir, fichier)

  let snap
  try { snap = JSON.parse(await readFile(chemin, 'utf8')) }
  catch (err) { console.warn(`⚠️  illisible, ignoré : ${fichier} — ${err.message}`); ignores++; continue }

  const ancienId = snap.id
  const faits    = migrer(snap)
  if (faits.length === 0) { aJour++; continue }

  // le fichier porte le nom de l'id (FilePersistAdapter::_chemin) : si l'id bouge, le fichier
  // suit — sinon l'ancien reste sur le disque et la partie serait restaurée DEUX FOIS au boot
  const suitLId    = snap.id !== ancienId && fichier === ancienId +'.json'
  const nouveauNom = suitLId ? snap.id +'.json' : fichier
  const cible      = suitLId ? join(dir, nouveauNom) : chemin

  if (snap.id !== ancienId && !suitLId) console.warn(`⚠️  ${fichier} : id ${ancienId} → ${snap.id}, mais le fichier ne porte pas l'ancien id — renomme-le à la main en '${snap.id}.json'`)
  if (suitLId && occupes.has(nouveauNom)) { console.warn(`⚠️  ${fichier} → ${nouveauNom} : la cible existe déjà, ignoré (tranche à la main)`); ignores++; continue }

  if (dryRun) { console.log(`→ ${fichier}${suitLId ? ` → ${nouveauNom}` : ''} : ${faits.join(', ')}`); migres++; if(suitLId) occupes.add(nouveauNom); continue }

  const tmp = join(dir, fichier.replace(/\.json$/, '') + '.' + randomBytes(4).toString('hex') + '.tmp.json')
  try {
    await writeFile(tmp, JSON.stringify(snap))
    await rename(tmp, cible)
    if (suitLId) {
      await unlink(chemin)
      occupes.delete(fichier)
      occupes.add(nouveauNom)
    }
    migres++
  } catch (err) {
    console.error(`❌ échec sur ${fichier} — ${err.message}`)
    await unlink(tmp).catch(() => {})
    process.exitCode = 1
  }
}

console.log(dryRun
  ? `\n${migres} instantané(s) à migrer, ${aJour} déjà à jour, ${ignores} ignoré(s) — rien n'a été écrit.`
  : `\n${migres} instantané(s) migré(s), ${aJour} déjà à jour, ${ignores} ignoré(s).`)
