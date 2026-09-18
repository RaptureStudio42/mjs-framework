// runtime-labels — libellés par défaut (fr/en) des petits bouts d'UI émis DIRECTEMENT par le
// runtime navigateur (pas par le catalogue messages/, réservé au Node CLI/bundler/serveur — cf.
// src/messages/index.ts). Racine `src/` (à côté de sigils.ts) : importé côté BUNDLER/Node
// (bundler/index.ts) pour être sérialisé dans le manifest — jamais embarqué tel quel dans le
// bundle navigateur.
//
// Structure NAMESPACÉE (`modal: {...}`) délibérément, même si un seul groupe existe aujourd'hui —
// laisse la place à d'autres chaînes runtime qui migreraient un jour hors du texte en dur, sans
// re-designer la forme du manifest.
//
// Le manifest (writeManifest, bundler/index.ts) sérialise ICI TOUTES les
// langues (posé INCONDITIONNELLEMENT, contrairement à `µ._i18nData` qui ne s'émet que si
// `sourceDir/i18n/` existe : les libellés de modale doivent être dans TOUS les builds) : plus une
// seule langue figée au build. Le choix de la langue AFFICHÉE se fait au runtime, via
// `µ._mjs_label(group, key)`/`µ._mjs_labelLang()` (mjs_init.ts) — consommateurs mjs_modal.ts (groupes
// modal/toast), mjs_router.ts (groupe router) et mjs_ujs.ts (groupe ujs, panneau 404 + échec
// d'envoi).
//
// SURCHARGE PROJET : cette table n'est que le DERNIER recours. `µ._mjs_label`
// consulte D'ABORD le dictionnaire i18n du projet (`µ._mjs_i18nLookup`, mjs_i18n.ts) sur une clé racine
// réservée `mjs.<groupe>.<clé>` (ex. `mjs.toast.success`, `mjs.modal.cancel`) — utile pour une
// langue absente d'ici (allemand, espagnol…) ou pour changer un seul mot sans toucher ce fichier.
// Cf. docs/29-i18n.md « Libellés du framework ».
export const RUNTIME_LABELS = {
  fr: {
    modal:  { ok: 'OK', cancel: 'Annuler', deny: 'Non' },
    router: { notFound: 'Page introuvable', noRoute: 'Aucune route ne correspond à cette adresse.', declared: 'Routes déclarées' },
    toast:  { success: 'Succès', error: 'Erreur', warning: 'Attention', info: 'Info' },
    ujs:    { sendFailed: 'Échec de l\'envoi — le serveur n\'a pas répondu.' },
  },
  en: {
    modal:  { ok: 'OK', cancel: 'Cancel', deny: 'No' },
    router: { notFound: 'Page not found', noRoute: 'No route matches this address.', declared: 'Declared routes' },
    toast:  { success: 'Success', error: 'Error', warning: 'Warning', info: 'Info' },
    ujs:    { sendFailed: 'Sending failed — the server did not respond.' },
  },
}
