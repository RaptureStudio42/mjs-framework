// cli/dev-lock — lockfile dev : un seul `mjs dev` par projet à la fois.
// Empêche deux watchers de se battre pour `bundle_modular.js` (le dernier
// écrit gagne, mais entre-temps le browser charge des hashes périmés).
//
// Extrait de cli.ts : cli.ts exécute
// `run(process.argv)` INCONDITIONNELLEMENT à son top-level (pas de garde
// `require.main===module`) — l'importer depuis un test, même juste pour
// `acquireDevLock`, déclencherait une VRAIE exécution CLI. Extraction dans
// ce module dédié (même précédent que `cli/init.ts`) pour permettre un test
// direct, sûr.
//
// 2 défauts liés, même fonction :
//   1. TOCTOU : `existsSync` (check) puis `writeFileSync` (use) sont 2
//      syscalls séparés — 2 `mjs dev` lancés en même temps peuvent tous les
//      deux passer le check (aucun lock, ou lock jugé orphelin par les
//      DEUX) puis tous les deux écrire leur PID, le dernier écrasant le
//      premier — EXACTEMENT le scénario que ce verrou existe pour empêcher.
//   2. `process.kill(pid, 0)` (test de vie) qui THROW ne signifie pas
//      forcément "process mort" : `ESRCH` = mort, mais `EPERM` = VIVANT,
//      juste appartenant à un autre utilisateur (CI, conteneur, sudo). Le
//      catch générique traitait les DEUX cas identiquement comme
//      "orphelin" — un `EPERM` volait le lock d'un process ACTIF.
//
// Fix : (a) écriture EXCLUSIVE atomique (`flag:'wx'`, `O_CREAT|O_EXCL`) —
// élimine la fenêtre TOCTOU pour le cas dominant (aucun lock pré-existant) :
// l'OS garantit qu'un seul des 2 process concurrents gagne la course
// d'ouverture de fichier ; (b) EPERM distingué explicitement, jamais traité
// comme orphelin. Limite assumée et documentée : le chemin « lock orphelin
// détecté → unlink → ré-essai » garde une fenêtre TOCTOU résiduelle bien
// plus étroite (entre l'unlink et le ré-essai) — fermer CETTE fenêtre
// exigerait un verrou OS natif (flock) hors de portée d'un simple lockfile
// PID, disproportionné pour ce cas déjà rare (suppose qu'un lock stale ET
// une course de démarrage coïncident).

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { t } from '../messages/index.js'

export function acquireDevLock(
  lockPath: string = resolve(process.cwd(), '.mjs-dev.lock'),
  /** Rappel best-effort invoqué à l'arrêt (SIGINT/SIGTERM/SIGHUP), AVANT la
   *  libération du lock — cf. son point d'appel plus bas pour le pourquoi de
   *  cet emplacement précis. Absent par défaut (comportement HISTORIQUE
   *  inchangé : lock libéré, process quitte). */
  onShutdown?: () => void | Promise<void>,
): void {
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e: any) {
      if (e?.code === 'EPERM') return true  // vivant, juste pas signalable (autre utilisateur)
      return false  // ESRCH (ou autre) : process réellement mort
    }
  }
  // DURCISSEMENT — starttime du process
  // (Linux : /proc/<pid>/stat champ 22, en ticks depuis le boot). Distingue un
  // PID RÉUTILISÉ (après la mort du mjs dev, le noyau réattribue son PID à un
  // autre process) d'un mjs dev réellement vivant : sans lui, `isAlive(pid)`
  // répond vrai pour le squatteur → refus À TORT jusqu'à suppression manuelle.
  // `null` hors Linux (/proc absent) → repli sur le comportement PID seul.
  const procStartTime = (pid: number): string | null => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      // le champ 2 (comm) peut contenir espaces/parenthèses → couper après le DERNIER ')'
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return rest[19] ?? null  // rest[0] = champ 3 (state) → starttime (champ 22) = rest[19]
    } catch { return null }
  }
  const tryClaim = (): boolean => {
    try {
      // pid:starttime — starttime vide si /proc indisponible (repli PID seul).
      writeFileSync(lockPath, `${process.pid}:${procStartTime(process.pid) ?? ''}`, { flag: 'wx' })
      return true
    } catch (e: any) {
      if (e?.code === 'EEXIST') return false
      throw e
    }
  }

  // Boucle d'acquisition bornée : absorbe les courses ÉTROITES restantes —
  // DURCISSEMENT — le lock peut disparaître
  // ENTRE notre échec EEXIST et notre lecture (l'autre process le supprime) →
  // ENOENT : au lieu de crasher, on ré-essaie (le lock est peut-être libre).
  let acquired = false
  for (let attempt = 0; attempt < 4 && !acquired; attempt++) {
    if (tryClaim()) { acquired = true; break }

    let raw: string
    try {
      raw = readFileSync(lockPath, 'utf-8').trim()
    } catch (e: any) {
      if (e?.code === 'ENOENT') continue  // disparu entre EEXIST et read — retente
      throw e
    }
    const [pidStr, startedAt = ''] = raw.split(':')
    const pid = parseInt(pidStr, 10)
    // Vivant ET NON recyclé (starttime identique, ou indisponible → repli PID seul).
    const liveNotRecycled = Number.isFinite(pid) && pid !== process.pid && isAlive(pid) &&
      (startedAt === '' || procStartTime(pid) === null || procStartTime(pid) === startedAt)
    if (liveNotRecycled) {
      console.error(t('cli.dev-lock.deja-actif', { pid }))
      console.error(t('cli.dev-lock.lockfile-chemin', { chemin: lockPath }))
      console.error(t('cli.dev-lock.pour-forcer', { pid }))
      process.exit(1)
    }
    // Orphelin (mort) OU PID recyclé (autre process) → récupération.
    console.warn(t('cli.dev-lock.orphelin', { pid: Number.isFinite(pid) ? pid : '?' }))
    try { unlinkSync(lockPath) } catch {}
    // reboucle → nouvelle tentative de tryClaim
  }
  if (!acquired) {
    console.error(t('cli.dev-lock.echec-acquisition', { chemin: lockPath }))
    process.exit(1)
  }

  const cleanup = (): void => { try { unlinkSync(lockPath) } catch {} }
  // `onShutdown` (feat. render.routes en `mjs dev`, cli.ts) — ferme les
  // ressources async ouvertes AU-DESSUS de ce module (le RenderHandler créé par
  // cli.ts, cf. son commentaire) AVANT de libérer le lock et de sortir. DOIT
  // passer par ICI (pas un `process.on('SIGINT', …)` séparé posé APRÈS cet
  // appel) : un `process.exit()` synchrone dans un listener met fin au process
  // avant que Node n'atteigne les listeners SUIVANTS du MÊME événement — un 2e
  // handler enregistré plus tard ne tournerait donc JAMAIS. `cleanup()` reste
  // TOUJOURS exécuté même si `onShutdown` throw (le lock doit se libérer coûte
  // que coûte — c'est sa seule responsabilité NON négociable).
  const shutdown = async (): Promise<void> => {
    try { await onShutdown?.() } catch { /* best-effort : le lock doit toujours se libérer */ }
    cleanup()
    process.exit(0)
  }
  process.on('exit', cleanup)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGHUP', shutdown)
}
