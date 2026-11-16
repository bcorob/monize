#!/usr/bin/env node
"use strict";
const { setTimeout: delay } = require("node:timers/promises");
const { once } = require("node:events");
const {
  createState,
  validateState,
  register,
  poll,
  api,
} = require("./core.cjs");
const { readPrivate, writePrivate, locked } = require("./storage.cjs");

async function main(args) {
  const [command, file, first, second] = args;
  if (!file) throw new Error("USAGE_READ_README");
  await locked(file, async () => {
    if (command === "init") {
      writePrivate(file, createState(first, second), true);
      return;
    }
    let state = validateState(readPrivate(file));
    if (command === "register") {
      state = await register(state, readPrivate(first));
      writePrivate(file, state);
      return;
    }
    if (command === "remove") {
      if (state.deviceId)
        await api(
          state,
          readPrivate(first),
          `subscriptions/${state.deviceId}`,
          "DELETE",
        );
      writePrivate(file, { ...state, deviceId: null });
      return;
    }
    if (command !== "listen" || !state.deviceId)
      throw new Error("REGISTER_FIRST");
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let backoff = 5000;
    while (!abort.signal.aborted) {
      try {
        state = await poll(
          state,
          async (payload) => {
            if (!process.stdout.write(JSON.stringify(payload) + "\n"))
              await once(process.stdout, "drain");
          },
          async (updated) => {
            writePrivate(file, updated);
            state = updated;
          },
        );
        backoff = 5000;
      } catch {
        // Stable machine status, never a URL, token, decrypted body or raw network error.
        process.stderr.write("RECEIVE_RETRY\n");
        backoff = Math.min(backoff * 2, 60000);
      }
      await delay(backoff, undefined, { signal: abort.signal }).catch(() => {});
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  });
}
if (require.main === module)
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("CLIENT_FAILED_READ_README\n");
    process.exitCode = 1;
  });
module.exports = { main };
