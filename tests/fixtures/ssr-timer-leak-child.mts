// Fixture PROCESS ENFANT — appelée par tests/ssr-timer-leak.test.ts via
// `spawn(process.execPath, ['--import', 'tsx', ...])`, JAMAIS chargée par Mocha elle-même
// (extension .mts, hors du glob `--extension ts` — même patron que journal-sigterm-child.mts).
// Rend un composant dont le `µeffect` pose un `setInterval` BRUT, ferme le renderer, puis
// n'appelle JAMAIS `process.exit()` : si le timer fuit réellement (VRAI timer Node, cf.
// renderToString.ts finally), ce process ne se termine JAMAIS tout seul — c'est le PARENT (le
// test) qui doit alors le tuer après un délai de sécurité. Sortie naturelle (code 0, aucun
// signal) = pas de fuite.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSSRRenderer } from '../../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../../src/bundler/index.js'

const srcDir = process.argv[2]
mkdirSync(srcDir, { recursive: true })
writeFileSync(join(srcDir, 'ticker.mjs'), `
<script lang="coffee">
µeffect ->
  setInterval((-> null), 5)
</script>
<p>ticker</p>
`)
const renderer = await createSSRRenderer({ sourceDir: srcDir })
await renderer.renderToString('mjs-ticker', { settleMs: 100 })
await renderer.close()
await terminateSharedWorkerPool()
console.log('MJS_LOT3_S21_DONE')
// pas de process.exit() ici, volontairement : c'est tout le point du test
