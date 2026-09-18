#!/usr/bin/env bash

# enclos mémoire du harnais de test : mocha ne tourne JAMAIS en direct, toujours dans un cgroup
# borné. Motif : une assertion qui compare un nœud DOM vivant à `null` fabrique son
# message d'échec en inspectant tout le graphe happy-dom — 14 Go en deux secondes, run tué par le
# noyau, machine à genoux 1 h 23. Sous enclos, la même bombe meurt seule en 3 s sans emporter la
# machine. Réglages par variables d'environnement :
#   MJS_TEST_MEM      plafond mémoire du run entier (défaut 4G)
#   MJS_TEST_MAXSEC   garde-temps du GROUPE en secondes, 0 = aucune (défaut 0) — tue aussi les
#                     mocha orphelins, ce qu'un `timeout npm test` ne sait pas faire
# Sans systemd utilisateur (CI, conteneur, bac à sable), garde mémoire de repli : la mémoire réelle
# (RSS cumulée) de l'arbre de processus de mocha est relevée toutes les 0,5 s, et l'arbre entier tué
# au-delà de MJS_TEST_MEM, avec le même verdict ; MJS_TEST_MAXSEC n'y est pas appliqué.
# TMPDIR COURT obligatoire (ex. /tmp/claude-1000/t1) : tsx ouvre une socket sous TMPDIR et un chemin
# long donne `listen EINVAL … .pipe` sur 7 tests, faux rouges sans rapport avec le code.
# Arguments : sans argument, la suite complète ; avec, les seuls fichiers passés.
#   npm test                              → tout
#   npm test -- tests/csp-runtime.test.ts → ce fichier seul, sous enclos

set -uo pipefail

MEM="${MJS_TEST_MEM:-4G}"
MAXSEC="${MJS_TEST_MAXSEC:-0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- 1. Commande mocha (spécifique si on nous passe des fichiers, suite complète sinon) ---

MOCHA=("$ROOT/node_modules/.bin/mocha" --require tsx/esm --require "$ROOT/tests/helpers/tmp-sweep.ts" --exit)
if [ "$#" -gt 0 ]; then MOCHA+=("$@")
else MOCHA+=(--recursive "$ROOT/tests/" --extension ts)
fi

# --- 2. Verdict d'un run tué (enclos ou garde de repli) ---

verdict() {
  echo
  echo "💥 run tué par $1 (code $2) — plafond $MEM crevé$3."
  echo "   Suspect nº1 : une assertion qui compare un nœud DOM à null et vient d'échouer"
  echo "   (cf. tests/helpers/dom-assert.ts → assertAbsent). La machine, elle, n'a rien senti."
}

# --- 3. Enclos indisponible : garde mémoire de repli ---

# plafond au format de MemoryMax (octets, K/M/G/T en base 1024, % de la mémoire totale) → Ko ; vide si illisible
mem_kb() {
  if [[ "$1" =~ ^([0-9]+)([KMGT]?)$ ]]; then
    local n="$(( 10#${BASH_REMATCH[1]} ))"
    case "${BASH_REMATCH[2]}" in
      K) echo "$n" ;;
      M) echo "$(( n * 1024 ))" ;;
      G) echo "$(( n * 1024 * 1024 ))" ;;
      T) echo "$(( n * 1024 * 1024 * 1024 ))" ;;
      *) echo "$(( n / 1024 ))" ;;
    esac
  elif [[ "$1" =~ ^([0-9]+)%$ ]]; then
    awk -v p="${BASH_REMATCH[1]}" '/^MemTotal:/ { print int($2 * p / 100) }' /proc/meminfo
  fi
}

# date de départ d'un processus en tops d'horloge depuis le démarrage (champ 22 de /proc/<pid>/stat, après le nom
# entre parenthèses) : identité plus fine qu'un numéro, qui peut être repris ; vide si le processus n'existe plus
STARTED_AWK='function started(pid,   line, n, part, f) {
  if((getline line < ("/proc/" pid "/stat")) <= 0) return ""
  close("/proc/" pid "/stat")
  n = split(line, part, ") ")
  split(part[n], f, " ")
  return f[20]
}'

started_at() {
  awk -v pid="$1" "$STARTED_AWK"' BEGIN { print started(pid) }'
}

# pid et RSS (Ko) de $1 et de chacun de ses descendants encore vivants ; rien si $1 est mort, zombie, ou si son
# numéro a été repris par un autre processus (date de départ différente de $2)
tree_rss() {
  ps -eo pid=,ppid=,rss=,stat= | awk -v root="$1" -v start="$2" "$STARTED_AWK"'
    { parent[$1] = $2; rss[$1] = $3; state[$1] = $4 }
    END {
      if(!(root in parent) || state[root] ~ /^Z/ || started(root) != start) exit
      keep[root] = 1
      do {
        added = 0
        for(p in parent) if(!(p in keep) && (parent[p] in keep)) { keep[p] = 1; added++ }
      } while(added)
      for(p in keep) if(state[p] !~ /^Z/) print p, rss[p]
    }'
}

# repère mocha (l'autre enfant de ce script) dès qu'il apparaît et note sa date de départ, puis relève son arbre
# toutes les 0,5 s jusqu'à sa mort, que le script soit encore là ou non : tué seul, il ne doit pas emporter la
# surveillance ; au-delà du plafond, tue l'arbre entier d'un coup (un enfant tué après son parent serait déjà
# rattaché ailleurs) et sort en 99 — sourde à l'arrêt que lui envoie le script dès la mort de mocha, pour que ce 99
# lui parvienne
guard() {
  local self="$BASHPID" root="" start total pid rss
  local -a pids
  while [ -z "$root" ]; do
    [ -e "/proc/$$" ] || exit 0
    root="$(ps -o pid= --ppid "$$" | awk -v self="$self" '$1 != self { print $1; exit }')"
    [ -n "$root" ] || sleep 0.1
  done
  start="$(started_at "$root")"
  if [ -z "$start" ]; then
    if [ -n "$(ps -o pid= -p "$root")" ]; then echo "⚠  garde mémoire : date de départ de mocha illisible dans /proc/$root/stat — run poursuivi SANS garde mémoire" >&2; fi
    exit 0
  fi
  while :; do
    total=0
    pids=()
    while read -r pid rss; do
      pids+=("$pid")
      total=$(( total + rss ))
    done < <(tree_rss "$root" "$start")
    [ "${#pids[@]}" -gt 0 ] || exit 0
    if [ "$total" -gt "$LIMIT_KB" ]; then
      trap '' TERM
      echo "🛑 garde mémoire : $(( total / 1024 )) Mo relevés sur l'arbre mocha, plafond $MEM — arrêt du run" >&2
      kill -KILL "${pids[@]}"
      exit 99
    fi
    sleep 0.5
  done
}

if ! systemd-run --user --scope --quiet -- /bin/true >/dev/null 2>&1; then
  if [ "$MEM" = 'infinity' ]; then
    echo "⚠  enclos cgroup indisponible (pas de systemd utilisateur) — MJS_TEST_MEM=infinity : tests lancés sans plafond mémoire"
    "${MOCHA[@]}"
    exit $?
  fi
  LIMIT_KB="$(mem_kb "$MEM")"
  if [ -z "$LIMIT_KB" ] || [ "$LIMIT_KB" -le 0 ] || ! command -v ps >/dev/null || ! command -v awk >/dev/null || [ ! -r /proc/self/stat ]; then
    echo "⚠  enclos cgroup indisponible (pas de systemd utilisateur) et garde mémoire de repli impossible (plafond MJS_TEST_MEM « $MEM » illisible, ou ps, awk, /proc absents) — tests lancés SANS garde mémoire"
    "${MOCHA[@]}"
    exit $?
  fi
  echo "⚠  enclos cgroup indisponible (pas de systemd utilisateur) — garde mémoire de repli : arbre mocha relevé toutes les 0,5 s, tué au-delà de $MEM"
  guard &
  GUARD=$!
  "${MOCHA[@]}"
  CODE=$?
  if [ -e "/proc/$GUARD" ]; then kill "$GUARD"; fi
  wait "$GUARD"
  FIRED=$?
  if [ "$FIRED" -eq 99 ] && [ "$CODE" -ge 128 ]; then verdict 'la garde mémoire de repli' "$CODE" ''; fi
  exit $CODE
fi

# --- 4. Run sous enclos ---

SCOPE=(systemd-run --user --scope --quiet --collect -p MemoryMax="$MEM" -p MemorySwapMax=0)
if [ "$MAXSEC" != "0" ]; then SCOPE+=(-p RuntimeMaxSec="$MAXSEC"); fi

echo "🧪 enclos cgroup : mémoire max $MEM, swap interdit$([ "$MAXSEC" != "0" ] && echo ", $MAXSEC s max")"
"${SCOPE[@]}" -- "${MOCHA[@]}"
CODE=$?

# --- 5. Verdict ---

if [ "$CODE" -ge 128 ]; then verdict "l'enclos" "$CODE" ' ou garde-temps atteint'; fi

exit $CODE
