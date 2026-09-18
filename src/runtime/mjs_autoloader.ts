// mjs_autoloader.coffee
µ.Autoloader = {
  pendingComponents: new Set(),
  // tags du manifeste (`mjs-<clé>`) pas encore définis dans
  // customElements. Ensemble VIDE ⇒ l'observer n'a plus rien à charger et
  // court-circuite en O(1), au lieu de sérialiser `outerHTML` pour CHAQUE
  // nœud inséré (poste caché majeur de create1k/runlots : 1000 tr insérés =
  // 1000 sérialisations). `µ.paths` est figé après le boot (émis une seule
  // fois dans le manifeste, jamais muté au runtime) → ce cache est sûr.
  _mjs_pending: null,
  _mjs_pendingSel: '',
  _mjs_refreshPending: function() {
    var k, paths, tag;
    this._mjs_pending = new Set();
    paths = µ.paths;
    if (paths) {
      for (k in paths) {
        tag = 'mjs-' + k.toLowerCase();
        if (!customElements.get(tag)) {
          this._mjs_pending.add(tag);
        }
      }
    }
    this._mjs_pendingSel = this._mjs_pending.size ? Array.from(this._mjs_pending).join(',') : '';
    return this._mjs_pending;
  },
  _mjs_drop: function(tag) {
    // un tag vient d'être défini : le retirer + reconstruire le sélecteur ciblé
    if (this._mjs_pending && this._mjs_pending.delete(tag)) {
      this._mjs_pendingSel = this._mjs_pending.size ? Array.from(this._mjs_pending).join(',') : '';
    }
  },
  // GARDE « BUNDLE PÉRIMÉ » — writeHashed() (bundler) supprime physiquement les anciens
  // fichiers hachés à CHAQUE rebuild. Un onglet ouvert AVANT un rebuild/déploiement garde un
  // µ.paths qui pointe un hash disparu : le prochain import() d'un composant à la demande prend un
  // 404 (le serveur répond du text/html, le navigateur refuse de l'exécuter comme module) et load()
  // atterrit dans son catch, plus bas — X-MJS-Version ne couvre QUE les navigations, jamais un
  // import de module. Un SEUL rechargement par build : la clé sessionStorage stocke la VERSION DE
  // BUILD (pas un simple booléen) — après reload le client sert le NOUVEAU build donc un nouveau
  // µ.version, le drapeau du build précédent ne correspond plus et une future péremption pourra de
  // nouveau recharger ; dans un MÊME build, jamais deux fois, ce qui borne la boucle. Le try/catch
  // sur sessionStorage DÉSARME la garde (navigation privée Safari, harnais sans sessionStorage,
  // window absent) au lieu de la forcer : mieux vaut une page muette qu'une boucle de rechargement.
  // Opt-out : µ.config.staleReload = false.
  _mjs_reloadOnStale: function(fileName, err) {
    var flagVal, stored;
    if (µ.config && µ.config.staleReload === false) {
      return false;
    }
    if (!(typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function')) {
      return false;
    }
    flagVal = µ.version || '1';
    try {
      stored = sessionStorage.getItem('mjs-stale-reload');
      if (stored === flagVal) {
        return false;
      }
      sessionStorage.setItem('mjs-stale-reload', flagVal);
    } catch (e) {
      return false;
    }
    µ.warn(`[Autoloader] bundle périmé : '${fileName}' introuvable — rechargement de la page (une seule fois par build).`);
    window.location.reload();
    return true;
  },
  load: async function(tag) {
    var err, fileName, path, ref;
    tag = tag.toLowerCase();
    if (!customElements.get(tag) && !this.pendingComponents.has(tag)) {
      this.pendingComponents.add(tag);
      fileName = tag.replace('mjs-', '');
      // 1. Interrogation du dictionnaire de hachage (Manifest) — valeurs COMPACTES :
      // le préfixe commun des chemins est publié une seule fois (`µ.pathsPrefix`,
      // cf. writeManifest), chaque valeur ne garde que son suffixe. Préfixe absent
      // (fichier unique, manifeste sans factorisation) : la valeur est déjà entière.
      path = (ref = µ.paths) != null ? ref[fileName] : void 0;
      if (path) {
        path = (µ.pathsPrefix || '') + path;
      }
      // 2. Rejet immédiat si le composant n'est pas répertorié
      if (!path) {
        µ.error(`[Autoloader] ❌ Rejet : Composant '${fileName}' absent du manifeste de distribution.`);
        this.pendingComponents.delete(tag);
        return;
      }
      µ.log(`[Autoloader] 🚀 Downloading ${fileName} -> ${path}`);
      try {
        // 3. Import dynamique via le chemin public haché absolu
        await import(path);
        // `pendingComponents` n'était
        // JAMAIS purgé sur CE chemin (import réussi) — seuls les 2 chemins
        // d'ÉCHEC ci-dessous/au-dessus le faisaient. Un import qui RÉUSSIT
        // mais dont le module ne fait PAS `customElements.define(tag)` (bug
        // de config du composant, mauvais tag) laissait le tag COINCÉ dans ce
        // Set à VIE : `load(tag)` exige `!customElements.get(tag) &&
        // !pendingComponents.has(tag)` — avec `get(tag)` toujours undefined
        // ET `pendingComponents.has(tag)` toujours true, cette condition ne
        // redevient JAMAIS vraie → plus AUCUNE tentative de rechargement,
        // SILENCIEUSEMENT (contrairement aux 2 autres échecs, qui logguent
        // via µ.error). Purger inconditionnellement + avertir si le module a
        // fini d'importer sans jamais enregistrer le tag attendu.
        this.pendingComponents.delete(tag);
        if (!customElements.get(tag)) {
          µ.error(`[Autoloader] ❌ Import de '${fileName}' réussi mais <${tag}> n'a jamais été enregistré (customElements.define manquant dans le module ?).`);
        } else {
          // tag désormais défini : le retirer des tags en attente.
          this._mjs_drop(tag);
        }
        return µ.log(`⚙️ ES6 Module instantiated: ${fileName}`);
      } catch (error) {
        err = error;
        µ.error(`[Autoloader] ❌ Failed to import ${fileName}:`, err);
        this._mjs_reloadOnStale(fileName, err);
        return this.pendingComponents.delete(tag);
      }
    }
  },
  observe: function(root) {
    var observer;
    if (this._mjs_pending === null) {
      this._mjs_refreshPending();
    }
    root.querySelectorAll(':not(:defined)').forEach((node) => {
      if (node.tagName && node.tagName.startsWith('MJS-')) {
        return this.load(node.tagName);
      }
    });
    observer = new MutationObserver((mutations) => {
      // no-op quand plus AUCUN tag du manifeste n'est en attente : on
      // n'inspecte même pas les nœuds insérés (0 outerHTML, 0 querySelector).
      // Cas du banc : `mjs-main` défini au boot ⇒ chaque insertion de rows
      // suivante court-circuite ici sans coût.
      if (this._mjs_pending.size === 0) {
        return;
      }
      return mutations.forEach((m) => {
        return m.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            if (node.tagName.startsWith('MJS-')) {
              this.load(node.tagName);
            }
            if (node.querySelectorAll && node.firstElementChild && this._mjs_pendingSel) {
              // querySelector natif ciblé sur les SEULS tags encore en
              // attente (early-exit natif dans le moteur DOM) au lieu de
              // `outerHTML.indexOf('<mjs-')` qui sérialisait tout le sous-arbre
              // inséré (O(taille HTML) par nœud, × chaque row).
              var pending = node.querySelectorAll(this._mjs_pendingSel);
              if (pending.length) {
                pending.forEach((child) => {
                  if (child.tagName && child.tagName.startsWith('MJS-')) {
                    this.load(child.tagName);
                  }
                });
              }
            }
          }
        });
      });
    });
    return observer.observe(root, {
      childList: true,
      subtree: true
    });
  }
};
