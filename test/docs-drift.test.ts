/** Every tool, roku_run call and rokuctl command the skills and docs name must exist. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../src/commands.js';
import { CALL_NAMES } from '../src/sandbox/run.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = /\b(roku_[a-z_]+|analyze_bsprof|compare_bsprof|bsprof_info|analyze_perfetto|compare_perfetto|query_perfetto)\b/g;
/** Words that look like tool names but are not: a BrightScript module, wildcards, the package. */
const NOT_TOOLS = (n: string) => n === 'roku_ads_lib' || n.endsWith('_') || n === 'roku_mcp';

test('skills, AGENTS.md, README and rules name only real tools, calls and commands', () => {
  const tools = new Set<string>(JSON.parse(fs.readFileSync(path.join(repo, 'test', 'parity', 'tools-list.json'), 'utf8')).map((t: { name: string }) => t.name));
  tools.add('roku_run');
  tools.add('roku_sdk_docs');
  const calls = new Set(CALL_NAMES);
  const commands = new Set(['help', ...COMMANDS.filter((c) => !c.session).map((c) => c.name)]);
  const files = [
    ...fs.readdirSync(path.join(repo, 'plugin', 'skills')).map((d) => path.join('plugin', 'skills', d, 'SKILL.md')),
    'AGENTS.md',
    'README.md',
    ...(fs.readdirSync(path.join(repo, 'rules'), { recursive: true }) as string[]).filter((f) => /\.(md|mdc)$/.test(f)).map((f) => path.join('rules', f)),
  ];
  const problems: string[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(repo, f), 'utf8');
    for (const [, n] of text.matchAll(TOOL)) if (!tools.has(n) && !NOT_TOOLS(n)) problems.push(`${f}: tool ${n}`);
    for (const [, n] of text.matchAll(/\broku\.([a-z]+\.[a-zA-Z]+)\(/g)) if (!calls.has(n)) problems.push(`${f}: call roku.${n}`);
    for (const [, n] of text.matchAll(/\brokuctl ([a-z]+\.[a-z-]+|help)\b/g)) if (!commands.has(n)) problems.push(`${f}: command ${n}`);
  }
  assert.deepEqual([...new Set(problems)], []);
});

test('every skill has a task description, numbered steps and a recovery table', () => {
  for (const d of fs.readdirSync(path.join(repo, 'plugin', 'skills'))) {
    const text = fs.readFileSync(path.join(repo, 'plugin', 'skills', d, 'SKILL.md'), 'utf8');
    assert.match(text, /^---\nname: [a-z0-9-]+\ndescription: .+Use when .+\n---/s, `${d}: front matter with "Use when"`);
    assert.match(text, /^## Steps$/m, `${d}: ## Steps`);
    assert.match(text, /^1\. /m, `${d}: numbered steps`);
    assert.match(text, /^## When it goes wrong\n\n\| Symptom \| Cause \| Fix \|/m, `${d}: recovery table`);
  }
});
