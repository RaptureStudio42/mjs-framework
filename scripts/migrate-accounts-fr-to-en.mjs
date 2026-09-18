#!/usr/bin/env node
// Migration des comptes persistés — champs français → anglais.
//
// Le paquet COMPTES est devenu ACCOUNTS et ses champs stockés ont suivi. Un dossier écrit par
// l'ancienne version (`FileComptesPersistAdapter`) contient des enregistrements dont quatre clés
// ont changé de nom — ce script les réécrit en place, un fichier à la fois, sans toucher au reste :
//
//   pseudo → name        (casse d'origine conservée, comme avant)
//   sel    → salt
//   cree   → createdAt
//   vu     → seenAt
//
// `id`, `hash`, `roles` et `meta` sont INCHANGÉS : les secrets restent vérifiables tels quels,
// personne n'a à se reconnecter.
//
//   node scripts/migrate-accounts-fr-to-en.mjs <dossier>            # migre
//   node scripts/migrate-accounts-fr-to-en.mjs <dossier> --dry-run  # montre, n'écrit rien
//
// Idempotent : un enregistrement déjà migré est laissé tel quel (compté « déjà à jour »).
// Écriture atomique (fichier temporaire + rename), même geste que l'adaptateur lui-même — une
// coupure de courant en cours de migration ne laisse jamais un compte à moitié écrit.

import { readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const CHAMPS = [['pseudo', 'name'], ['sel', 'salt'], ['cree', 'createdAt'], ['vu', 'seenAt']]

const args   = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const dir    = args.find(a => !a.startsWith('--'))

if (!dir) {
  console.error('usage : node scripts/migrate-accounts-fr-to-en.mjs <dossier> [--dry-run]')
  process.exit(1)
}

let fichiers
try { fichiers = await readdir(dir) }
catch (err) { console.error(`dossier illisible : ${dir} — ${err.message}`); process.exit(1) }

let migres = 0, aJour = 0, ignores = 0

for (const fichier of fichiers) {
  if (!fichier.endsWith('.json') || fichier.endsWith('.tmp.json')) continue
  const chemin = join(dir, fichier)

  let record
  try { record = JSON.parse(await readFile(chemin, 'utf8')) }
  catch (err) { console.warn(`⚠️  illisible, ignoré : ${fichier} — ${err.message}`); ignores++; continue }

  const aTraduire = CHAMPS.filter(([fr]) => Object.hasOwn(record, fr))
  if (aTraduire.length === 0) { aJour++; continue }

  for (const [fr, en] of aTraduire) {
    if (!Object.hasOwn(record, en)) record[en] = record[fr]   // jamais écraser une clé déjà anglaise
    delete record[fr]
  }

  if (dryRun) {
    console.log(`→ ${fichier} : ${aTraduire.map(([fr, en]) => `${fr}→${en}`).join(', ')}`)
    migres++
    continue
  }

  const tmp = join(dir, fichier.replace(/\.json$/, '') + '.' + randomBytes(4).toString('hex') + '.tmp.json')
  try {
    await writeFile(tmp, JSON.stringify(record))
    await rename(tmp, chemin)
    migres++
  } catch (err) {
    console.error(`❌ échec sur ${fichier} — ${err.message}`)
    await unlink(tmp).catch(() => {})
    process.exitCode = 1
  }
}

console.log(dryRun
  ? `\n${migres} compte(s) à migrer, ${aJour} déjà à jour, ${ignores} ignoré(s) — rien n'a été écrit.`
  : `\n${migres} compte(s) migré(s), ${aJour} déjà à jour, ${ignores} ignoré(s).`)
