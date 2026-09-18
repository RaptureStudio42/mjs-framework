// mjs_debug.coffee
var originalConnected, originalDisconnected, originalRunEffects;

µ.debugMode = false;

µ.instances = new Set();

if (µ.debug) console.log("🧪 [ModularJS] Introspection module armed. Type 'µ.debugMode = true' for visual telemetry.");

if (µ.Element) {
  // 1. Global Registry (Tracks births and deaths)
  originalConnected = µ.Element.prototype.connectedCallback;
  µ.Element.prototype.connectedCallback = function() {
    µ.instances.add(this);
    if (originalConnected) {
      return originalConnected.apply(this, arguments);
    }
  };
  originalDisconnected = µ.Element.prototype.disconnectedCallback;
  µ.Element.prototype.disconnectedCallback = function() {
    µ.instances.delete(this);
    if (originalDisconnected) {
      return originalDisconnected.apply(this, arguments);
    }
  };
  // 2. Visual Telemetry (Render highlighting)
  // V2 : la méthode vivante est `_mjs_runEffectsV2` (`_runEffects` legacy retirée)
  // — sans cette migration, originalRunEffects était undefined et le wrapper
  // aurait posé un _runEffects mort.
  originalRunEffects = µ.Element.prototype._mjs_runEffectsV2;
  µ.Element.prototype._mjs_runEffectsV2 = function(d, full) {
    var prevOutline, prevTransition;
    if (µ.debugMode && !this._mjs_has_crashed) {
      prevOutline = this.style.outline;
      prevTransition = this.style.transition;
      this.style.transition = 'none';
      this.style.outline = '2px solid rgba(0, 255, 0, 0.9)';
      setTimeout(() => {
        this.style.transition = 'outline 0.3s ease-out';
        this.style.outline = prevOutline;
        return setTimeout((() => {
          return this.style.transition = prevTransition;
        }), 300);
      }, 50);
    }
    return originalRunEffects.call(this, d, full);
  };
}

// 3. Custom Chrome Formatters — push (pas d'écrasement : d'autres libs
// — immutable.js, etc. — posent aussi leurs formatters).
(window.devtoolsFormatters || (window.devtoolsFormatters = [])).push(
  {
    header: function(obj) {
      var ref;
      if (obj instanceof HTMLElement && ((ref = obj.tagName) != null ? ref.startsWith('MJS-') : void 0)) {
        return [
          "div",
          {
            style: "color: #e36209; font-weight: bold; background: #fff0f0; padding: 2px 5px; border-radius: 3px;"
          },
          `<${obj.tagName.toLowerCase()}>`
        ];
      }
      return null;
    },
    hasBody: function() {
      return true;
    },
    body: function(obj) {
      return [
        "div",
        {
          style: "padding: 5px 0 5px 20px; background: #f8f9fa; border-left: 3px solid #e36209;"
        },
        [
          "div",
          {},
          [
            "span",
            {
              style: "color: #6f42c1; font-weight: bold;"
            },
            "🧠 Reactive State (@_state): "
          ],
          [
            "object",
            {
              object: obj._state
            }
          ]
        ],
        [
          "div",
          {},
          [
            "span",
            {
              style: "color: #005cc5; font-weight: bold;"
            },
            "🏷️ DOM Nodes (@_mjs_nodes): "
          ],
          [
            "object",
            {
              object: obj._mjs_nodes
            }
          ]
        ],
        [
          "div",
          {},
          [
            "span",
            {
              style: "color: #22863a; font-weight: bold;"
            },
            "🧩 Props & Masks (@_mjs_var_bits): "
          ],
          [
            "object",
            {
              object: obj._mjs_var_bits
            }
          ]
        ]
      ];
    }
  }
);
