// mjs_ticker — boucle rAF partagée (µ.Ticker), moteur des tweens temps-réel.
//
// Un SEUL requestAnimationFrame pour toutes les tâches inscrites (`add`) : µspring,
// µsmooth et µinterpolate y poussent chacun leur tâche (`_mjs_step(now)`, cf. mjs_spring.ts/
// mjs_smooth.ts/mjs_interpolate.ts) au lieu d'ouvrir leur propre rAF — le coût de la
// boucle ne dépend jamais du nombre de tweens actifs. DÉTACHÉ du cœur strict : présent
// SEULEMENT si l'un des trois consommateurs l'est (cf. bundler/index.ts, resolveRuntimeFiles,
// `wantsTicker`) — les trois y appellent `µ.Ticker.add(...)` sans aucune garde, il doit donc
// être bundlé chaque fois qu'AU MOINS un des trois l'est.
µ.Ticker = {
  _mjs_tasks: new Set(),
  _mjs_raf: null,
  _mjs_boundLoop: (now) => {
    return µ.Ticker._loop(now);
  },
  _loop: function(now) {
    var keepAlive, ref, task;
    ref = this._mjs_tasks;
    for (task of ref) {
      try {
        keepAlive = task._mjs_step(now);
      } catch (e) {
        // Sans ce catch, un throw dans un _mjs_step (invalidator → effet user)
        // interrompait _loop AVANT la reprogrammation du rAF en laissant
        // `_mjs_raf` non-null périmé → plus AUCUN tween/spring ne tournait
        // jusqu'au reload. La tâche fautive est éjectée, les autres vivent.
        µ.error('[ModularJS] Ticker : tâche en erreur, éjectée.', e);
        keepAlive = false;
      }
      if (!keepAlive) {
        this._mjs_tasks.delete(task);
      }
    }
    if (this._mjs_tasks.size > 0) {
      return this._mjs_raf = requestAnimationFrame(this._mjs_boundLoop);
    } else {
      return this._mjs_raf = null;
    }
  },
  add: function(task) {
    this._mjs_tasks.add(task);
    return this._mjs_raf != null ? this._mjs_raf : this._mjs_raf = requestAnimationFrame(this._mjs_boundLoop);
  }
};
