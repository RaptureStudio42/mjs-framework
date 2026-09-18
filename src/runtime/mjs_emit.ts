// mjs_emit — `_mjs_emit` (rune `µemit`/`µ.emit`, directive `@emit.NOM=`/`@emit.once.NOM=`, sucre
// `@click.emit.NOM`). Patch de `µ.Element.prototype`, DÉTACHÉ de mjs_element.ts (même technique
// que mjs_on.ts/mjs_failed.ts : ajouté APRÈS la classe, DOIT rester après mjs_element.ts dans la
// concaténation — `hasProp`, module-level dans mjs_element.ts, reste visible ici sans réimport,
// même précédent que mjs_hotcss.ts). Aucune méthode du cœur n'appelle `_mjs_emit` d'elle-même :
// seul du code COMPILÉ (`this._mjs_emit(...)`) ou l'utilisateur (`µemit`) le font — un composant
// qui n'écrit jamais aucune de ces formes ne l'appelle donc jamais, elle peut manquer sans risque.
if (µ.Element) {
  µ.Element.prototype._mjs_emit = function(eventName, data = null, opts = null) {
    // Convention MJS : on expose `data` (et UNIQUEMENT `data`) sur l'event.
    // Pas de `detail` — c'était une convention CustomEvent native qu'on a
    // intentionnellement abandonnée au profit d'un nom plus court et naturel.
    // Côté listener : `e.data` (jamais `e.detail`).
    // Init simplifié + assignation directe data au lieu de defineProperty.
    const init = { bubbles: true, composed: true };
    if (opts) {
      for (const k in opts) {
        if (!hasProp.call(opts, k)) continue;
        if (k === 'detail') continue;  // garde-fou : reject `detail` dans opts
        init[k] = opts[k];
      }
    }
    const ev = new CustomEvent(eventName, init);
    ev.data = data;
    this.dispatchEvent(ev);
    return ev;
  };
}
