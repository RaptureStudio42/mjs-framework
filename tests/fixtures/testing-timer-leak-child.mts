// Fixture PROCESS ENFANT (src/testing/index.ts) — même motif que
// ssr-timer-leak-child.mts, pour l'AUTRE point : le harnais de test des
// applications (`createHarness().destroy()`) fermait sa Window happy-dom via `window.close()`
// (no-op), exactement comme renderToString.ts. N'appelle JAMAIS `process.exit()` : un timer qui
// fuit empêche ce process de se terminer tout seul.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness } from '../../src/testing/index.js'

const srcDir = process.argv[2]
mkdirSync(srcDir, { recursive: true })
writeFileSync(join(srcDir, 'ticker.mjs'), `
<script lang="coffee">
µeffect ->
  setInterval((-> null), 5)
</script>
<p>ticker</p>
`)
const app = await createHarness({ sourceDir: srcDir })
await app.mount('ticker')
await app.destroy()
console.log('MJS_LOT3_S21_TESTING_DONE')
// pas de process.exit() ici, volontairement : c'est tout le point du test
