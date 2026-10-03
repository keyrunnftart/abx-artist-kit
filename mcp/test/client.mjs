// connects to the server over stdio like Claude Code would, lists tools, calls two of them
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [, , script, projectDir] = process.argv;
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/index.mjs'] }));
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
const l = await client.callTool({ name: 'lessons', arguments: { topic: 'render', projectDir } });
const lj = JSON.parse(l.content[0].text); console.log('lessons cli:', lj.yourCli, 'stale:', lj.staleWarning, 'n:', lj.lessons.length);
const lint = JSON.parse((await client.callTool({ name: 'lint_script', arguments: { path: script } })).content[0].text);
console.log('lint ok:', lint.ok, lint.findings.map((f) => f.level + ': ' + f.msg).join('\n  '));
const t0 = Date.now();
const r = await client.callTool({ name: 'render_check', arguments: { path: script, seeds: 6 } });
const rj = JSON.parse(r.content[0].text);
console.log('render', (Date.now() - t0) / 1000 + 's', JSON.stringify({ ok: rj.ok, timeMs: rj.timeMs, deterministic: rj.deterministic, canvas: rj.canvas, probe: rj.nondeterminismProbe, findings: rj.findings }, null, 1));
console.log('modes:', JSON.stringify(rj.traitDistribution?.Mode));
await client.close();
