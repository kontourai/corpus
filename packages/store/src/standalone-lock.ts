import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { FileMutationLock } from './services.js';

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function participants(path: string): string[] {
  return readdirSync(path).filter((name) => {
    const match = /^(\d+)-([a-f0-9-]+)$/.exec(name);
    if (!match) throw new Error('Foreign standalone lock participant');
    if (alive(Number(match[1]))) return true;
    // Participant names are unique and never reused; deleting a dead one cannot remove a new owner.
    rmSync(join(path, name), { recursive: true, force: true });
    return false;
  });
}
function ticket(path: string, name: string): number | null {
  try {
    const raw = readFileSync(join(path, name, 'ticket'), 'utf8');
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Corrupt standalone lock ticket');
    return number;
  } catch (error) { if (missing(error)) return null; throw error; }
}

/** Standalone only: filesystem bakery protocol, NOT interoperable with Station's lock. */
export const standaloneFileMutationLock: FileMutationLock = async (path) => {
  const name = `${process.pid}-${randomUUID()}`;
  const own = join(path, name);
  const deadline = Date.now() + 30_000;
  // Registration precedes ticket selection. An incomplete live participant is choosing, so wait.
  while (true) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Foreign standalone lock; inject the host lock');
    try { mkdirSync(own, { mode: 0o700 }); break; }
    catch (error) { if (!missing(error)) throw error; }
  }
  function cleanup(): void {
    rmSync(own, { recursive: true, force: true });
    try { rmdirSync(path); } catch (error) {
      if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  try {
    const chosen = 1 + Math.max(0, ...participants(path).map((other) => ticket(path, other) ?? 0));
    writeFileSync(join(own, 'choosing'), String(chosen), { flag: 'wx', mode: 0o600 });
    renameSync(join(own, 'choosing'), join(own, 'ticket'));
    for (const other of participants(path)) {
      if (other === name) continue;
      while (participants(path).includes(other)) {
        const theirs = ticket(path, other);
        if (theirs !== null && (theirs > chosen || (theirs === chosen && other > name))) break;
        if (Date.now() >= deadline) throw new Error('Standalone lock timeout');
        await delay(5);
      }
    }
    return cleanup;
  } catch (error) { cleanup(); throw error; }
};
