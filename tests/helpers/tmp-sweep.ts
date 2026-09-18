// balai global : filet de sécurité pour les 128 fichiers *.test.ts
// non migrés vers mjsTmp() — repère au démarrage les dossiers /tmp/mjs-* déjà présents,
// et supprime à la fin ceux apparus PENDANT cette suite (+ appelle sweepRegistered()
// pour les fichiers migrés dont le after() local aurait été sauté, ex. --bail). Ne
// touche qu'aux dossiers apparus PENDANT cette suite. Root hook Mocha :
// actif uniquement là où ce fichier est chargé via --require (cf. package.json,
// script "test") ; absent de l'invocation → aucun effet, aucune erreur.
// Il balaie aussi AU DÉMARRAGE (sweepStale()) les dossiers
// mjs-<banc>-<6 car.> sans écriture depuis 1 h.
// Un dossier TENU par un process vivant (dossier de travail
// ou descripteur ouvert, lus dans /proc) est épargné quel que soit son âge — heldDirs().

import { readdirSync, rmSync, writeFileSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { sweepRegistered } from './tmp.js'


function mjsDirsNow(): Set<string> {
  const out = new Set<string>()
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith('mjs-')) out.add(name)
  }
  return out
}

// SUITE INSTABLE — le balai ci-dessus supprimait les dossiers apparus
// pendant SA suite, y compris ceux d'un AUTRE run mocha lancé en parallèle (deux
// agents, ou une suite ciblée pendant un `npm test`) : la victime perdait son
// dossier temporaire EN COURS D'USAGE et un test au hasard virait au rouge, jamais
// le même. D'où : chaque run pose un verrou nommé par son PID ; tant qu'un verrou
// d'un autre run VIVANT traîne, le balayage large est sauté — `sweepRegistered()`,
// lui, ne touche qu'aux dossiers que CE processus a enregistrés, il tourne toujours.
// Pire cas du saut : quelques dossiers /tmp/mjs-* survivent, le prochain run seul
// les emporte.
//
// ESPACES DE PID — le pid ne prouve rien d'un sandbox à l'autre : chaque commande y a son propre espace de
// PID, le mocha d'une suite lancée ailleurs y porte un pid inexistant d'ici (kill rend ESRCH), ou le même
// numéro que le nôtre. Son verrou passait pour orphelin, partait, et le balayage large emportait les dossiers
// en cours d'usage de l'autre run. D'où : un jeton aléatoire dans le nom (deux runs homonymes ne partagent
// plus un fichier) et un BATTEMENT — chaque run réécrit son verrou toutes les 15 s, et un verrou réécrit
// depuis moins de 5 min est vivant, quel que soit l'espace qui l'a posé. Le pid ne juge plus que le verrou
// MUET : run de cet espace à la boucle bloquée, ou harnais sans battement. Muet ET pid absent = orphelin.
const LOCK_RE       = /^mjs-sweep-(\d+)(?:-[0-9a-f]+)?\.lock$/
const LOCK_NAME     = `mjs-sweep-${process.pid}-${randomBytes(4).toString('hex')}.lock`
const lockPath      = join(tmpdir(), LOCK_NAME)
const LOCK_BEAT_MS  = Number(process.env.MJS_TEST_LOCK_BEAT_MS) || 15000      //réglable pour éprouver le battement en moins d'une seconde
const LOCK_STALE_MS = 300000
let beat: ReturnType<typeof setInterval> | undefined

function lockFresh(full: string): boolean {
  try { return Date.now() - lstatSync(full).mtimeMs < LOCK_STALE_MS }
  catch (e: any) { return e?.code !== 'ENOENT' }                                  //parti = rien à protéger ; illisible = frais
}

function otherRunAlive(): boolean {
  for (const name of readdirSync(tmpdir())) {
    const m = LOCK_RE.exec(name)
    if(!m || name === LOCK_NAME) continue
    const full = join(tmpdir(), name)
    if(lockFresh(full)) return true                                                //battement récent : vivant, où qu'il tourne
    try { process.kill(Number(m[1]), 0); return true }                             //muet mais pid vivant dans cet espace
    catch { try { rmSync(full, { force: true }) } catch { /* rien */ } }            //muet et pid absent : orphelin
  }
  return false
}

let before = new Set<string>()

// BALAI AU DÉMARRAGE. Une suite tuée ou interrompue ne passe jamais par afterAll() :
// jusqu'à 9 367 dossiers mjs-* (6,0 Gio de tmpfs, donc de RAM) ont déjà été retrouvés dans /tmp. Au démarrage,
// tout dossier de la forme STRICTE mjs-<banc>-<6 car.> sans écriture depuis 1 h part.
// Le cache mjs-server-cache-1000 (4 chiffres) et les verrous mjs-sweep-<pid>.lock (un point, et des
// fichiers) ne sont pas de cette forme. L'âge se mesure sur l'écriture la plus RÉCENTE de tout l'arbre,
// jamais sur le seul dossier racine ; un arbre illisible passe pour frais : on ne balaie pas ce qu'on
// n'a pas su lire. Pas de verrou ici : un dossier muet depuis 1 h n'est plus le plan de travail de
// personne, run concurrent ou pas — c'est la règle du filet, la suite ne fait que l'appliquer plus tôt.
const STALE_RE     = /^mjs-[A-Za-z0-9][A-Za-z0-9_-]{0,60}-[A-Za-z0-9]{6}$/
const STALE_AGE_MS = 3600000

function newestMtime(dir: string): number {
  let newest = lstatSync(dir).mtimeMs
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    newest     = Math.max(newest, lstatSync(full).mtimeMs)
    if(entry.isDirectory()) newest = Math.max(newest, newestMtime(full))       //un lien symbolique n'est jamais suivi
  }
  return newest
}

// TENEUR VIVANT : l'âge ne voit pas un
// serveur lancé par un test dont le dossier de travail est le banc — il n'y écrit plus, mais il y VIT (rendu SSR à
// outputDir explicite, jamais rendu par close()). On lit /proc/<pid>/cwd, root, exe et /proc/<pid>/fd/* : tout dossier
// de premier niveau de tmpdir() tenu par un process vivant est épargné. Un process parti, zombie (liens morts) ou d'un
// autre utilisateur est sauté. TROIS cas rendent null (« je ne sais pas », rien ne part) : /proc illisible, notre
// PROPRE cwd illisible, et aucun AUTRE process lu alors que /proc en liste ;
// ce dernier est celui que le témoin /proc/self/cwd ne voyait pas, notre process restant lisible par construction,
// si bien qu'une panne aveuglant tous les autres rendait un ensemble vide, mot pour mot un /tmp libre.
// Limites : un process qui a lu ses fichiers sans les garder
// ouverts reste invisible ; un process NON-DUMPABLE du même utilisateur l'est aussi, au noyau lui-même (son banc
// partirait sous lui) ; et un sandbox à namespace de PID propre ne voit que ses propres process.
function heldDirs(): Set<string> | null {
  const held = new Set<string>()
  let prefix = ''
  let me     = ''
  let pids: string[]
  let others = 0
  let read   = 0
  //`me` DANS le try : c'est une lecture de /proc comme les autres, et si elle échoue on rend null. NOTRE pid tel que CE
  //procfs le nomme — `process.pid` rend celui de notre namespace et, sous un autre procfs, ne désigne personne : notre
  //propre entrée compterait alors comme « un autre process lu » et masquerait l'aveuglement
  try { prefix = realpathSync(tmpdir()) +'/'; me = readlinkSync('/proc/self'); pids = readdirSync('/proc').filter(n => /^\d+$/.test(n)); readlinkSync('/proc/self/cwd') } catch { return null }
  if(!pids.includes(me)) return null                             //notre PROPRE entrée manque : le /proc lu n'est pas le nôtre, ou il est filtré — notre auto-lecture compterait pour « un autre » et masquerait l'aveuglement
  for (const pid of pids) {
    const links = [`/proc/${pid}/cwd`, `/proc/${pid}/root`, `/proc/${pid}/exe`]
    try { for (const fd of readdirSync(`/proc/${pid}/fd`)) links.push(`/proc/${pid}/fd/${fd}`) } catch { /* parti, zombie ou pas à nous : cwd/root/exe se tentent quand même */ }
    let read1 = false
    for (const link of links) {
      let target = ''
      try { target = readlinkSync(link) } catch { continue }
      read1 = true
      if(!target.startsWith(prefix)) continue
      const name = target.slice(prefix.length).split('/')[0]
      if(name) held.add(name)
    }
    if(pid !== me) { others++; if(read1) read++ }                //le compte qui sépare « personne ne tient rien » de « je ne vois plus rien »
  }
  if(others && !read) return null                                //aveuglement SYSTÉMIQUE : /proc liste des process et pas un seul ne se lit
  return held
}

function sweepStale(): number {
  const now  = Date.now()
  const held = heldDirs()
  let n      = 0
  let spared = 0
  if(held === null) { console.log(`🧹 balai au démarrage : /proc illisible, aucun dossier mjs-* retiré de ${tmpdir()} (un dossier tenu ne se verrait pas)`); return 0 }
  for (const name of readdirSync(tmpdir())) {
    if(!STALE_RE.test(name)) continue
    const full = join(tmpdir(), name)
    let fresh  = true
    try { fresh = !lstatSync(full).isDirectory() || now - newestMtime(full) < STALE_AGE_MS } catch { fresh = true }   //illisible = frais
    if(fresh) continue
    if(held.has(name)) { spared++; continue }                                                                        //tenu par un process vivant : on ne balaie pas sous lui
    try { rmSync(full, { recursive: true, force: true }); n++ } catch { /* best-effort */ }
  }
  if(n || spared) console.log(`🧹 balai au démarrage : ${n} dossier(s) mjs-* sans écriture depuis 1 h retiré(s) de ${tmpdir()}`+ (spared ? `, ${spared} tenu(s) par un process vivant épargné(s)` : ''))
  return n
}

export const mochaHooks = {
  beforeAll() {
    sweepStale()          // balai d'abord, sinon "avant" protégerait des dossiers déjà jugés morts
    before = mjsDirsNow()
    try { writeFileSync(lockPath, String(process.pid)) } catch { /* best-effort */ }
    beat = setInterval(() => { try { writeFileSync(lockPath, String(process.pid)) } catch { /* best-effort */ } }, LOCK_BEAT_MS)   //réécrit : un verrou retiré par un harnais sans battement se repose
    beat.unref()
  },
  afterAll() {
    clearInterval(beat)
    if (!otherRunAlive()) {
      for (const name of mjsDirsNow()) {
        if (before.has(name) || LOCK_RE.test(name)) continue
        try { rmSync(join(tmpdir(), name), { recursive: true, force: true }) } catch { /* best-effort */ }
      }
    }
    sweepRegistered()
    try { rmSync(lockPath, { force: true }) } catch { /* best-effort */ }
  },
}
