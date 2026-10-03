// weekly check: does the latest ABX release still match what this kit assumes?
// installs @artblocks/abx-sdk + abx-cli @latest into a temp folder, compares them with
// src/lessons.json "watch", and re-runs a live rebuild of a known token.
// writes report.md; prints CHANGED=true|false (and sets the GitHub output) for the workflow.

import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SEL } from '../src/chain.mjs';
import { rebuildToken } from '../src/tools.mjs';

const LESSONS = JSON.parse(readFileSync(new URL('../src/lessons.json', import.meta.url), 'utf8'));
const W = LESSONS.watch;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

const dir = mkdtempSync(join(tmpdir(), 'abx-watch-'));
execSync('npm init -y', { cwd: dir, stdio: 'ignore' });
execSync('npm i --no-audit --no-fund @artblocks/abx-sdk@latest @artblocks/abx-cli@latest', { cwd: dir, stdio: 'ignore' });
const pkg = (n) => JSON.parse(readFileSync(join(dir, 'node_modules', '@artblocks', n, 'package.json'), 'utf8'));
const cli = pkg('abx-cli').version, sdkVer = pkg('abx-sdk').version;
const sdk = await import(pathToFileURL(join(dir, 'node_modules', '@artblocks', 'abx-sdk', 'dist', 'index.js')).href);
const { seriesCodeAbi } = await import(pathToFileURL(join(dir, 'node_modules', '@artblocks', 'abx-sdk', 'dist', 'abi', 'index.js')).href);
const { toFunctionSelector } = await import(pathToFileURL(join(dir, 'node_modules', 'viem', '_esm', 'index.js')).href);

const changes = [], ok = [];
const check = (cond, good, bad) => (cond ? ok.push(good) : changes.push(bad));

// 1. new release since the lessons were last checked
check(cmp(cli, LESSONS.testedCli) <= 0, `abx-cli ${cli} = last checked`, `**new abx-cli ${cli}** (lessons last checked on ${LESSONS.testedCli}). recheck each lesson, then bump testedCli.`);
if (cmp(cli, LESSONS.testedCli) > 0) {
  const log = readFileSync(join(dir, 'node_modules', '@artblocks', 'abx-cli', 'CHANGELOG.md'), 'utf8');
  const start = log.indexOf(`## ${cli}`), end = log.indexOf(`## ${LESSONS.testedCli}`);
  if (start >= 0) changes.push('changelog since last check:\n\n```\n' + log.slice(start, end > start ? end : start + 4000).trim() + '\n```');
}

// 2. contract functions the kit calls still exist
const have = new Set(seriesCodeAbi.filter((f) => f.type === 'function').map((f) => toFunctionSelector(f)));
const contractSel = Object.entries(SEL).filter(([k]) => !['getDependencyDetails', 'getDependencyScript', 'minterSales', 'royaltyInfo'].includes(k));
const missing = contractSel.filter(([, s]) => !have.has(s)).map(([k]) => k);
check(!missing.length, `all ${contractSel.length} contract functions still in the ABI`, `**contract functions missing from the latest ABI:** ${missing.join(', ')} .. inspect_contract / rebuild_token need updating`);

// 3. the page ABX builds around a script is unchanged (rebuild_token copies it)
const shape = sha(sdk.buildGeneratorDocument('X', '{}', []).replace(sdk.ABX_JS, '<ABX_JS>'));
check(shape === W.generatorShapeSha && sha(sdk.ABX_JS) === W.abxJsSha, 'generator page + abx runtime unchanged', '**ABX changed how it wraps scripts** (buildGeneratorDocument / ABX_JS) .. update src/html.mjs so rebuilds stay identical');
check(sdk.DEFAULT_SCRIPT_CHUNK_SIZE === W.chunkSize, `chunk size still ${W.chunkSize}`, `**chunk size changed** to ${sdk.DEFAULT_SCRIPT_CHUNK_SIZE} .. update lint_script`);

// 4. lessons that can be checked from the package
const v8453 = sdk.RECOMMENDED_TRANSFER_VALIDATOR?.[8453] ?? null;
check((v8453 ?? '').toLowerCase() === (W.validator8453 ?? '').toLowerCase(), `base 721C recommended validator still ${v8453}`, `**base 721C recommended validator changed:** ${W.validator8453} → ${v8453} (lesson 721c-base-mainnet)`);
const reg8453 = sdk.AB_DEPENDENCY_REGISTRY?.[8453] ?? null;
check(reg8453 === W.depRegistry8453, reg8453 ? `base dependency registry ${reg8453}` : 'still no dependency registry on base', `**base dependency registry changed:** ${W.depRegistry8453} → ${reg8453} (lesson base-no-dependency-registry may be fixed)`);

// 5. live: rebuild a known token, code must hash the same
try {
  const r = await rebuildToken({ ...W.liveToken, outDir: dir });
  check(r.codeSha256 === W.liveToken.codeSha256 && r.fullyFromChain, `live rebuild of ${W.liveToken.contract} #${W.liveToken.tokenId} ok`, `**live rebuild differs:** sha ${r.codeSha256}, fullyFromChain ${r.fullyFromChain}`);
} catch (e) {
  changes.push(`**live rebuild failed:** ${e.message} (may be an RPC outage; rerun before acting)`);
}

const report = [
  `# abx watch .. ${new Date().toISOString().slice(0, 10)}`,
  `abx-cli ${cli} · abx-sdk ${sdkVer} · lessons last checked on ${LESSONS.testedCli}`,
  '',
  changes.length ? '## needs a look\n\n' + changes.map((c) => `- ${c}`).join('\n') : '## nothing changed',
  '',
  '## still true\n\n' + ok.map((c) => `- ${c}`).join('\n'),
  '',
  'not checkable automatically (needs a deploy): collection image override, renderer square/10s limit, OpenSea placeholder cache, wallet hijack.',
].join('\n');
writeFileSync('report.md', report);
console.log(report);
console.log(`\nCHANGED=${changes.length > 0}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changes.length > 0}\ncli=${cli}\n`);
