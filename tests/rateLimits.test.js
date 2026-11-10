import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createDmSender, DmClosedError } from "../src/utils/dms.js";
import {
  canPost,
  createBatchSender,
  createMessageDeleter,
  createRateLimiter,
  isRenameLimited,
  LatestOnly,
  retryAfterMs,
} from "../src/utils/rateLimits.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("rate limiter", () => {
  it("allows `limit` actions per window, per key", () => {
    let time = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => time });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
    expect(limiter.waitTime("a")).toBe(1000);
    time = 400;
    expect(limiter.waitTime("a")).toBe(600);
    time = 1000;
    expect(limiter.take("a")).toBe(true);
  });

  it("waits for a free slot", async () => {
    let time = 0;
    const waits = [];
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 500,
      now: () => time,
      wait: async (ms) => {
        waits.push(ms);
        time += ms;
      },
    });
    await limiter.acquire("x");
    await limiter.acquire("x");
    expect(waits).toEqual([500]);
    expect(time).toBe(500);
  });
});

describe("latest only", () => {
  it("runs one task per key, keeps only the newest waiting and gives its result to every waiter", async () => {
    const runs = [];
    const gate = deferred();
    const latest = new LatestOnly();
    const first = latest.run("m", async () => {
      runs.push(1);
      await gate.promise;
      return 1;
    });
    const second = latest.run("m", async () => runs.push(2) && 2);
    const third = latest.run("m", async () => runs.push(3) && 3);
    const other = latest.run("n", async () => runs.push("n") && "n");
    await flush();
    expect(runs).toEqual([1, "n"]);
    gate.resolve();
    expect(await first).toBe(1);
    expect(await second).toBe(3);
    expect(await third).toBe(3);
    expect(await other).toBe("n");
    expect(runs).toEqual([1, "n", 3]);
    await flush();
    expect(latest.size).toBe(0);
  });

  it("keeps going after a task fails", async () => {
    const latest = new LatestOnly();
    const failed = latest.run("m", async () => {
      throw new Error("boom");
    });
    const next = latest.run("m", async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});

describe("batch sender", () => {
  it("sends the first message at once and combines the ones that come in meanwhile", async () => {
    const gate = deferred();
    const sent = [];
    const channel = {
      id: "c",
      send: vi.fn(async (payload) => {
        sent.push(payload);
        if (sent.length === 1) {
          await gate.promise;
        }
        return { id: String(sent.length) };
      }),
    };
    const sender = createBatchSender();
    const results = ["a", "b", "c"].map((name) => sender.send(channel, { content: `Welcome ${name}`, allowedMentions: { users: [name] } }));
    await flush();
    expect(channel.send).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all(results);
    expect(sent).toEqual([
      { content: "Welcome a", allowedMentions: { users: ["a"] } },
      { content: "Welcome b\nWelcome c", allowedMentions: { users: ["b", "c"] } },
    ]);
  });

  it("splits at Discord's 2000 characters and passes on failures", async () => {
    const gate = deferred();
    let calls = 0;
    const channel = {
      id: "c",
      send: vi.fn(async ({ content }) => {
        calls += 1;
        if (calls === 1) {
          await gate.promise;
        }
        if (content.startsWith("bad")) {
          throw new Error("Missing Access");
        }
        return {};
      }),
    };
    const sender = createBatchSender();
    const first = sender.send(channel, { content: "x" });
    const long = sender.send(channel, { content: "y".repeat(1500) });
    const longer = sender.send(channel, { content: "z".repeat(1500) });
    gate.resolve();
    await Promise.all([first, long, longer]);
    expect(channel.send).toHaveBeenCalledTimes(3);
    await expect(sender.send(channel, { content: "bad" })).rejects.toThrow("Missing Access");
  });
});

describe("message deleter", () => {
  const fakeMessage = (channel, id) => ({ id, channelId: channel.id, channel, delete: vi.fn(async () => {}) });

  it("deletes the first message at once and the ones that come in meanwhile in one bulk delete", async () => {
    const gate = deferred();
    const channel = { id: "c", bulkDelete: vi.fn(async (ids) => new Map(ids.map((id) => [id, {}]))) };
    const deleter = createMessageDeleter();
    const first = fakeMessage(channel, "1");
    first.delete.mockImplementation(() => gate.promise);
    const others = ["2", "3", "4"].map((id) => fakeMessage(channel, id));
    const done = [first, ...others].map((message) => deleter.delete(message));
    await flush();
    gate.resolve();
    await Promise.all(done);
    expect(first.delete).toHaveBeenCalledTimes(1);
    expect(channel.bulkDelete).toHaveBeenCalledWith(["2", "3", "4"], true);
    others.forEach((message) => expect(message.delete).not.toHaveBeenCalled());
  });

  it("falls back to one at a time when a bulk delete fails, and stops on missing permissions", async () => {
    const gate = deferred();
    const channel = { id: "c", bulkDelete: vi.fn(async () => Promise.reject(Object.assign(new Error("Unknown Message"), { code: 10008 }))) };
    const deleter = createMessageDeleter();
    const first = fakeMessage(channel, "1");
    first.delete.mockImplementation(() => gate.promise);
    const others = ["2", "3"].map((id) => fakeMessage(channel, id));
    const done = [first, ...others].map((message) => deleter.delete(message));
    await flush();
    gate.resolve();
    await Promise.all(done);
    others.forEach((message) => expect(message.delete).toHaveBeenCalledTimes(1));

    const gate2 = deferred();
    const denied = Object.assign(new Error("Missing Permissions"), { code: 50013 });
    channel.bulkDelete.mockRejectedValue(denied);
    const again = fakeMessage(channel, "5");
    again.delete.mockImplementation(() => gate2.promise);
    const blocked = ["6", "7"].map((id) => fakeMessage(channel, id));
    const results = [again, ...blocked].map((message) => deleter.delete(message).catch((error) => error));
    await flush();
    gate2.resolve();
    const [, ...errors] = await Promise.all(results);
    expect(errors).toEqual([denied, denied]);
    blocked.forEach((message) => expect(message.delete).not.toHaveBeenCalled());
  });
});

describe("can post", () => {
  const channel = (allowed, { thread = false } = {}) => ({
    guild: { members: { me: { id: "bot" } } },
    isThread: () => thread,
    permissionsFor: () => ({ has: (bits) => bits.every((bit) => allowed.includes(bit)) }),
  });

  it("checks View Channel and Send Messages (in threads, Send Messages in Threads)", () => {
    const { ViewChannel, SendMessages, SendMessagesInThreads, EmbedLinks } = PermissionFlagsBits;
    expect(canPost(channel([ViewChannel, SendMessages]))).toBe(true);
    expect(canPost(channel([ViewChannel]))).toBe(false);
    expect(canPost(channel([ViewChannel, SendMessages]), { embeds: true })).toBe(false);
    expect(canPost(channel([ViewChannel, SendMessages, EmbedLinks]), { embeds: true })).toBe(true);
    expect(canPost(channel([ViewChannel, SendMessages], { thread: true }))).toBe(false);
    expect(canPost(channel([ViewChannel, SendMessagesInThreads], { thread: true }))).toBe(true);
    // Unknown: let Discord decide.
    expect(canPost({ id: "x" })).toBe(true);
  });
});

describe("Discord's limits", () => {
  it("rejects only the channel name/topic limit instead of waiting it out", () => {
    expect(isRenameLimited({ sublimitTimeout: 300_000 })).toBe(true);
    expect(isRenameLimited({ sublimitTimeout: 0, timeToReset: 2000 })).toBe(false);
  });

  it("reads how long to wait from a rate-limit error", () => {
    expect(retryAfterMs(new Error("nope"))).toBe(0);
    expect(retryAfterMs({ name: "RateLimitError", sublimitTimeout: 0, retryAfter: 5000, timeToReset: 2000 })).toBe(5000);
    expect(retryAfterMs({ status: 429 })).toBe(1000);
  });
});

describe("DMs", () => {
  const closed = () => Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });

  it("doesn't ask again for a while after someone's DMs were closed", async () => {
    let time = 0;
    const dms = createDmSender({ now: () => time, wait: async (ms) => (time += ms) });
    const user = { id: "u1", send: vi.fn(async () => Promise.reject(closed())) };
    await expect(dms.send(user, { content: "hi" })).rejects.toMatchObject({ code: 50007 });
    await expect(dms.send(user, { content: "hi" })).rejects.toBeInstanceOf(DmClosedError);
    expect(user.send).toHaveBeenCalledTimes(1);
    time += 7 * 60 * 60 * 1000;
    user.send.mockResolvedValue({});
    await expect(dms.send(user, { content: "hi" })).resolves.toEqual({});
  });

  it("sends at most five DMs a second", async () => {
    let time = 0;
    const dms = createDmSender({ now: () => time, wait: async (ms) => (time += ms) });
    for (let index = 0; index < 11; index += 1) {
      await dms.send({ id: `u${index}`, send: async () => ({}) }, { content: "hi" });
    }
    expect(time).toBe(2000);
  });
});
