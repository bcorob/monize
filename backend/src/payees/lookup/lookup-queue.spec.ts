import { Logger } from "@nestjs/common";
import { LookupQueue } from "./lookup-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("LookupQueue", () => {
  it("runs up to the concurrency limit and parks the rest until a slot frees", async () => {
    const queue = new LookupQueue(2, 10);
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const started: string[] = [];
    const task = (name: string, d: { promise: Promise<string> }) => () => {
      started.push(name);
      return d.promise;
    };

    const p1 = queue.run("a", task("a", first));
    const p2 = queue.run("b", task("b", second));
    const p3 = queue.run("c", task("c", third));
    await Promise.resolve();

    expect(started).toEqual(["a", "b"]);
    expect(queue.inFlight).toBe(2);
    expect(queue.pending).toBe(1);

    first.resolve("A");
    await p1;
    await Promise.resolve();
    expect(started).toEqual(["a", "b", "c"]);

    second.resolve("B");
    third.resolve("C");
    await expect(Promise.all([p2, p3])).resolves.toEqual(["B", "C"]);
    expect(queue.inFlight).toBe(0);
    expect(queue.pending).toBe(0);
  });

  it("drops a task beyond the pending cap and says so once", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const queue = new LookupQueue(1, 1);
    const gate = deferred<void>();

    const running = queue.run("a", () => gate.promise);
    const parked = queue.run("b", () => Promise.resolve("B"));
    const dropped = await queue.run("c", () => Promise.resolve("C"));

    expect(dropped).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("c");

    gate.resolve();
    await running;
    await expect(parked).resolves.toBe("B");
    warn.mockRestore();
  });

  it("frees the slot when a task rejects", async () => {
    const queue = new LookupQueue(1, 5);

    await expect(
      queue.run("a", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    await expect(queue.run("b", () => Promise.resolve("B"))).resolves.toBe("B");
    expect(queue.inFlight).toBe(0);
  });
});
