// fixture — process ENFANT de tests/journal-close.test.ts. Enregistre UNE entrée dans un journal
// (dossier reçu en argv), appelle close() ou non selon le mode, puis EFFACE le dossier et laisse
// le process se terminer naturellement. Le hook 'exit' de journal.ts rejoue alors les écritures
// encore débouncées, et writeAtomic RECRÉE le dossier disparu — c'est ce que close() doit couper.
// Extension .mts EXPRÈS (comme journal-sigterm-child.mts) : `mocha --extension ts` ne la charge pas.

import { rmSync } from 'node:fs'
import { createJournal } from '../../src/server/journal.js'

const dir  = process.argv[2]
const mode = process.argv[3]   // 'avec-close' | 'sans-close'

const journal = createJournal({ dir })
journal.record('server', { message: 'entree-debouncee', pile: 'Error: fixture journal-close\n  at x', url: '/fixture' })

if (mode === 'avec-close') journal.close()

// le ménage de l'appelant, joué AVANT que le process ne meure — exactement le scénario du test
// (after() de mocha) et du script shell qui enchaîne une commande puis un nettoyage de dossier
rmSync(dir, { recursive: true, force: true })
