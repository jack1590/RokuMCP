import { resolveTarget, type TargetParams } from '../roku-config.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One remote key (ECP on LAN, the Instance API on RCE). */
export async function keypress(options: TargetParams & { key: string }): Promise<void> {
  await (await resolveTarget(options)).keypress(options.key);
}

/** Keys in order, delayMs (default 100) apart. */
export async function keySequence(options: TargetParams & { keys: string[]; delayMs?: number }): Promise<void> {
  const target = await resolveTarget(options);
  const delay = options.delayMs ?? 100;
  for (const key of options.keys) {
    await target.keypress(key);
    if (delay > 0) await wait(delay);
  }
}

/** Types text as Lit_ key presses, delayMs (default 50) apart; resolves with the character count. */
export async function typeText(options: TargetParams & { text: string; delayMs?: number }): Promise<number> {
  const target = await resolveTarget(options);
  const delay = options.delayMs ?? 50;
  for (const char of options.text) {
    await target.keypress('Lit_' + char);
    if (delay > 0) await wait(delay);
  }
  return [...options.text].length;
}
