// Test-only activities that verify claims made in the lesson text.
import { CompleteAsyncError, Context, heartbeat as hb, activityInfo } from '@temporalio/activity';

export const SAW: Record<string, boolean> = {};
export const TOKENS: Uint8Array[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function slowNoHeartbeat(): Promise<void> {
  SAW.noHb = false;
  const c = Context.current();
  for (let i = 0; i < 40; i++) { await sleep(100); if (c.cancellationSignal.aborted) SAW.noHb = true; }
}
export async function slowWithHeartbeat(): Promise<void> {
  SAW.hb = false;
  const c = Context.current();
  for (let i = 0; i < 40; i++) { await sleep(100); hb(); if (c.cancellationSignal.aborted) { SAW.hb = true; return; } }
}
export async function quick(x: number): Promise<number> { return x * 2; }
export async function waitForCallback(): Promise<string> {
  TOKENS.push(activityInfo().taskToken);
  throw new CompleteAsyncError();
}

