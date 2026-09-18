// mjs_layout_variant — queue des VARIANTS de mise en page nommés (`layout="x"`/`template="x"`,
// `<style name="x">`), tail de `_mjs_applyLayout` (mjs_element.ts, cœur — inchangée jusqu'à
// `if (name === 'default') { return; }`, qui reste le SEUL chemin pour TOUT composant : adoption
// des feuilles shield/reset/thème/héritées/partagées/base, toujours nécessaire). DÉTACHÉ du
// cœur, patch de `µ.Element.prototype`, DÉTECTÉ PAR LA DÉCLARATION : `<style name="…">` dans une
// source (seule origine de `_mjs_layouts` et du fichier `<module>.<nom>.css`) ou un tel fichier
// déposé à la main dans le dossier de sortie, plus les mots `layout=`/`template=` (faux positifs
// acceptés, cf. bundler/index.ts). La DEMANDE seule ne suffit pas : `layout="…"` peut être écrit
// dans une page que le build ne lit pas (vue du serveur, HTML statique, fragment UJS).
//
// Contrat avec l'appelant (mjs_element.ts) : `_mjs_applyLayoutVariant(name, sheets, _seq)` reçoit
// le tableau `sheets` DÉJÀ peuplé (feuilles adoptées avant ce point) et le poursuit — comportement
// BYTE-IDENTIQUE à l'ancien corps unique de `_mjs_applyLayout`. Si ce fichier manque (aucun variant
// déclaré ni déposé, cf. ci-dessus) et qu'un nom non-défaut est malgré tout demandé, l'appelant garde
// silencieusement les feuilles déjà adoptées (même repli que les autres gardes défensives du
// fichier, ex. `_mjs_isPageCached`) plutôt que de planter.
if (µ.Element) {
  µ.Element.prototype._mjs_applyLayoutVariant = async function(name, sheets, _seq) {
    var sheet, url, variantCss;
    // Variant demandé : `_mjs_layouts` liste les noms
    // connus du module (émis par le compilateur SEULEMENT s'il déclare au
    // moins un `<style name="…">`) → empreinte de son CSS. Nom absent de
    // cette liste = refusé SANS requête réseau et SANS entrée de cache (le
    // cache est global par URL — une entrée posée ici empoisonnerait un
    // composant corrigé plus tard). `_mjs_layouts` absent (composant sans
    // aucun variant déclaré) : repli historique conservé à l'identique.
    if (this._mjs_layouts && !hasProp.call(this._mjs_layouts, name)) {
      // un nom de variant inconnu n'est pas un
      // avertissement, c'est une ERREUR. Écrit en dur, il ne compile même pas (garde du
      // build) ; calculé (`layout={expr}`), il n'est vérifiable qu'ici : le
      // composant part alors dans le système d'erreur du framework — `_mjs_catchError` remonte
      // à la boundary `<@failed>` la plus proche, ou affiche le panneau fatal. Mieux vaut
      // une carte qui crie qu'une carte muette avec la mauvaise mise en page.
      const layoutErr = new Error(`[ModularJS] <${this.tagName.toLowerCase()}> : variant de style '${name}' inconnu (connus : ${Object.keys(this._mjs_layouts).join(', ') || 'aucune'}).`);
      // mode `mjs-light` : pas de shadow, donc ni panneau fatal ni boundary à remplir — il
      // ne reste que le journal, à voix haute
      if (this._mjs_isLight || typeof this._mjs_catchError !== 'function') {
        µ.error(layoutErr.message);
        return;
      }
      // _mjs_applyLayout rejoue à chaque connexion (elle réadopte toutes les feuilles) et un
      // même montage l'appelle 2× (connectedCallback puis syncProps) : le composant a déjà
      // crashé au premier passage, on ne le refait pas crasher par-dessus son propre
      // panneau d'erreur
      if (!this._mjs_has_crashed) {
        this._mjs_catchError(layoutErr);
      }
      return;
    }
    // Empreinte connue → `?v=` casse le cache navigateur (le nom de fichier
    // reste stable). Sans empreinte (repli historique) : URL nue, comme avant.
    const fingerprint = this._mjs_layouts && this._mjs_layouts[name];
    url = `${this._mjs_dir}${this._mjs_modName}.${name}.css` + (fingerprint ? `?v=${fingerprint}` : '');
    if (µ._mjs_styleVariantCache == null) {
      µ._mjs_styleVariantCache = {};
    }
    if (!µ._mjs_styleVariantCache[url]) {
      // promesse gardée en cache PENDANT LE VOL (dédoublonne 2 composants qui montent
      // ensemble) — .catch : un fetch qui rejette (réseau coupé) ne doit jamais laisser
      // de promesse rejetée en cache ni faire remonter d'exception hors de _mjs_applyLayout
      µ._mjs_styleVariantCache[url] = fetch(url).then(function(r) {
        if (r.ok) {
          return r.text();
        } else {
          return "";
        }
      }).catch(function() {
        return '';
      });
    }
    variantCss = (await µ._mjs_styleVariantCache[url]);
    if (_seq !== this._mjs_layoutSeq) { return; }
    if (!variantCss) {
      // résultat vide (404, réseau, fichier vide) : on retire l'entrée — le montage
      // suivant doit pouvoir retenter (fichier peut-être redevenu disponible) — et on
      // avertit 1 fois par URL (même double-appel que ci-dessus)
      delete µ._mjs_styleVariantCache[url];
      if (µ._mjs_layoutMissingWarned == null) {
        µ._mjs_layoutMissingWarned = new Set();
      }
      if (!µ._mjs_layoutMissingWarned.has(url)) {
        µ._mjs_layoutMissingWarned.add(url);
        const knownNames = this._mjs_layouts ? (Object.keys(this._mjs_layouts).join(', ') || 'aucune') : 'aucune';
        µ.warn(`[ModularJS] <${this.tagName.toLowerCase()}> : fichier du variant '${name}' introuvable (${url}) — noms connus : ${knownNames}.`);
      }
      return;
    }
    if (this._mjs_isLight) {
      // Même schéma que le baseCss light ci-dessus (pas d'adoptedStyleSheets
      // en mode light) : <style> dédié, dédupliqué par texte.
      if (µ._mjs_lightLayoutInjected == null) {
        µ._mjs_lightLayoutInjected = new Set();
      }
      // `:host` réécrit dans le variant aussi, AVANT la déduplication (même raison que le
      // baseCss ci-dessus) — `variantCss` NU reste inchangé pour le chemin ombre plus bas
      var variantRewritten = µ._lightHostCss(variantCss, this.tagName.toLowerCase());
      if (!µ._mjs_lightLayoutInjected.has(variantRewritten)) {
        if (µ._csp) {
          var lightLayoutSheet = new CSSStyleSheet();
          lightLayoutSheet.replaceSync(variantRewritten);
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, lightLayoutSheet];
        } else {
          var lightLayoutEl = document.createElement('style');
          lightLayoutEl.setAttribute('data-mjs-light-layout', this.tagName.toLowerCase());
          lightLayoutEl.textContent = variantRewritten;
          document.head.appendChild(lightLayoutEl);
        }
        µ._mjs_lightLayoutInjected.add(variantRewritten);
      }
      return;
    }
    if (µ._mjs_styleVariantSheetCache == null) {
      µ._mjs_styleVariantSheetCache = new Map();
    }
    if (!µ._mjs_styleVariantSheetCache.has(variantCss)) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(variantCss);
      µ._mjs_styleVariantSheetCache.set(variantCss, sheet);
    }
    sheets.push(µ._mjs_styleVariantSheetCache.get(variantCss));
    return this._shadow.adoptedStyleSheets = sheets;
  };
}
