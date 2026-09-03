#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const options = parseArgs(process.argv.slice(2));
const rootPid = Number(options.pid);
const durationMs = Number(options.duration ?? 5_000);
const intervalMs = Number(options.interval ?? 100);
if (!Number.isInteger(rootPid) || rootPid <= 0) {
  throw new Error('Usage: measure-process-tree-rss.mjs --pid <positive pid> [--duration 5000] [--output report.json]');
}
if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(intervalMs) || intervalMs < 50) {
  throw new Error('Duration must be positive and interval must be at least 50 ms');
}

const samples = [];
const startedAt = new Date();
const deadline = Date.now() + durationMs;
while (Date.now() < deadline) {
  const processes = readProcesses();
  const pids = descendantsOf(rootPid, processes);
  const rssKiB = [...pids].reduce(
    (sum, pid) => sum + (processes.get(pid)?.rssKiB ?? 0),
    0,
  );
  samples.push({ elapsedMs: Date.now() - startedAt.getTime(), rssKiB, pids: [...pids].sort((a, b) => a - b) });
  await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
}

const peak = samples.reduce((best, sample) => sample.rssKiB > best.rssKiB ? sample : best, samples[0]);
const report = {
  schemaVersion: 1,
  measuredAt: startedAt.toISOString(),
  rootPid,
  durationMs,
  intervalMs,
  sampleCount: samples.length,
  peakRssKiB: peak?.rssKiB ?? 0,
  peakRssMiB: Math.round(((peak?.rssKiB ?? 0) / 1024) * 10) / 10,
  peakPids: peak?.pids ?? [],
  gateMiB: 4096,
  passed: (peak?.rssKiB ?? Number.POSITIVE_INFINITY) < 4096 * 1024,
};

if (options.output) {
  const output = resolve(options.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function readProcesses() {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  const processes = new Map();
  for (const row of rows.trim().split('\n')) {
    const [pidText, ppidText, rssText] = row.trim().split(/\s+/);
    const pid = Number(pidText);
    if (Number.isInteger(pid)) processes.set(pid, { ppid: Number(ppidText), rssKiB: Number(rssText) });
  }
  return processes;
}

function descendantsOf(root, processes) {
  const result = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, process] of processes) {
      if (!result.has(pid) && result.has(process.ppid)) {
        result.add(pid);
        changed = true;
      }
    }
  }
  return result;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument: ${key ?? ''}`);
    parsed[key.slice(2)] = value;
  }
  return parsed;
}
