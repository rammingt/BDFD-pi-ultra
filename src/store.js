'use strict';
// Variable storage: everything lives in RAM, flushed to a JSON file on a
// debounce. Reads/writes are instant (no network round-trip like hosted BDFD),
// and batching writes is gentle on a Pi's SD card.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, { flushMs = 2000 } = {}) {
    this.file = file;
    this.flushMs = flushMs;
    this.defaults = {};
    this.data = {};
    this.timer = null;
    if (file && fs.existsSync(file)) {
      try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        console.error(`[store] could not read ${file}: ${e.message}`);
      }
    }
  }
  setDefaults(defaults) { this.defaults = { ...defaults }; }
  key(name, scope) { return scope ? `${name}::${scope}` : name; }
  get(name, scope) {
    const k = this.key(name, scope);
    if (k in this.data) return this.data[k];
    return name in this.defaults ? this.defaults[name] : '';
  }
  set(name, value, scope) { this.data[this.key(name, scope)] = String(value); this.schedule(); }
  delete(name, scope) { delete this.data[this.key(name, scope)]; this.schedule(); }
  /** All [scope, value] pairs for a variable, used for leaderboards. */
  entries(name) {
    const prefix = `${name}::`;
    return Object.entries(this.data).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]);
  }
  schedule() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }
  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file); // atomic: no corrupted saves on power loss
  }
}

module.exports = { Store };
