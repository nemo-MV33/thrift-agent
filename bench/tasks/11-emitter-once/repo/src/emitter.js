export class Emitter {
  #handlers = new Map();

  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, []);
    this.#handlers.get(event).push(fn);
    return this;
  }

  off(event, fn) {
    const list = this.#handlers.get(event);
    if (!list) return this;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
    return this;
  }

  emit(event, ...args) {
    const list = this.#handlers.get(event);
    if (!list || list.length === 0) return false;
    for (const fn of list) fn(...args);
    return true;
  }

  listenerCount(event) {
    return this.#handlers.get(event)?.length ?? 0;
  }
}
