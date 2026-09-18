// mjs-ws/stats-page — page HTML « /state » : tableau de bord sombre, autonome (aucune
// ressource externe, <style>/<script> inline), servi par le pont (bridge.ts, GET /state) SEULEMENT
// si l'option `stats` de mjsWs() est active. La 1re peinture embarque l'instantané reçu en
// paramètre (pas d'attente réseau) ; une SEULE fonction de rendu (dans le <script>) sert ensuite
// aussi bien l'affichage initial que les rafraîchissements suivants (fetch('/stats') toutes les
// 2 s, même origine) — jamais deux gabarits à maintenir en double. Zéro attribut `style=` en ligne
// (règle nº1 MJS, cf. skill modularjs) : tout passe par les classes CSS ci-dessous, le JS ne
// touche que textContent/innerHTML.

import type { MjsWsStatsSnapshot } from './stats.js'
import { t, getMessagesLang } from '../messages/index.js'

// `</script>` dans une valeur embarquée ne doit JAMAIS fermer la balise prématurément — même
// piège que project_mjs_lexer_no_html_in_script, appliqué ici au JSON de l'instantané initial.
function escapeJsonForScript(json: string): string {
  return json.replace(/</g, '\\u003c')
}

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#111;color:#e4e4e4;padding:24px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
h1{font-size:18px;font-weight:600;margin:0 0 4px;letter-spacing:.02em}
.sub{color:#888;font-size:12px;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.card{background:#181818;border:1px solid #262626;border-radius:8px;padding:14px 16px}
.card h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#7aa2ff;margin:0 0 10px}
.row{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:13px;border-top:1px solid #1f1f1f}
.row:first-of-type{border-top:none}
.row span:first-child{color:#999}
.row span:last-child{font-variant-numeric:tabular-nums;color:#f0f0f0}
footer{margin-top:20px;color:#555;font-size:11px}
`.trim()

// familles affichées, dans l'ordre — [clé JSON, titre traduit, [[champ, libellé traduit], …]] ;
// latences et mémoire/uptime ont une forme différente (cf. render() plus bas), traitées à part.
// libellés résolus via t() À LA CONSTRUCTION du script (buildScript(), appelée PAR REQUÊTE par
// renderStatsPage — jamais au chargement du module, pour respecter la langue courante) ; les clés
// JSON ('connexions', 'actives', …) restent des littéraux, JAMAIS traduites (elles indexent
// l'instantané de stats.ts, cf. render() ci-dessous — un libellé traduit casserait ces accès).
function buildScript(): string {
  // locale factorisée UNE fois (posée ici, injectée 2× ci-dessous — fmt() et l'horodatage) —
  // même politique que t() : résolue PAR REQUÊTE, jamais figée au chargement du module.
  const locale = getMessagesLang() === 'en' ? 'en-US' : 'fr-FR'
  return `
var FAMILIES = [
  ['connexions', '${t('ws.stats.titre-connexions')}', [['actives','${t('ws.stats.champ-actives')}'],['parquees','${t('ws.stats.champ-parquees')}'],['accueillies','${t('ws.stats.champ-accueillies')}'],['refusees','${t('ws.stats.champ-refusees')}'],['refuseesPlafond','${t('ws.stats.champ-refusees-plafond')}'],['refuseesOrigine','${t('ws.stats.champ-refusees-origine')}'],['fermees','${t('ws.stats.champ-fermees')}']]],
  ['salons', '${t('ws.stats.titre-salons')}', [['nombre','${t('ws.stats.champ-nombre')}'],['membresTotal','${t('ws.stats.champ-membres-total')}'],['abonnesPresence','${t('ws.stats.champ-abonnes-presence')}']]],
  ['flux', '${t('ws.stats.titre-flux')}', [['nombre','${t('ws.stats.champ-nombre')}'],['deltasEmis','${t('ws.stats.champ-deltas-emis')}'],['resyncsRejeu','${t('ws.stats.champ-resyncs-rejeu')}'],['resyncsReset','${t('ws.stats.champ-resyncs-reset')}']]],
  ['messages', '${t('ws.stats.titre-messages')}', [['recus','${t('ws.stats.champ-recus')}'],['envoyes','${t('ws.stats.champ-envoyes')}'],['tamponnes','${t('ws.stats.champ-tamponnes')}'],['rejoues','${t('ws.stats.champ-rejoues')}'],['rejetes','${t('ws.stats.champ-rejetes')}'],['binaireRecues','${t('ws.stats.champ-binaire-recues')}'],['binaireIgnorees','${t('ws.stats.champ-binaire-ignorees')}']]],
  ['garde', '${t('ws.stats.titre-garde')}', [['kicksDebit','${t('ws.stats.champ-kicks-debit')}'],['kicksSilence','${t('ws.stats.champ-kicks-silence')}'],['kicksEngorgement','${t('ws.stats.champ-kicks-engorgement')}'],['kicksChargeUtile','${t('ws.stats.champ-kicks-charge-utile')}'],['expirationsJeton','${t('ws.stats.champ-expirations-jeton')}']]],
  ['pont', '${t('ws.stats.titre-pont')}', [['http401','401'],['rateLimited','${t('ws.stats.champ-rate-limited')}'],['webhooksEnvoyes','${t('ws.stats.champ-webhooks-envoyes')}'],['webhooksEchoues','${t('ws.stats.champ-webhooks-echoues')}'],['webhooksAbandonnes','${t('ws.stats.champ-webhooks-abandonnes')}']]],
  ['adaptateur', '${t('ws.stats.titre-adaptateur')}', [['publies','${t('ws.stats.champ-publies')}'],['recus','${t('ws.stats.champ-recus')}'],['ignoresOrigin','${t('ws.stats.champ-ignores-origin')}'],['reordonnances','${t('ws.stats.champ-reordonnances')}'],['reconnexions','${t('ws.stats.champ-reconnexions')}']]],
  ['sessions', '${t('ws.stats.titre-sessions')}', [['emises','${t('ws.stats.champ-emises')}'],['reprises','${t('ws.stats.champ-reprises')}'],['expirees','${t('ws.stats.champ-expirees')}'],['debordees','${t('ws.stats.champ-debordees')}']]]
]

function fmt(n) { return typeof n === 'number' ? n.toLocaleString('${locale}') : String(n) }

function card(title, rows) {
  var body = rows.map(function(r) { return '<div class="row"><span>'+ r[0] +'</span><span>'+ r[1] +'</span></div>' }).join('')
  return '<div class="card"><h2>'+ title +'</h2>'+ body +'</div>'
}

function render(data) {
  var cards = FAMILIES.map(function(f) {
    var fam  = data[f[0]] || {}
    var rows = f[2].map(function(fld) { return [fld[1], fmt(fam[fld[0]])] })
    return card(f[1], rows)
  })
  var lat = data.latences || {}
  cards.push(card('${t('ws.stats.titre-latences')}', [
    ['p50', lat.p50 == null ? '—' : fmt(lat.p50)],
    ['p95', lat.p95 == null ? '—' : fmt(lat.p95)],
    ['${t('ws.stats.champ-echantillon')}', fmt(lat.echantillon)]
  ]))
  cards.push(card('${t('ws.stats.titre-memoire')}', [
    ['uptime', fmt(data.uptime) +' s'],
    ['RSS', fmt(Math.round(((data.memoire && data.memoire.rss) || 0) / 1048576)) +' Mo'],
    ['process', data.processId]
  ]))
  document.getElementById('grid').innerHTML = cards.join('')
  document.getElementById('sub').textContent = '${t('ws.stats.sub-process')}'+ data.processId +'${t('ws.stats.sub-depuis')}'+ fmt(data.uptime) +'${t('ws.stats.sub-s')}'
  document.getElementById('ts').textContent = new Date(data.horodatage).toLocaleTimeString('${locale}')
}

function refresh() {
  fetch('/stats', { headers: { accept: 'application/json' } })
    .then(function(r) { return r.json() })
    .then(render)
    .catch(function() {})
}
`.trim()
}

/** Page HTML complète — cf. le commentaire de tête (gabarit UNIQUE, initial + rafraîchissements). */
export function renderStatsPage(snapshot: MjsWsStatsSnapshot): string {
  const initial = escapeJsonForScript(JSON.stringify(snapshot))
  return `<!doctype html>
<html lang="${getMessagesLang()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t('ws.stats.titre-page')}</title>
<style>
${CSS}
</style>
</head>
<body>
<h1>${t('ws.stats.titre-page')}</h1>
<p class="sub" id="sub"></p>
<div class="grid" id="grid"></div>
<footer>${t('ws.stats.pied-de-page')} <span id="ts"></span></footer>
<script>
${buildScript()}
var INITIAL_STATS = ${initial}
render(INITIAL_STATS)
setInterval(refresh, 2000)
</script>
</body>
</html>
`
}
