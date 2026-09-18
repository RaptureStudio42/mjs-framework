// fuite constatée : 133 fichiers tests/*.test.ts appellent
// mkdtempSync(join(tmpdir(), 'mjs-…')) directement, seuls 5 nettoient — 2 616 dossiers
// /tmp/mjs-* (1,1 Go) en ~12h de session ; nouveau test ⇒ mjsTmp(prefix) au lieu du
// mkdtempSync à la main, le dossier est enregistré et purgé par sweepRegistered()
// (after() local, cf. tests/config.test.ts, ou balai global tests/helpers/tmp-sweep.ts)

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const registered: string[] = []
let hooked = false

// Le balai global tests/helpers/tmp-sweep.ts n'est charge que par
// --require (script npm "test"). Un mocha CIBLE lance a la main ne l'a pas, et laissait
// donc les dossiers derriere lui — /tmp est un tmpfs, c'est de la RAM. D'ou ce after()
// pose par le helper LUI-MEME, une seule fois, AU CHARGEMENT du module : n'importe quelle
// invocation de mocha nettoie desormais, --require ou pas. Hors mocha (script isole), la
// globale after() n'existe pas : on ne pose rien, sweepRegistered() reste appelable a la main.
// Au chargement et pas au premier appel : un after() pose PENDANT un it() n'est jamais execute.
function hookOnce(): void {
  if(hooked) return
  const g = globalThis as { after?: (fn: () => void) => void }
  if(typeof g.after !== 'function') return
  hooked = true
  g.after(() => sweepRegistered())
}

export function mjsTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mjs-'+ prefix +'-'))
  registered.push(dir)
  return dir
}

hookOnce()

export function sweepRegistered(): void {
  for (const dir of registered) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
  registered.length = 0
}
