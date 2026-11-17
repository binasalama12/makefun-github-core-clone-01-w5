// Crisp Forge entrypoint: start the forge, register its port with the
// trial environment, then long-poll the environment until it reports the
// trial is done, and exit 0.
//
// The forge is the server; this file is only its lifecycle:
//   1. listen on an ephemeral port (never 8080 — the environment owns it);
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register;
//   3. GET $MAKEFUN_ENV_URL/done until it answers {"done": true};
//   4. close and exit 0.

import type { AddressInfo } from "node:net";
import { createForgeServer } from "./app.ts";

const envUrl = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
const token = process.env.MAKEFUN_SHOP_TOKEN ?? "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  // The environment may still be coming up when we are; retry until the
  // registration lands. The first registration wins on its side.
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
      });
      if (response.ok || response.status === 409) return;
    } catch {
      // not up yet — fall through and retry
    }
    await sleep(200);
  }
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body && body.done === true) return;
      }
    } catch {
      // a failed poll says nothing; keep polling
    }
    await sleep(200);
  }
}

async function main(): Promise<void> {
  const server = createForgeServer(token);
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address() as AddressInfo;
  await register(address.port);
  await waitForDone();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Do not let a lingering keep-alive socket hold the exit open.
    setTimeout(() => resolve(), 1000).unref();
  });
  process.exit(0);
}

main().catch(() => {
  // A trial whose program exits early scores 0, so on an unexpected error
  // the best move is to keep the process alive for the environment rather
  // than crash out; the poll loop above is the only exit path.
  setInterval(() => undefined, 60_000);
});
