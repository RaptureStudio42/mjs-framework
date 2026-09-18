// mjs_interpolate.coffee
var MjsInterpolator;

MjsInterpolator = (function() {
  class MjsInterpolator {
    constructor(current, duration = 400, min1 = null, max1 = null) {
      this.current = current;
      this.duration = duration;
      this.min = min1;
      this.max = max1;
      this.target = this.current;
      // même fix que µspring (mjs_spring.ts) :
      // `_invalidator` slot unique → un interpolateur PARTAGÉ entre 2
      // composants perdait le premier abonné (écrasé par le second), et un
      // composant détruit restait accroché (retenu en mémoire). `Map<owner,
      // fn>` + purge paresseuse des owners `_mjs_dead` à la notification.
      this._mjs_invalidators = new Map();
      this._mjs_startTime = null;
      this._mjs_startValue = null;
      // Tag d'identification dans µ._mjs_interpolatorSet (cf. mjs_init.ts) — sans
      // string sur l'objet (mangle-safe).
      µ._mjs_interpolatorSet.add(this);
    }

    _mjs_attachInvalidator(owner, fn) {
      // l'owner (élément + closures)
      // est une clé FORTE de la Map : un interpolateur module-level PARTAGÉ retient
      // sinon chaque composant abonné jusqu'à la prochaine notification (fuite si le
      // tween est idle). À la 1ʳᵉ inscription d'un owner exposant `_mjs_onDestroy`
      // (l'API interne de nettoyage, cf. mjs_smooth `opts.owner`), on branche un
      // auto-détachement à SA destruction — purge IMMÉDIATE, pas seulement paresseuse.
      // Le filet `_mjs_dead` de `_mjs_notifyInvalidators` couvre les owners sans
      // `_mjs_onDestroy` (tests, objets nus).
      if (!this._mjs_invalidators.has(owner) && owner && typeof owner._mjs_onDestroy === 'function') {
        owner._mjs_onDestroy(() => this._mjs_invalidators.delete(owner));
      }
      this._mjs_invalidators.set(owner, fn);
      return fn;
    }

    _mjs_notifyInvalidators() {
      for (const [owner, fn] of this._mjs_invalidators) {
        if (owner != null && owner._mjs_dead) {
          this._mjs_invalidators.delete(owner);
          continue;
        }
        // DURCISSEMENT — un invalidator qui
        // jette ne doit PAS priver les owners SUIVANTS de leur frame ni faire
        // éjecter la tâche du Ticker pour tout le monde (le catch du Ticker éjecte
        // la tâche ENTIÈRE). On détache seulement l'abonné fautif.
        try {
          fn();
        } catch (e) {
          (µ.error || µ.warn)('[ModularJS] µ.interpolate : invalidator en erreur, détaché.', e);
          this._mjs_invalidators.delete(owner);
        }
      }
    }

    _mjs_step(now) {
      var elapsed, progress, next;
      // RÉGRESSION corrigée —rien à animer (start déjà = target,
      // cf. le reciblage sur current dans le setter `value` ci-dessous) : on
      // se retire aussitôt, SANS recalculer `next` depuis un `_mjs_startTime` qui
      // ne fait plus foi. Filet générique : couvre aussi un settle normal où
      // une frame résiduelle du Ticker rappellerait `_mjs_step` par accident.
      if (this._mjs_startValue === this.target) {
        return false;
      }
      elapsed = now - this._mjs_startTime;
      // `elapsed` peut être négatif (timestamp
      // rAF antérieur au `performance.now()` du set, début de frame) → la
      // valeur reculait d'une frame ; `duration=0` donnait `0/0=NaN`. Clampé
      // aux deux bornes.
      progress = Math.min(Math.max(elapsed, 0) / Math.max(this.duration, 1e-6), 1);
      next = this._mjs_startValue + (this.target - this._mjs_startValue) * progress;
      // filet de sécurité : si `next` devient
      // non-fini malgré la garde du setter (ceinture+bretelles, même schéma
      // que µspring/_mjsDeepFinite), on fige sur la cible plutôt que de
      // propager NaN à chaque frame suivante indéfiniment (`_mjs_startValue =
      // this.current` au prochain `set` aurait capturé le NaN à vie).
      this.current = Number.isFinite(next) ? next : this.target;
      this._mjs_notifyInvalidators();
      return progress < 1;
    }

  };

  Object.defineProperty(MjsInterpolator.prototype, 'value', {
    get: function() {
      return this.target;
    },
    set: function(newTarget) {
      // AUCUNE garde NaN/Infinity n'existait :
      // `$x = input.valueAsNumber` sur un champ number VIDÉ (NaN, cas banal)
      // assignait `target=NaN` (target===newTarget est FALSE pour NaN, donc
      // le court-circuit ne protégeait pas) → `_mjs_step` calculait `current=NaN`
      // DÈS LE PREMIER tick, et `_mjs_startValue = this.current` au `set` suivant
      // capturait ce NaN → l'interpolateur restait CORROMPU À VIE, même avec
      // des cibles valides ensuite. Même garde que `µspring`
      // (`_mjsDeepFinite`), qui a déjà cette double protection.
      if (typeof newTarget !== 'number' || !Number.isFinite(newTarget)) {
        if (typeof µ !== 'undefined' && µ.warn) {
          µ.warn('[ModularJS] µ.interpolate : valeur non-finie ignorée (' + newTarget + ')');
        }
        return;
      }
      if (this.min !== null) {
        newTarget = Math.max(this.min, newTarget);
      }
      if (this.max !== null) {
        newTarget = Math.min(this.max, newTarget);
      }
      if (this.target === newTarget) {
        return;
      }
      // le court-circuit ci-dessus ne comparait QUE
      // newTarget à l'ANCIENNE cible : recibrer en plein vol EXACTEMENT sur
      // la valeur COURANTE (différente de l'ancienne cible) passait outre et
      // consommait toute la `duration` (60 notifications) pour un `current`
      // qui ne bougeait jamais. Même traitement que target===newTarget : rien
      // à animer, 0 frame (pas de Ticker.add).
      // RÉGRESSION corrigée —une tâche Ticker de l'ANIMATION
      // PRÉCÉDENTE encore vivante (retarget en plein vol) continuait sinon
      // d'appeler `_mjs_step` sur `_mjs_startValue`/`_mjs_startTime` PÉRIMÉS (jamais
      // réalignés ici) → une frame résiduelle recalculait `next` depuis
      // l'ancienne trajectoire et faisait DÉRIVER `.current` alors qu'on
      // vient juste de le figer. Réaligner start sur l'instant présent (delta
      // devient nul) ; `_mjs_step` se retire de lui-même au prochain appel (cf.
      // le court-circuit `_mjs_startValue===target` juste au-dessus dans ce fichier).
      if (newTarget === this.current) {
        this.target = newTarget;
        this._mjs_startValue = newTarget;
        this._mjs_startTime = performance.now();
        return;
      }
      this.target = newTarget;
      this._mjs_startValue = this.current;
      this._mjs_startTime = performance.now();
      return µ.Ticker.add(this);
    }
  });

  return MjsInterpolator;

}).call(this);

µ.interpolate = function(val, dur, min, max) {
  return new MjsInterpolator(val, dur, min, max);
};
