// Runs async tasks one at a time per key.
//
// Two people running "/country Canada" at the same moment both reach "no Canada
// role yet, create it". Running those checks one after the other for the same
// key ("server:CA") means the second one sees the role the first one created.
// Different keys don't wait for each other. This works within one running bot.

export class KeyedLock {
  #queues = new Map();

  run(key, task) {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const result = previous.then(task);

    // The next task waits for this one whether it succeeds or fails.
    const done = result.catch(() => {});
    this.#queues.set(key, done);
    done.then(() => {
      if (this.#queues.get(key) === done) {
        this.#queues.delete(key);
      }
    });

    return result;
  }

  get size() {
    return this.#queues.size;
  }
}
