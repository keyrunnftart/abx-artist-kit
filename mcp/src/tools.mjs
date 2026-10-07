// the tool logic, kept separate from the MCP wiring so each piece can be run and tested on its own.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import {
  SEL, ZERO, chainOf, tryCall, word, addrWord, words, asAddr, asUint, asBool,
  decodeString, decodeKeys, readScript, readSeed, readDependencies, hasDependencyRegistry, RECOMMENDED_721C, CHAINS, isSponsored,
} from './chain.mjs';
import { resolveDependency } from './deps.mjs';
import { buildDocument, tokenDataJson } from './html.mjs';

const LESSONS = JSON.parse(readFileSync(new URL('./lessons.json', import.meta.url), 'utf8'));
const OPENSEA_721C = '0xa000027a9b2802e1ddf7000061001e5c005a0000';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const lesson = (id) => LESSONS.lessons.find((l) => l.id === id);
const cite = (id) => `(lesson: ${id})`;

// ---------- rebuild_token ----------
export async function rebuildToken({ contract, tokenId, chain = 'base', rpc, outDir }) {
  const c = chainOf(chain);
  const { count, script } = await readScript(chain, contract, rpc);
  if (!count) throw new Error('no script chunks on this contract .. not an ABX code project?');
  const seed = await readSeed(chain, contract, tokenId, rpc);
  if (!seed) throw new Error(`token #${tokenId} has no seed .. not minted yet?`);
  const [tokenKeys, contractKeys, depInfo, locked] = await Promise.all([
    tryCall(chain, contract, SEL.tokenParamKeys + word(tokenId), rpc).then((h) => (h ? decodeKeys(h) : [])),
    tryCall(chain, contract, SEL.contractParamKeys, rpc).then((h) => (h ? decodeKeys(h) : [])),
    readDependencies(chain, contract, rpc),
    tryCall(chain, contract, SEL.scriptLocked, rpc).then((h) => (h ? asBool(words(h)[0]) : null)),
  ]);
  const extra = [...tokenKeys.filter((k) => k !== 'seed'), ...contractKeys];
  const libs = [];
  for (const d of depInfo.list) libs.push(await resolveDependency(d, { chain, registry: depInfo.registry, rpc }));
  const html = buildDocument(script, tokenDataJson({ chainId: c.id, contract, tokenId, seed: seed.seed }), { title: `#${tokenId}`, depTags: libs.map((l) => l.tag) });
  const dir = resolve(outDir ?? process.cwd());
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${contract.slice(0, 8).toLowerCase()}_${tokenId}.html`);
  writeFileSync(file, html);
  const urls = script.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
  const warn = [];
  if (seed.isHash) warn.push('the seed is stored as a hash, not a literal .. this rebuild passes the hash');
  if (extra.length) warn.push(`the program may also read: ${extra.join(', ')} .. not passed in this rebuild, so it may differ`);
  for (const l of libs) if (!l.onchain) warn.push(`library ${l.name}: ${l.note} (${l.source})`);
  if (libs.some((l) => l.onchain && /Ethereum/.test(l.source)) && !hasDependencyRegistry(chain))
    warn.push(`library bytes come from Art Blocks' registry on Ethereum; ABX's own live view on ${chain} loads them from a CDN ${cite('base-no-dependency-registry')}`);
  if (urls.length) warn.push(`the code references ${urls.length} external URL(s): ${[...new Set(urls)].slice(0, 5).join(' ')}`);
  return {
    file,
    contract, chain, tokenId: String(tokenId),
    codeBytes: Buffer.byteLength(script), chunks: count, scriptLocked: locked,
    codeSha256: sha256(script),
    seed: seed.seed,
    inputs: extra.length ? ['seed', ...extra] : ['seed'],
    libraries: libs.map(({ name, onchain, source, bytes }) => ({ name, onchain, source, bytes })),
    externalUrls: urls.length,
    fullyFromChain: !extra.length && libs.every((l) => l.onchain) && !urls.length && !seed.isHash,
    warnings: warn,
  };
}

// ---------- inspect_contract ----------
export async function inspectContract({ contract, chain = 'base', rpc }) {
  const c = chainOf(chain);
  const q = (sel) => tryCall(chain, contract, sel, rpc);
  const [name, symbol, owner, paused, supply, max, minter, payee, validator, royalty, maxRoy, chunks, sLocked,
    deps, hooks, hLocked, uriBase, uriLocked, renderer, cKeys] = await Promise.all([
    q(SEL.name), q(SEL.symbol), q(SEL.owner), q(SEL.paused), q(SEL.totalSupply), q(SEL.maxInvocations),
    q(SEL.minter), q(SEL.primaryPayee), q(SEL.getTransferValidator), q(SEL.royaltyInfo + word(0) + word(10000)),
    q(SEL.maxRoyaltyBps), q(SEL.scriptChunkCount), q(SEL.scriptLocked), q(SEL.dependencyCount),
    q(SEL.paramHooks), q(SEL.paramHooksLocked), q(SEL.tokenURIBase), q(SEL.tokenURILocked),
    q(SEL.tokenURIRenderer), q(SEL.contractParamKeys),
  ]);
  if (!chunks && !name) throw new Error('no ABX contract found at this address on ' + chain);
  const w0 = (h) => (h ? words(h)[0] : null);
  const out = {
    contract, chain, explorer: `${c.explorer}/address/${contract}`,
    name: name ? decodeString(name) : null,
    symbol: symbol ? decodeString(symbol) : null,
    owner: owner ? asAddr(w0(owner)) : null,
    supply: supply ? Number(asUint(w0(supply))) : null,
    maxInvocations: max ? Number(asUint(w0(max))) : null,
    paused: paused ? asBool(w0(paused)) : null,
    minter: minter ? asAddr(w0(minter)) : null,
    primaryPayee: payee ? asAddr(w0(payee)) : null,
    royalty: royalty ? { receiver: asAddr(words(royalty)[0]), bps: Number(asUint(words(royalty)[1])) } : null,
    maxRoyaltyBps: maxRoy ? Number(asUint(w0(maxRoy))) : null,
    transferValidator: validator ? asAddr(w0(validator)) : null,
    script: { chunks: chunks ? Number(asUint(w0(chunks))) : 0, locked: sLocked ? asBool(w0(sLocked)) : null },
    dependencies: deps ? Number(asUint(w0(deps))) : 0,
    paramHooks: hooks ? (([a, b, d]) => ({ configureHook: asAddr(a), augmentHook: asAddr(b), transferHook: asAddr(d) }))(words(hooks)) : null,
    paramHooksLocked: hLocked ? asBool(w0(hLocked)) : null,
    tokenURIBase: uriBase ? decodeString(uriBase) : null,
    tokenURILocked: uriLocked ? asBool(w0(uriLocked)) : null,
    tokenURIRenderer: renderer ? asAddr(w0(renderer)) : null,
    contractParams: cKeys ? decodeKeys(cKeys) : [],
  };
  if (out.minter && out.minter !== ZERO) {
    const s = await tryCall(chain, out.minter, SEL.minterSales + addrWord(contract), rpc);
    if (s) {
      const [configured, , price, alloc, sold] = words(s).map((x) => asUint(x));
      out.sale = { configured: configured === 1n, priceEth: Number(price) / 1e18, allocation: Number(alloc), sold: Number(sold) };
    }
  }
  const notes = [];
  if (out.script.locked === false) notes.push(`script is NOT locked .. the owner can still change every token ${cite('lock-script')}`);
  if (out.paramHooksLocked === false) {
    const set = out.paramHooks && Object.entries(out.paramHooks).filter(([, a]) => a !== ZERO).map(([k]) => k);
    notes.push(`param hooks unlocked${set?.length ? ` (set: ${set.join(', ')})` : ' (none set)'} .. owner could add a transfer/mint hook ${cite('param-hooks-open')}`);
  }
  if (out.transferValidator === ZERO) notes.push('no ERC-721C transfer validator .. royalties are optional on every marketplace');
  else if (out.transferValidator?.toLowerCase() === OPENSEA_721C) notes.push('721C = OpenSea StrictAuthorizedTransferSecurityRegistry .. secondary effectively OpenSea-only, royalties enforced');
  if (out.tokenURIBase?.includes('resolver.abx.io')) notes.push('metadata (image + traits) served by resolver.abx.io; code + seeds are on-chain .. prove it with rebuild_token');
  if (out.royalty && out.primaryPayee && out.owner && new Set([out.owner, out.primaryPayee, out.royalty.receiver].map((a) => a.toLowerCase())).size > 1)
    notes.push('owner, primary payee and royalty receiver are not all the same wallet .. check that is intended');
  if (out.dependencies) notes.push(`${out.dependencies} on-chain dependenc${out.dependencies === 1 ? 'y' : 'ies'} declared`);
  out.notes = notes;
  return out;
}

// ---------- lint_script ----------
export function lintScript({ path, source }) {
  const src = source ?? readFileSync(path, 'utf8');
  const bytes = Buffer.byteLength(src);
  const lines = src.split('\n');
  const findings = [];
  const add = (level, msg, id) => findings.push({ level, msg: id ? `${msg} ${cite(id)}` : msg });
  const lineOf = (re) => {
    const out = [];
    lines.forEach((l, i) => { if (re.test(l.replace(/\/\/.*$/, ''))) out.push(i + 1); });
    return out;
  };
  const at = (ls) => (ls.length ? ` (line ${ls.slice(0, 5).join(', ')}${ls.length > 5 ? ', …' : ''})` : '');

  // size and chunking
  const CHUNK = 22000;
  const chunks = Math.max(1, Math.ceil(bytes / CHUNK));
  add('info', `${bytes.toLocaleString()} bytes .. about ${chunks} on-chain chunk${chunks > 1 ? 's' : ''}`);
  const longLines = lines.map((l, i) => [i + 1, Buffer.byteLength(l)]).filter(([, n]) => n >= CHUNK);
  if (longLines.length) add('error', `line(s) of ${CHUNK}+ bytes with no newline: ${longLines.map(([i, n]) => `${i} (${n} B)`).join(', ')} .. ABX can't split them safely`, 'chunk-newline');

  // determinism
  const rnd = lineOf(/Math\.random\s*\(/);
  if (rnd.length) add('error', `Math.random used${at(rnd)} .. output won't be reproducible from the seed`, 'math-random');
  const date = lineOf(/Date\.now\s*\(|new Date\s*\(/);
  if (date.length) add('warn', `Date/clock used${at(date)} .. fine for timing loops, wrong if it shapes the image`, 'math-random');
  const perf = lineOf(/performance\.now\s*\(/);
  if (perf.length) add('info', `performance.now used${at(perf)} .. fine for timing only`);
  const crypt = lineOf(/crypto\.getRandomValues|crypto\.randomUUID/);
  if (crypt.length) add('error', `crypto randomness used${at(crypt)}`, 'math-random');
  if (!/tokenData/.test(src)) add('error', 'never reads abx.tokenData .. the seed is how each token differs');
  else if (!/\.seed\b/.test(src)) add('warn', 'reads tokenData but never .seed .. make sure randomness comes from the mint seed');

  // ABX contract with the renderer
  if (!/abx\.done\s*\(/.test(src)) add('error', 'never calls abx.done() .. the hosted renderer waits ~10 s, then captures whatever is drawn', 'renderer-10s-timeout');
  if (!/abx\.traits\s*\(/.test(src)) add('warn', 'never calls abx.traits(...) .. marketplaces will show no traits');

  // plain JS, self-contained
  const mod = lineOf(/^\s*(import\s[^(]|export\s)/);
  if (mod.length) add('error', `ES module import/export${at(mod)} .. ABX runs one plain <script>, bundle it first`);
  const net = lineOf(/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|import\s*\(/);
  if (net.length) add('warn', `network access${at(net)} .. the piece depends on something off-chain`);
  const urls = [...new Set(src.match(/https?:\/\/[^\s'"`)]+/g) ?? [])];
  if (urls.length) add('warn', `external URLs: ${urls.slice(0, 5).join(' ')}${urls.length > 5 ? ' …' : ''} .. not on-chain`);
  const store = lineOf(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  if (store.length) add('warn', `browser storage${at(store)} .. renders could differ between viewers`);
  const libs = [['p5', /\bcreateCanvas\s*\(|\bp5\./], ['three.js', /\bTHREE\./], ['tone.js', /\bTone\./], ['regl', /\bcreateREGL\b|\bregl\(/]]
    .filter(([, re]) => re.test(src)).map(([n]) => n);
  if (libs.length) add('info', `looks like it uses ${libs.join(', ')} .. declare it with --dep, don't load it from a CDN. only some versions are stored on-chain (p5@1.0.0 and three@0.124.0 are; p5@1.9.0 is CDN-only) .. see list_libraries, test with render_check dependencies`, 'base-no-dependency-registry');
  if (libs.includes('p5')) {
    const usesRandom = /\brandom\s*\(|\brandomGaussian\s*\(|\bshuffle\s*\(/.test(src.replace(/Math\.random/g, ''));
    if (usesRandom && !/\brandomSeed\s*\(/.test(src)) add('error', 'p5 random()/shuffle() used without randomSeed(...) from the mint seed .. every load differs', 'math-random');
    if (/\bnoise\s*\(/.test(src) && !/\bnoiseSeed\s*\(/.test(src)) add('error', 'p5 noise() used without noiseSeed(...) from the mint seed .. every load differs', 'math-random');
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  return { path: path ?? null, bytes, chunks, sha256: sha256(src), ok: errors === 0, errors, findings };
}

// ---------- render_check ----------
export async function launchBrowser(chromePath) {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch {
    throw new Error('render_check needs playwright-core: npm i playwright-core (uses your installed Chrome)');
  }
  const opts = { headless: true };
  if (chromePath) opts.executablePath = chromePath; else opts.channel = 'chrome';
  return chromium.launch(opts);
}

export async function renderCheck({ path, seeds = 10, size = 1000, timeoutSec = 20, chromePath, dependencies = [], chain = 'base' }) {
  const src = readFileSync(path, 'utf8');
  const libs = [];
  for (const d of dependencies) libs.push(await resolveDependency(d, { chain }));
  const depTags = libs.map((l) => l.tag);
  const dir = mkdtempSync(join(tmpdir(), 'abx-render-'));
  const browser = await launchBrowser(chromePath);
  const runs = [];
  const renderOne = async (seed, n) => {
    const file = join(dir, `s${n}.html`);
    writeFileSync(file, buildDocument(src, tokenDataJson({ chainId: 84532, contract: ZERO, tokenId: n, seed }), { probe: true, depTags }));
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const t0 = Date.now();
    await page.goto(pathToFileURL(file).href);
    let done = true;
    try { await page.waitForFunction(() => window.abx && window.abx.__done, null, { timeout: timeoutSec * 1000, polling: 50 }); } catch { done = false; }
    const ms = Date.now() - t0;
    const r = await page.evaluate(() => {
      const cs = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height);
      return { traits: window.abx?.__traits ?? null, probe: window.__probe, canvas: cs[0] ? [cs[0].width, cs[0].height] : null };
    });
    const shot = sha256(await page.screenshot());
    await page.close();
    return { seed, ms, done, errors: errs, ...r, shot };
  };
  try {
    const list = Array.from({ length: Math.max(1, Math.min(200, seeds)) }, () => '0x' + randomBytes(32).toString('hex'));
    for (let i = 0; i < list.length; i++) runs.push(await renderOne(list[i], i));
    const again = await renderOne(list[0], 0);
    const deterministic = again.shot === runs[0].shot && JSON.stringify(again.traits) === JSON.stringify(runs[0].traits);

    const times = runs.map((r) => r.ms).sort((a, b) => a - b);
    const slow = runs.reduce((a, b) => (b.ms > a.ms ? b : a));
    const traitDist = {};
    for (const r of runs) for (const [k, v] of Object.entries(r.traits ?? {})) {
      traitDist[k] ??= {};
      traitDist[k][String(v)] = (traitDist[k][String(v)] ?? 0) + 1;
    }
    const probes = runs.reduce((a, r) => ({ random: a.random + (r.probe?.random ?? 0), dateNow: a.dateNow + (r.probe?.dateNow ?? 0), fetch: a.fetch + (r.probe?.fetch ?? 0) }), { random: 0, dateNow: 0, fetch: 0 });
    const findings = [];
    const notDone = runs.filter((r) => !r.done).length;
    if (notDone) findings.push({ level: 'error', msg: `${notDone}/${runs.length} seeds never called abx.done() within ${timeoutSec}s ${cite('renderer-10s-timeout')}` });
    if (slow.ms > 8000) findings.push({ level: 'error', msg: `slowest seed took ${(slow.ms / 1000).toFixed(1)}s .. the hosted renderer gives up near 10s ${cite('renderer-10s-timeout')}` });
    else if (slow.ms > 5000) findings.push({ level: 'warn', msg: `slowest seed took ${(slow.ms / 1000).toFixed(1)}s on this machine .. ABX's renderer may be slower, aim under 5s ${cite('renderer-10s-timeout')}` });
    if (!deterministic) findings.push({ level: 'error', msg: `the same seed rendered twice gave a different ${again.shot !== runs[0].shot ? 'image' : 'trait set'} ${cite('math-random')}` });
    if (probes.random) findings.push(deterministic
      ? { level: 'warn', msg: `Math.random called ${probes.random} times over ${runs.length} renders, but the same seed gave the same image .. likely library internals, check your own code ${cite('math-random')}` }
      : { level: 'error', msg: `Math.random called ${probes.random} times during renders ${cite('math-random')}` });
    if (probes.fetch) findings.push({ level: 'warn', msg: `fetch called ${probes.fetch} times .. depends on the network` });
    const errs = [...new Set(runs.flatMap((r) => r.errors))];
    if (errs.length) findings.push({ level: 'error', msg: `page errors: ${errs.slice(0, 3).join(' | ')}` });
    const cv = runs[0].canvas;
    if (cv && cv[0] !== cv[1]) findings.push({ level: 'warn', msg: `canvas is ${cv[0]}x${cv[1]} .. ABX thumbnails are square 1000x1000, this will be letterboxed ${cite('renderer-square-1000')}` });
    if (!Object.keys(traitDist).length) findings.push({ level: 'warn', msg: 'no traits reported .. call abx.traits({...})' });
    for (const [k, vals] of Object.entries(traitDist)) {
      if (Object.keys(vals).length === 1 && runs.length >= 5) findings.push({ level: 'info', msg: `trait "${k}" was the same on every seed (${Object.keys(vals)[0]})` });
    }
    for (const l of libs) findings.push(l.onchain
      ? { level: 'info', msg: `library ${l.name} loaded from ${l.source}` }
      : { level: 'warn', msg: `library ${l.name} loaded from ${l.source} .. not on-chain` });
    return {
      path, seeds: runs.length, size,
      timeMs: { min: times[0], median: times[Math.floor(times.length / 2)], max: times.at(-1), slowestSeed: slow.seed },
      deterministic, canvas: cv, nondeterminismProbe: probes,
      traitDistribution: traitDist,
      ok: !findings.some((f) => f.level === 'error'),
      findings,
      note: 'times are from this machine; the hosted renderer may be slower. traits are counts over random seeds, not the minted set.',
    };
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- preflight ----------
export function preflight({ commands, chain, cliVersion }) {
  const text = commands.replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const lines = text.split(/\r?\n|&&|;/).map((l) => l.trim()).filter(Boolean);
  const findings = [];
  const add = (level, msg, id) => findings.push({ level, msg: id ? `${msg} ${cite(id)}` : msg });
  const flag = (l, f) => { const m = l.match(new RegExp(`--${f}(?:[ =]+("[^"]*"|'[^']*'|\\S+))?`)); return m ? (m[1] ?? true) : undefined; };
  const chainOfLine = (l) => (l.match(/ABX_CHAIN=(\S+)/)?.[1] ?? chain ?? null);
  let sponsored = false, setAdmin = false, lockScript = false, deploy = false;

  for (const l of lines) {
    const ch = chainOfLine(l);
    if (/\babx\s+deploy(-code)?\b/.test(l)) {
      deploy = true;
      if (!ch) add('warn', 'no ABX_CHAIN on the deploy line .. say which chain explicitly');
      const v = flag(l, '721c');
      if (ch && CHAINS[ch] && v === 'recommended' && !RECOMMENDED_721C[CHAINS[ch].id])
        add('error', `--721c recommended has no answer on ${ch} (abx knows a recommended validator for ethereum, sepolia, base, base-sepolia only) .. pass a validator address or leave --721c off`, '721c-other-chains');
      if (ch === 'ethereum' && cliVersion && cmpVer(cliVersion, '0.5.0') < 0) add('error', `ethereum needs abx CLI 0.5.0+ (you have ${cliVersion})`, 'ethereum-beta');
      if (ch === 'ethereum') add('info', 'ethereum mainnet: code is stored in L1 calldata/bytecode, so deploy + upload gas is far higher than on base .. run it on sepolia first and check the cost', 'ethereum-beta');
      if (ch === 'base' && v === 'recommended') {
        if (!cliVersion) add('warn', '--721c recommended on base mainnet needs CLI 0.4.2+ .. on older CLIs pass 0xA000027A9B2802E1ddf7000061001e5c005A0000 (pass cliVersion to check)', '721c-base-mainnet');
        else if (cmpVer(cliVersion, '0.4.2') < 0) add('error', `--721c recommended does not resolve on base mainnet in CLI ${cliVersion} .. pass 0xA000027A9B2802E1ddf7000061001e5c005A0000 or upgrade to 0.4.2+`, '721c-base-mainnet');
      }
      const deps = [...l.matchAll(/--dep[ =]+(\S+)/g)].flatMap((m) => m[1].split(','));
      if (ch && CHAINS[ch] && !hasDependencyRegistry(ch) && deps.some((x) => /@/.test(x))) add('warn', `name@version deps on ${ch} (${deps.filter((x) => /@/.test(x)).join(', ')}) .. no art blocks registry on this chain, so ABX's live view will load them from a CDN`, 'base-no-dependency-registry');
      if (hasDependencyRegistry(ch) && deps.some((x) => /@/.test(x))) add('info', `name@version deps on ${ch} resolve through art blocks' on-chain registry .. pick a version stored fully on-chain (list_libraries)`);
      if (v === undefined) add('info', 'no --721c .. royalties will be optional on every marketplace (fine if intended)');
      const bps = flag(l, 'royalty-bps');
      if (bps === undefined) add('info', 'no --royalty-bps .. the default is 5%');
      else if (+bps > 1000) add('warn', `royalty ${+bps / 100}% .. above the usual 10% cap`);
      if (flag(l, 'onchain-uri') !== undefined) add('warn', '--onchain-uri: marketplaces get a placeholder image and no traits', 'onchain-uri-no-traits');
      else if (flag(l, 'public-base-url') === undefined) add('warn', 'no --public-base-url .. tokenURI may not point at a resolver that serves images/traits', 'onchain-uri-no-traits');
      if (flag(l, 'primary-payee') === undefined) add('warn', 'no --primary-payee .. check where primary sales money goes');
      if (flag(l, 'max') === undefined) add('warn', 'no --max .. set the edition cap explicitly');
      if (flag(l, 'minter') === undefined) add('info', 'no --minter .. you will need set-minter before any public sale');
      if (flag(l, 'sponsor') !== undefined) sponsored = true;
      const script = flag(l, 'script');
      if (typeof script === 'string') add('info', `run lint_script and render_check on ${script.replace(/^["']|["']$/g, '')} before deploying`);
    }
    if (/\babx\s+attach\b/.test(l)) {
      const m = l.match(/attach\s+\S+\s+(\S+)/);
      if (m && m[1] === 'image' && /--collection\b/.test(l)) add('error', 'collection-scope `image` replaces EVERY token thumbnail and cannot be cleared .. use featured_image', 'collection-image-override');
    }
    if (/\babx\s+set-admin\b/.test(l)) setAdmin = true;
    if (/\babx\s+lock-script\b/.test(l)) lockScript = true;
    if (/--sponsor\b/.test(l)) {
      sponsored = true;
      if (ch && CHAINS[ch] && !isSponsored(ch)) add('error', `--sponsor on ${ch}: abx only pays gas on base and base-sepolia .. drop --sponsor and sign from your own wallet (it pays the gas)`, 'sponsor-base-only');
    }
  }
  if (sponsored && !setAdmin) add('warn', '--sponsor without set-admin .. ABX\'s creator wallet stays owner/creator', 'sponsored-deployer');
  if (deploy && !lockScript) add('info', 'no lock-script in this plan .. lock before the public sale', 'lock-script');
  if (!lines.length) add('warn', 'no commands found');
  return { ok: !findings.some((f) => f.level === 'error'), commands: lines.length, findings, testedCli: LESSONS.testedCli, cliVersion: cliVersion ?? null };
}

// ---------- lessons ----------
function cmpVer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export function detectCliVersion(projectDir) {
  return new Promise((res) => {
    const bin = join(resolve(projectDir ?? process.cwd()), 'node_modules', '@artblocks', 'abx-cli', 'dist', 'bin.js');
    execFile(process.execPath, [bin, '--version'], { timeout: 20000, env: { ...process.env, ABX_NO_UPDATE_CHECK: '1' } }, (err, out) => {
      res(err ? null : (out.match(/\d+\.\d+\.\d+/)?.[0] ?? null));
    });
  });
}

export async function lessons({ topic, projectDir }) {
  const cli = await detectCliVersion(projectDir);
  const list = LESSONS.lessons.filter((l) => !topic || l.topic === topic || l.id === topic);
  const newer = cli && cmpVer(cli, LESSONS.testedCli) > 0;
  return {
    testedCli: LESSONS.testedCli,
    yourCli: cli ?? 'not found (pass projectDir where @artblocks/abx-cli is installed)',
    staleWarning: newer ? `your CLI ${cli} is newer than ${LESSONS.testedCli} (last checked) .. some lessons may already be fixed, recheck before relying on them` : null,
    topics: [...new Set(LESSONS.lessons.map((l) => l.topic))],
    lessons: list.map(({ id, topic: t, seenIn, problem, fix, fixedIn, fixNote, changedIn, changeNote }) => {
      let status = 'open';
      if (fixedIn) status = cli ? (cmpVer(cli, fixedIn) >= 0 ? `fixed in your CLI (${fixedIn}+)` : `fixed in ${fixedIn} .. upgrade, or apply the fix`) : `fixed in ${fixedIn}`;
      else if (changedIn) status = `improved in ${changedIn}, still applies`;
      return { id, topic: t, status, seenIn, problem, fix, ...(fixNote || changeNote ? { update: fixNote ?? changeNote } : {}) };
    }),
  };
}

export { LESSONS, lesson };

