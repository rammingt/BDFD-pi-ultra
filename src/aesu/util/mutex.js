'use strict';

/**
 * Serialises async work per key. Buttons can be double-clicked and the presence
 * watcher can fire while someone is pressing one, so every state change for a
 * member goes through the same chain.
 */
class KeyedMutex {
  chains = new Map();

  run(key, task) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const guard = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, guard);
    void guard.then(() => {
      if (this.chains.get(key) === guard) this.chains.delete(key);
    });
    return result;
  }
}

module.exports = { KeyedMutex };
