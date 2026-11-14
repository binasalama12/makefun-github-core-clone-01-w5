// main.ts — the entry <-> env lifecycle for the crisp-owl forge (wallet w5's entry to
// github-core-clone-01). The forge itself lives in app.ts and its modules; this file only owns
// the trial's rhythm: bind an ephemeral port, register it with the env, poll the env's /done
// until it answers true, then close and exit 0.
//
//   * The env's origin is $MAKEFUN_ENV_URL; without it there is nobody to register with, so the
//     process exits 1 at once.
//   * The server listens on port 0: the kernel picks a free port (never 8080, which is the env's).
//   * POST $MAKEFUN_ENV_URL/register {"port": N} tells the env where to dial. 200 and 409 both
//     end registration (a 409 means an earlier register already won); 400/405 are contract
//     errors and end the program; anything else is retried with a short exponential backoff.
//   * GET $MAKEFUN_ENV_URL/done answers at once with {"done": false} while the suite runs and
//     {"done": true} once it has finished; only then does this process exit.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FLOOR_MS = 250;
const RETRY_CEIL_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt: number): number => Math.min(RETRY_CEIL_MS, RETRY_FLOOR_MS * 2 ** Math.min(attempt, 8));

/** Register the bound port, retrying transient failures; contract errors are fatal. */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll the env's /done until it reports the trial is over; never returns before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answered yet, or a slow poll: the trial is not over either way, so poll again.
    }
    await sleep(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
