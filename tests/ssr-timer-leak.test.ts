// SSR — un `setInterval`/`setTimeout` posé par un `µeffect` PENDANT le rendu ne doit
// PAS fuir après la fin de `renderToString()`. `window.close()` (API DOM standard, appelée par
// renderToString.ts avant ce correctif) est un NO-OP pour toute Window happy-dom créée nue (`new
// Window()`, jamais via `window.open()`) — le VRAI nettoyage vit sous `window.happyDOM.close()`.
//
// Méthode : un VRAI process enfant (jamais `process._getActiveHandles()` — sondé INFIABLE sur
// cette version de Node : même en fouillant à la main on n'y voyait aucun handle « Timeout » malgré 11
// tics/60ms bien réels observés en parallèle ; ni un monkey-patch de `globalThis.setInterval` —
// fragile à l'ordre d'import si un AUTRE fichier de la suite a déjà chargé 'happy-dom' en statique
// avant celui-ci). Le process enfant NE FAIT JAMAIS `process.exit()` : un VRAI timer Node qui fuit
// empêche le process de se terminer tout seul — c'est l'effet de bord RÉEL observé ici
// (dérive CPU/mémoire non bornée sur un serveur SSR long-vivant).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures/ssr-timer-leak-child.mts')

// `--import tsx` (UN SEUL process node, jamais `npx tsx` qui respawn à travers plusieurs niveaux
// et complique la remontée exacte du code/signal) — même patron que journal-sigterm.test.ts.
function lancerFixture(srcDir: string): Promise<{ code: number | null, signal: NodeJS.Signals | null, killedBySecurite: boolean }> {
  return new Promise((resolve, reject) => {
    const enfant = spawn(process.execPath, ['--import', 'tsx', FIXTURE, srcDir], { cwd: join(__dirname, '..'), stdio: 'ignore' })
    let killedBySecurite = false
    const securite = setTimeout(() => { killedBySecurite = true; enfant.kill('SIGKILL') }, 30000) //marge large : machine chargée, spawn+tsx+happy-dom peuvent déborder 6s sans fuite réelle
    enfant.on('error', (e) => { clearTimeout(securite); reject(e) })
    enfant.on('exit', (code, signal) => { clearTimeout(securite); resolve({ code, signal, killedBySecurite }) })
  })
}

describe('SSR renderToString — un µeffect->setInterval ne fuit plus après la fin du rendu', function () {
  this.timeout(45000) //couvre la marge de sécurité 30s + battement spawn/assertions

  it('le process enfant se termine TOUT SEUL après le rendu (pas de timer Node fantôme qui le maintient en vie)', async function () {
    const root = mjsTmp('timer-leak')
    const srcDir = join(root, 'src')
    const { code, signal, killedBySecurite } = await lancerFixture(srcDir)
    assert.equal(killedBySecurite, false,
      "le process enfant a dû être tué par le délai de sécurité — un setInterval posé par le µeffect a survécu à renderToString() (window.close() natif est un no-op happy-dom)")
    assert.equal(signal, null, `le process ne doit PAS avoir reçu de signal — sortie naturelle attendue (signal reçu : ${signal})`)
    assert.equal(code, 0, `le process enfant doit sortir avec le code 0 (reçu : ${code})`)
  })
})
