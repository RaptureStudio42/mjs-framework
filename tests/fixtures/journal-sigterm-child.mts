// fixture — process ENFANT de tests/journal-sigterm.test.ts. Enregistre UNE entrée dans un
// journal (dossier reçu en argv), puis s'AUTO-ENVOIE SIGTERM — sans le hook ensureSigtermHook()
// (journal.ts), le débounce (1s) n'a jamais l'occasion de tourner : le fichier NDJSON resterait
// vide. Le setInterval n'est JAMAIS .unref() : lui seul garde la boucle d'événements en vie — SEUL
// le signal doit terminer ce process, jamais un drain naturel (qui déclencherait le hook 'exit'
// PRÉEXISTANT et fausserait le test en masquant l'absence du hook SIGTERM).

import { createJournal } from '../../src/server/journal.js'

const dir     = process.argv[2]
const message = process.argv[3]

const journal = createJournal({ dir })
journal.record('server', { message, pile: 'Error: fixture journal-sigterm\n  at x', url: '/fixture' })

setInterval(() => {}, 1000)
process.kill(process.pid, 'SIGTERM')
