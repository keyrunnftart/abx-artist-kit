// the launch tools over stdio, against "nothing here moves" on base (live chain). usage: node test/launch.mjs <path to a script> [outDir]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [, , script, outDir = '.'] = process.argv;
const NHM = '0xB13971551bd3C14A0F793571347dDCdfB08902ba';
const client = new Client({ name: 'launch-test', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/index.mjs'], env: process.env }));
const call = async (name, args) => { const t = Date.now(); const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 }); const txt = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${txt}`); console.log(`${name} ok (${((Date.now() - t) / 1000).toFixed(1)}s)`); return JSON.parse(txt); };
const tools = (await client.listTools()).tools.map((t) => t.name); console.log('tools:', tools.length, tools.join(', '));
const c = await call('deploy_cost', { path: script }); console.log('  cheapest', c.chains[0].chain, c.chains[0].totalEth, 'ETH');
const m = await call('mint_check', { contract: NHM, wallet: '0x000000000000000000000000000000000000dEaD' }); console.log('  verdict', m.verdict, '|', m.problems[0] ?? '');
const w = await call('wave_status', { contract: NHM, breakHours: 24 }); console.log('  sale', JSON.stringify(w.sale));
const k = await call('marketplace_check', { contract: NHM, tokenIds: [2] }); console.log('  traits', Object.keys(k.tokens[0].traits).length);
const p = await call('edition_preview', { path: script, seeds: 12, outDir }); console.log('  sheet', p.sheet, JSON.stringify(p.odds.Mode ?? p.odds));
const e = await call('export_token', { contract: NHM, tokenId: 2, width: 1024, outDir }); console.log('  export', e.method, 'fromChainAlone', e.fromChainAlone);
if (process.env.ALL) { const col = await call('collectors', { contract: NHM, rareTrait: 'Mode', rareValues: ['Void', 'Mono'] }); console.log('  minted', col.minted, 'collectors', col.collectors); }
await client.close();
