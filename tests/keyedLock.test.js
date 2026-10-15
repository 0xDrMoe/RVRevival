import { describe, expect, it } from "vitest";
import { KeyedLock } from "../src/utils/keyedLock.js";

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("KeyedLock", () => {
  it("runs tasks with the same key one at a time in order", async () => {
    const lock = new KeyedLock();
    const events = [];
    const task = (id) => async () => {
      events.push(`start ${id}`);
      await tick(5);
      events.push(`end ${id}`);
      return id;
    };
    const results = await Promise.all([lock.run("k", task("a")), lock.run("k", task("b"))]);
    expect(results).toEqual(["a", "b"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b"]);
    await settle();
    expect(lock.size).toBe(0);
  });

  it("runs tasks with different keys concurrently", async () => {
    const lock = new KeyedLock();
    const events = [];
    await Promise.all([
      lock.run("x", async () => {
        events.push("start x");
        await tick(10);
        events.push("end x");
      }),
      lock.run("y", async () => {
        events.push("start y");
        await tick(1);
        events.push("end y");
      }),
    ]);
    expect(events.indexOf("start y")).toBeLessThan(events.indexOf("end x"));
  });

  it("releases the lock when a task throws", async () => {
    const lock = new KeyedLock();
    await expect(lock.run("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(lock.run("k", async () => "ok")).resolves.toBe("ok");
    await settle();
    expect(lock.size).toBe(0);
  });
});
