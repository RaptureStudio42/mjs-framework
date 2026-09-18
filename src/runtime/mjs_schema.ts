// mjs_schema — µschema côté CLIENT : registre binaire à schéma, patch externe de MjsSocket.prototype
// (même patron que mjs_game.ts) + une poignée de points d'extension MINIMES dans mjs_socket.ts (hello,
// binaryType, réception binaire — SIGNALÉS dans LEURS propres commentaires). mjs_socket.ts
// DOIT être chargé AVANT ce fichier (ordre canonique du bundler, cf. src/bundler/index.ts
// resolveRuntimeFiles) pour que ces points d'extension trouvent µ._mjschemaXxx déjà posés — sans lui,
// µ.schema()/µ.list()/µ.bits() restent quand même utilisables (registre pur, zéro dépendance à
// MjsSocket) : seul le branchement réseau reste inerte (cf. bundler — avertissement 'schema' sans
// 'socket', même esprit que 'game' sans 'socket').
//
// PORT FIDÈLE de src/schema/core.ts — PAS un import : les fichiers src/runtime/mjs_*.ts sont
// concaténés tels quels (JS pur, zéro import/export, cf. bundler/index.ts::bundleRuntime « on peut
// concaténer directement, esbuild passerait en mode ESM avec wrapping qui collisionne ») et exécutés
// via `new Function('µ', src)` dans les tests (cf. tests/socket-game.test.ts) — aucune résolution de
// module n'a jamais lieu ici. Même compromis que le protocole µ: tout entier : client (ici) et serveur
// (src/mjs-ws/schema.ts, qui LUI importe réellement core.ts) sont deux implémentations INDÉPENDANTES
// d'accord sur un même contrat, jamais un fichier partagé à l'exécution. Algorithme, enveloppe fil
// ([u8 idSchéma][charge], DataView little-endian, chaînes préfixées en OCTETS UTF-8) et hash FNV-1a
// copiés depuis core.ts — hashRegistre() DOIT produire EXACTEMENT le même hash qu'un registre serveur
// miroir (mêmes noms/types/ORDRE), sinon le serveur croit à un désaccord et pousse µ:schema à CHAQUE
// hello. Simplification volontaire vs core.ts : pas de suggestion Levenshtein sur un type de champ
// inconnu (poids mort pour un module client, message d'erreur simple à la place) — tout le reste
// (garde AJOUT-SEUL, tolérance champ manquant → zéro, throw structurel sur schéma/id inconnu) identique.
//
//   µ.schema('pos', { x: 'i16', y: 'i16' })        # déclare/complète le registre CLIENT — UN SEUL
//                                                     par appli, jamais par socket (µ._mjs_mjschemaRegistre)
//   µ.list('str8') / µ.bits(['vivant', 'vip'])      # mêmes helpers que côté serveur (mjs-framework/ws)
//   sock = µ.socket(url)                             # hello porte schemaHash si un registre existe
//   sock.send('pos', { x: 1, y: 2 })                 # binaire AUTOMATIQUE si 'pos' a un schéma déclaré
//   sock.on('pos', (p) -> …)                          # AUCUNE différence, binaire ou JSON — invisible
//
// Déclaration PARTAGÉE (recommandé) : un fichier .mjs/.civet/.js commun à l'appli, importé À LA FOIS
// par l'entry serveur (`app.schema(...)`, cf. docs/23-mjs-ws.md §3.1) et un composant client
// (`µ.schema(...)`) — MÊMES noms/types/ORDRE des deux côtés ⇒ MÊME hash ⇒ jamais de µ:schema poussée.
// Alternative paresseuse : ne rien déclarer côté client — hello porte quand même un schemaHash (celui
// du registre VIDE, cf. µ._mjs_mjschemaHelloHash), qui ne concordera JAMAIS avec un serveur qui a des
// schémas → celui-ci pousse µ:schema à CHAQUE connexion (1 aller-retour de plus, zéro fichier à tenir
// synchronisé à la main).
//
// binary:false — coupe-circuit ENVOI SEUL (cf. µ._mjs_mjschemaEncode) : `sock.send()` reste TOUJOURS JSON
// pour CE socket, quel que soit le schéma du type. La RÉCEPTION, elle, décode TOUJOURS une trame
// binaire entrante — l'encodage SORTANT est une décision 100% SERVEUR (`ws.codec`, cf.
// mjs-ws/core.ts::sendRaw), indépendante de ce que ce client annonce dans son hello ; un client qui
// arrêterait AUSSI de décoder deviendrait sourd aux messages légitimes dès que le serveur encode en
// binaire — seul l'envoi est un choix local sûr à couper.
//
// Limite ACTÉE (cf. src/schema/core.ts) : l'enveloppe binaire ne porte AUCUN id de
// corrélation → jamais utilisée pour sock.request() (accusés de réception, rares) — un frame avec
// `id` reste TOUJOURS JSON, même si son type a un schéma déclaré (cf. µ._mjs_mjschemaEncode).

// --- registre pur (port de src/schema/core.ts) ---------------------------------------------------

var MJSCHEMA_SCALAIRES = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32', 'f64', 'bool', 'str8', 'str16'];

// garde anti-pollution locale (réutilisable indépendamment de mjs_socket.ts, cf. tête de fichier —
// 'schema' peut être sélectionné SANS 'socket') : un segment de chemin issu du réseau (µ:schema) ne
// doit jamais devenir __proto__/constructor/prototype, même reconstruit à la volée ci-dessous.
function _mjschemaSafeKey(k) {
  return k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
}

function _mjschemaValiderType(nomSchema, nomChamp, type) {
  if (typeof type === 'string') {
    if (MJSCHEMA_SCALAIRES.indexOf(type) !== -1) { return; }
    throw new Error('[µ.schema] schéma \'' + nomSchema + '\', champ \'' + nomChamp + '\' : type inconnu \'' + type + '\' — types valides : ' + MJSCHEMA_SCALAIRES.join(', ') + ', list(type), bits([noms])');
  }
  if (type.kind === 'list') {
    if (MJSCHEMA_SCALAIRES.indexOf(type.of) === -1) { throw new Error('[µ.schema] schéma \'' + nomSchema + '\', champ \'' + nomChamp + '\' : list() attend un type scalaire (' + MJSCHEMA_SCALAIRES.join(', ') + ') — sous-schémas/list imbriquée non supportés, reçu \'' + type.of + '\''); }
    return;
  }
  if (type.kind === 'bits') {
    if (!Array.isArray(type.noms) || type.noms.length === 0) { throw new Error('[µ.schema] schéma \'' + nomSchema + '\', champ \'' + nomChamp + '\' : bits() attend un tableau de noms non vide'); }
    if (type.noms.length > 8) { throw new Error('[µ.schema] schéma \'' + nomSchema + '\', champ \'' + nomChamp + '\' : bits() accepte au plus 8 booléens (reçu ' + type.noms.length + ')'); }
    // parité serveur (src/schema/core.ts::validerType) — des noms en double étaient
    // acceptés ICI et refusés côté serveur : même refus, même id attribué en vain sinon.
    if (new Set(type.noms).size !== type.noms.length) { throw new Error('[µ.schema] schéma \'' + nomSchema + '\', champ \'' + nomChamp + '\' : bits() — noms en double'); }
    return;
  }
  throw new Error('[µ.schema] schéma \'' + nomSchema + '\', champ \'' + nomChamp + '\' : type de champ invalide (ni chaîne scalaire, ni list(), ni bits())');
}

function _mjschemaMemeType(a, b) {
  if (typeof a === 'string' || typeof b === 'string') { return a === b; }
  if (a.kind !== b.kind) { return false; }
  if (a.kind === 'list') { return a.of === b.of; }
  if (a.noms.length !== b.noms.length) { return false; }
  for (var i = 0; i < a.noms.length; i++) { if (a.noms[i] !== b.noms[i]) { return false; } }
  return true;
}

function _mjschemaMemeForme(a, b) {
  var ka = Object.keys(a), kb = Object.keys(b), i;
  if (ka.length !== kb.length) { return false; }
  for (i = 0; i < ka.length; i++) { if (ka[i] !== kb[i] || !_mjschemaMemeType(a[ka[i]], b[kb[i]])) { return false; } }
  return true;
}

function _mjschemaDecrireType(t) {
  if (typeof t === 'string') { return t; }
  return t.kind === 'list' ? ('list(' + t.of + ')') : ('bits(' + t.noms.join('+') + ')');
}

function mjschemaCreerRegistre() {
  return { parNom: new Map(), parId: [] };
}

/** cf. defSchema (src/schema/core.ts) — même garde AJOUT-SEUL, mêmes ids u8 attribués dans l'ORDRE
 *  de déclaration ; ré-affirmation IDENTIQUE = no-op silencieux (composant remonté/HMR), forme
 *  DIFFÉRENTE = throw clair. */
function mjschemaDefSchema(registre, nom, champs) {
  var ordre = Object.keys(champs), i, existant, def;
  for (i = 0; i < ordre.length; i++) { _mjschemaValiderType(nom, ordre[i], champs[ordre[i]]); }

  existant = registre.parNom.get(nom);
  if (existant) {
    if (!_mjschemaMemeForme(existant.champs, champs)) {
      throw new Error('[µ.schema] schéma \'' + nom + '\' déjà déclaré avec une forme différente — garde AJOUT-SEUL : un schéma existant est IMMUABLE, déclare un NOM neuf pour faire évoluer le protocole.');
    }
    return existant;
  }
  if (registre.parId.length >= 256) { throw new Error('[µ.schema] registre plein — 256 schémas déjà déclarés (id u8 épuisé), impossible d\'ajouter \'' + nom + '\''); }
  def = { id: registre.parId.length, nom: nom, champs: champs, ordre: ordre };
  registre.parNom.set(nom, def);
  registre.parId.push(def);
  return def;
}

// --- encodage/décodage bas niveau — DataView little-endian, deux passes (mesure puis écriture) ----

var _mjschemaUtf8Encoder = new TextEncoder();
var _mjschemaUtf8Decoder = new TextDecoder('utf-8');

function _mjschemaTailleScalaireFixe(t) {
  switch (t) {
    case 'u8': case 'i8': case 'bool': return 1;
    case 'u16': case 'i16': return 2;
    case 'u32': case 'i32': case 'f32': return 4;
    case 'f64': return 8;
    default: return null;
  }
}

// nombre fini par défaut — une valeur absente/non numérique s'encode en 0 plutôt que de faire planter
// l'envoi (même politique de tolérance que src/schema/core.ts::numOr0).
function _mjschemaNumOr0(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

function _mjschemaMesurerScalaire(t, valeur) {
  var fixe = _mjschemaTailleScalaireFixe(t), octets, max;
  if (fixe != null) { return fixe; }
  octets = _mjschemaUtf8Encoder.encode(String(valeur == null ? '' : valeur));
  max = t === 'str8' ? 255 : 65535;
  if (octets.byteLength > max) { throw new Error('[µ.schema] chaîne trop longue pour ' + t + ' (' + octets.byteLength + ' octets UTF-8, max ' + max + ')'); }
  return (t === 'str8' ? 1 : 2) + octets.byteLength;
}

function _mjschemaMesurerChamp(type, valeur) {
  var arr, total, i;
  if (typeof type === 'string') { return _mjschemaMesurerScalaire(type, valeur); }
  if (type.kind === 'bits') { return 1; }
  arr = Array.isArray(valeur) ? valeur : [];
  if (arr.length > 65535) { throw new Error('[µ.schema] list(' + type.of + ') : ' + arr.length + ' éléments, max 65535 (compteur u16)'); }
  total = 2;
  for (i = 0; i < arr.length; i++) { total += _mjschemaMesurerScalaire(type.of, arr[i]); }
  return total;
}

function _mjschemaEcrireScalaire(vue, offset, t, valeur) {
  var octets;
  switch (t) {
    case 'u8':   vue.setUint8(offset, _mjschemaNumOr0(valeur) & 0xFF); return offset + 1;
    case 'i8':   vue.setInt8(offset, _mjschemaNumOr0(valeur)); return offset + 1;
    case 'bool': vue.setUint8(offset, valeur ? 1 : 0); return offset + 1;
    case 'u16':  vue.setUint16(offset, _mjschemaNumOr0(valeur), true); return offset + 2;
    case 'i16':  vue.setInt16(offset, _mjschemaNumOr0(valeur), true); return offset + 2;
    case 'u32':  vue.setUint32(offset, _mjschemaNumOr0(valeur), true); return offset + 4;
    case 'i32':  vue.setInt32(offset, _mjschemaNumOr0(valeur), true); return offset + 4;
    case 'f32':  vue.setFloat32(offset, _mjschemaNumOr0(valeur), true); return offset + 4;
    case 'f64':  vue.setFloat64(offset, _mjschemaNumOr0(valeur), true); return offset + 8;
    case 'str8': case 'str16':
      octets = _mjschemaUtf8Encoder.encode(String(valeur == null ? '' : valeur));
      if (t === 'str8') { vue.setUint8(offset, octets.byteLength); offset += 1; }
      else { vue.setUint16(offset, octets.byteLength, true); offset += 2; }
      new Uint8Array(vue.buffer, vue.byteOffset + offset, octets.byteLength).set(octets);
      return offset + octets.byteLength;
  }
}

function _mjschemaEcrireChamp(vue, offset, type, valeur) {
  var octet, i, arr;
  if (typeof type === 'string') { return _mjschemaEcrireScalaire(vue, offset, type, valeur); }
  if (type.kind === 'bits') {
    octet = 0;
    for (i = 0; i < type.noms.length; i++) { if (valeur && valeur[type.noms[i]]) { octet |= (1 << i); } }
    vue.setUint8(offset, octet);
    return offset + 1;
  }
  arr = Array.isArray(valeur) ? valeur : [];
  vue.setUint16(offset, arr.length, true);
  offset += 2;
  for (i = 0; i < arr.length; i++) { offset = _mjschemaEcrireScalaire(vue, offset, type.of, arr[i]); }
  return offset;
}

// SÉCURITÉ — port de bornerLecture (src/schema/core.ts) : `vue` peut être la
// fenêtre d'un buffer PLUS GRAND (transport WebSocket, tampon partagé) — sans cette garde, un str8/
// str16 dont la longueur annoncée dépasse la fenêtre lit des octets VOISINS hors trame (fuite heap),
// et un compteur de list trop grand lève un RangeError brut du DataView, non nommé.
function _mjschemaBornerLecture(offset, taille, vue) {
  if (offset + taille > vue.byteLength) { throw new RangeError('[µ.schema] decode() : lecture hors de la trame (offset ' + offset + ', ' + taille + ' octets, trame de ' + vue.byteLength + ')'); }
}

function _mjschemaLireScalaire(vue, offset, t) {
  var len, octets;
  switch (t) {
    case 'u8':   _mjschemaBornerLecture(offset, 1, vue); return [vue.getUint8(offset), offset + 1];
    case 'i8':   _mjschemaBornerLecture(offset, 1, vue); return [vue.getInt8(offset), offset + 1];
    case 'bool': _mjschemaBornerLecture(offset, 1, vue); return [vue.getUint8(offset) !== 0, offset + 1];
    case 'u16':  _mjschemaBornerLecture(offset, 2, vue); return [vue.getUint16(offset, true), offset + 2];
    case 'i16':  _mjschemaBornerLecture(offset, 2, vue); return [vue.getInt16(offset, true), offset + 2];
    case 'u32':  _mjschemaBornerLecture(offset, 4, vue); return [vue.getUint32(offset, true), offset + 4];
    case 'i32':  _mjschemaBornerLecture(offset, 4, vue); return [vue.getInt32(offset, true), offset + 4];
    case 'f32':  _mjschemaBornerLecture(offset, 4, vue); return [vue.getFloat32(offset, true), offset + 4];
    case 'f64':  _mjschemaBornerLecture(offset, 8, vue); return [vue.getFloat64(offset, true), offset + 8];
    case 'str8': case 'str16':
      if (t === 'str8') { _mjschemaBornerLecture(offset, 1, vue); len = vue.getUint8(offset); offset += 1; }
      else { _mjschemaBornerLecture(offset, 2, vue); len = vue.getUint16(offset, true); offset += 2; }
      _mjschemaBornerLecture(offset, len, vue);
      octets = new Uint8Array(vue.buffer, vue.byteOffset + offset, len);
      return [_mjschemaUtf8Decoder.decode(octets), offset + len];
  }
}

function _mjschemaLireChamp(vue, offset, type) {
  var octet, out, i, n, res;
  if (typeof type === 'string') { return _mjschemaLireScalaire(vue, offset, type); }
  if (type.kind === 'bits') {
    _mjschemaBornerLecture(offset, 1, vue);
    octet = vue.getUint8(offset);
    out = {};
    for (i = 0; i < type.noms.length; i++) { out[type.noms[i]] = !!(octet & (1 << i)); }
    return [out, offset + 1];
  }
  _mjschemaBornerLecture(offset, 2, vue);
  n = vue.getUint16(offset, true);
  offset += 2;
  out = [];
  for (i = 0; i < n; i++) {
    res = _mjschemaLireScalaire(vue, offset, type.of);
    out.push(res[0]);
    offset = res[1];
  }
  return [out, offset];
}

// --- API haut niveau — encode(nom, objet) / decode(bytes), enveloppe [u8 id][charge] --------------

function mjschemaEncode(registre, nom, objet) {
  var def = registre.parNom.get(nom), o, taille, i, c, tampon, vue, offset;
  if (!def) { throw new Error('[µ.schema] encode() : schéma inconnu \'' + nom + '\' — déclare-le d\'abord (µ.schema)'); }
  o = objet || {};
  taille = 1;
  for (i = 0; i < def.ordre.length; i++) { taille += _mjschemaMesurerChamp(def.champs[def.ordre[i]], o[def.ordre[i]]); }
  tampon = new ArrayBuffer(taille);
  vue = new DataView(tampon);
  vue.setUint8(0, def.id);
  offset = 1;
  for (i = 0; i < def.ordre.length; i++) { c = def.ordre[i]; offset = _mjschemaEcrireChamp(vue, offset, def.champs[c], o[c]); }
  return new Uint8Array(tampon);
}

/** `bytes` peut être une VUE (sous-tableau) d'un buffer plus grand — DataView construite avec
 *  byteOffset/byteLength explicites, jamais `bytes.buffer` seul (cf. src/schema/core.ts::decode). */
function mjschemaDecode(registre, bytes) {
  var id, def, vue, offset, objet, i, c, res;
  if (bytes.byteLength < 1) { throw new Error('[µ.schema] decode() : trame vide, octet id de schéma attendu'); }
  id = bytes[0];
  def = registre.parId[id];
  if (!def) { throw new Error('[µ.schema] decode() : id de schéma inconnu (' + id + ') — registre local incomplet ou désynchronisé'); }
  vue = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  offset = 1;
  objet = {};
  for (i = 0; i < def.ordre.length; i++) {
    c = def.ordre[i];
    res = _mjschemaLireChamp(vue, offset, def.champs[c]);
    objet[c] = res[0];
    offset = res[1];
  }
  return { nom: def.nom, objet: objet };
}

// --- hash stable du registre — FNV-1a 32 bits, hex — dépend des noms + types + ORDRE de déclaration,
// DOIT rester caractère pour caractère identique à src/schema/core.ts::fnv1a/hashRegistre (cf. tête
// de fichier : un désaccord d'algorithme entre client et serveur produirait un hash différent même
// pour des schémas IDENTIQUES, et le serveur pousserait µ:schema à CHAQUE hello sans raison réelle) --

function _mjschemaFnv1a(s) {
  var h = 0x811c9dc5, i;
  for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function mjschemaHashRegistre(registre) {
  var parts = [], i, def, ordreDecrit, j;
  for (i = 0; i < registre.parId.length; i++) {
    def = registre.parId[i];
    ordreDecrit = [];
    for (j = 0; j < def.ordre.length; j++) { ordreDecrit.push(def.ordre[j] + '=' + _mjschemaDecrireType(def.champs[def.ordre[j]])); }
    parts.push(def.nom + ':' + ordreDecrit.join(','));
  }
  return _mjschemaFnv1a(parts.join('|'));
}

// --- réception d'un µ:schema — reconstruit un registre COMPLET depuis des définitions JSON-safe (cf.
// mjs-ws/schema.ts::serialiserDefinitions côté serveur) : `champs` voyage en tableau de paires
// [nom, type] (pas un objet — les clés d'un message réseau ne sont jamais indexées aveuglément sur un
// objet PLAT, cf. _mjschemaSafeKey ci-dessous), rechargé via mjschemaDefSchema (mêmes gardes, mêmes
// ids puisque `schemas` est déjà dans l'ordre d'origine). ------------------------------------------

function mjschemaChargerDefinitions(json) {
  var registre = mjschemaCreerRegistre(), i, s, champs, j, paire;
  for (i = 0; i < json.schemas.length; i++) {
    s = json.schemas[i];
    champs = {};
    for (j = 0; j < s.champs.length; j++) {
      paire = s.champs[j];
      if (_mjschemaSafeKey(paire[0])) { champs[paire[0]] = paire[1]; }
    }
    mjschemaDefSchema(registre, s.nom, champs);
  }
  return registre;
}

// --- API applicative — µ.schema()/µ.list()/µ.bits(), UN SEUL registre CLIENT partagé par toute
// l'appli (jamais par socket, cf. tête de fichier) ---------------------------------------------

µ._mjs_mjschemaRegistre = null;

/** µ.schema(nom, champs) — déclare/complète le registre CLIENT (mêmes gardes que app.schema côté
 *  serveur, cf. docs/23-mjs-ws.md §3.1) : ré-affirmer À L'IDENTIQUE est un no-op (composant remonté),
 *  une forme DIFFÉRENTE lève clair. */
µ.schema = function(nom, champs) {
  if (!µ._mjs_mjschemaRegistre) { µ._mjs_mjschemaRegistre = mjschemaCreerRegistre(); }
  return mjschemaDefSchema(µ._mjs_mjschemaRegistre, nom, champs);
};

/** mêmes helpers que `import { list, bits } from 'mjs-framework/ws'` côté serveur — cf. docs/23-mjs-ws.md
 *  §3.1 pour le vocabulaire complet des types de champ. */
µ.list = function(of) { return { kind: 'list', of: of }; };
µ.bits = function(noms) { return { kind: 'bits', noms: noms }; };

// --- points d'extension consommés par mjs_socket.ts (cf. ses propres commentaires « extension
// MINIME » — absents si ce fichier n'est pas chargé, chaque call-site garde `if (µ._mjschemaXxx)`) --

// hello — hash du registre CLIENT courant, TOUJOURS une chaîne (même « rien de déclaré » a un hash —
// celui du registre VIDE) dès que ce module est chargé. VÉRIFIÉ AU BANC contre le serveur réel
// (mjs-ws/core.ts::pushSchemaIfMismatch) : `if (!schemaEngine.hasSchemas || clientHash == null) return`
// — le serveur ne pousse JAMAIS µ:schema si `clientHash` est ABSENT (« jamais de µ:schema pour rien »,
// cf. son propre commentaire), MÊME s'il a des schémas à offrir. Un client qui n'aurait rien déclaré
// et omettrait purement et simplement `schemaHash` resterait donc à vie SANS le registre serveur — le
// scénario de bootstrap paresseux (cf. tête de fichier « alternative paresseuse ») exige donc
// d'ANNONCER un hash MÊME vide, pour que le serveur détecte le désaccord et pousse sa définition.
µ._mjs_mjschemaHelloHash = function() {
  return mjschemaHashRegistre(µ._mjs_mjschemaRegistre || mjschemaCreerRegistre());
};

// envoi — `null` = rester JSON (comportement historique, cf. mjs_socket.ts::_mjs_rawSend). Binaire SSI : pas
// de coupe-circuit (sock.opts.binary !== false), jamais un frame à `id` (sock.request) ni `seq` (delta
// de flux — le fil binaire ne porte AUCUNE corrélation ni numéro de séquence, cf. tête de fichier),
// jamais une trame µ: de contrôle, ET le type a un schéma déclaré dans le registre CLIENT courant.
µ._mjs_mjschemaEncode = function(sock, obj) {
  var t, registre;
  if (sock.opts && sock.opts.binary === false) { return null; }
  if (obj.id != null || obj.seq != null) { return null; }
  t = obj.t;
  if (typeof t !== 'string' || t.indexOf('µ:') === 0) { return null; }
  registre = µ._mjs_mjschemaRegistre;
  if (!registre || !registre.parNom.has(t)) { return null; }
  try { return mjschemaEncode(registre, t, obj.p); }
  catch (e) { µ.error('[µ.schema] encodage en échec, envoi en JSON', e); return null; }
};

// id de schéma inconnu à la réception — averti UNE SEULE FOIS par id (pas 1 fois par trame, sinon un
// flux continu de trames illisibles spammerait la console), même esprit que le throttle serveur
// (mjs-ws/schema.ts::sendThrottledError) mais côté client (pas de fenêtre temporelle : juste jamais 2×).
var _mjschemaWarnedIds = {};
function _mjschemaWarnUnknownId(id) {
  if (_mjschemaWarnedIds[id]) { return; }
  _mjschemaWarnedIds[id] = true;
  µ.warn('[µ.schema] id de schéma inconnu (' + id + ') reçu — registre local désynchronisé (en attente d\'un µ:schema ?)');
}

// réception — trame BINAIRE (ArrayBuffer natif navigateur avec binaryType='arraybuffer', ou Uint8Array
// déjà normalisé par un transport de test, cf. mjs-ws/transport.ts) → décodée puis dispatchée dans le
// circuit sock.on NORMAL, EXACTEMENT comme un message texte (cf. MjsSocket.prototype._mjs_dispatch) —
// invisible pour l'appli. Aucun registre local, ou id hors registre : trame illisible, silence (même
// politique que le serveur en mode 'auto'/'json', cf. mjs-ws/schema.ts) plutôt qu'un crash.
µ._mjs_mjschemaOnBinary = function(sock, data) {
  var registre, bytes, id, decoded;
  if (µ._mjs_mjschemaSwapping) { µ._mjs_mjschemaBuffered.push({ sock: sock, data: data }); return; }
  registre = µ._mjs_mjschemaRegistre;
  if (!registre) { return; }
  bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 1) { return; }
  id = bytes[0];
  if (!registre.parId[id]) { _mjschemaWarnUnknownId(id); return; }
  try { decoded = mjschemaDecode(registre, bytes); }
  catch (e) { µ.error('[µ.schema] décodage en échec (trame corrompue ?)', e); return; }
  sock._mjs_dispatch(decoded.nom, { t: decoded.nom, p: decoded.objet });
};

// µ:schema reçu — remplace le registre CLIENT en bloc (chargerDefinitions reconstruit à partir de
// zéro, MÊMES ids que le serveur puisque `definitions.schemas` est déjà dans l'ordre d'origine). Court
// tampon anti-course : toute trame binaire reçue PENDANT le remplacement est rejouée juste
// après plutôt que perdue — en pratique JS est mono-thread et ce remplacement est 100% synchrone, donc
// aucune trame ne peut matériellement arriver entre les deux lignes ; filet de sécurité qui ne coûte
// rien plutôt qu'une course réellement observée au banc.
µ._mjs_mjschemaSwapping = false;
µ._mjs_mjschemaBuffered  = [];

µ._mjs_mjschemaOnPush = function(sock, msg) {
  var p = msg.p || {}, buffered, i;
  µ._mjs_mjschemaSwapping = true;
  try { µ._mjs_mjschemaRegistre = mjschemaChargerDefinitions(p.definitions); }
  catch (e) { µ.error('[µ.schema] définitions µ:schema invalides, registre local INCHANGÉ', e); }
  µ._mjs_mjschemaSwapping = false;
  buffered = µ._mjs_mjschemaBuffered;
  µ._mjs_mjschemaBuffered = [];
  for (i = 0; i < buffered.length; i++) { µ._mjs_mjschemaOnBinary(buffered[i].sock, buffered[i].data); }
};
