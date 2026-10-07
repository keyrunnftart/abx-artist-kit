// launch tools learned from running "nothing here moves" on abx: cost before you sign, the edition before you deploy,
// mint help during the drop, collectors and waves while it runs, print files and marketplace checks after.
// all read-only: eth_call / eth_getLogs / http GETs, nothing is signed. (marketplace_check can ask opensea to refresh, only if you say so.)

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SEL, ZERO, CHAINS, LOG_RPCS, ROLLUP, OPENSEA_SLUG, SPONSORED_CHAINS, chainOf, rpcRequest, tryCall, ethCall, word, addrWord, words, asAddr, asUint, asBool, decodeString,
} from './chain.mjs';
import { resolveDependency } from './deps.mjs';
import { buildDocument, tokenDataJson } from './html.mjs';
import { launchBrowser, rebuildToken } from './tools.mjs';
import { namehash } from './keccak.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hex = (n) => '0x' + BigInt(n).toString(16);
const eth = (wei) => Number(wei) / 1e18;
const round = (x, d = 6) => (x == null ? null : Number(x.toFixed(d)));
const pool = async (items, n, fn) => { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; };
const encBytes = (buf) => { const h = Buffer.from(buf).toString('hex'); return word(32) + word(buf.length) + h.padEnd(Math.ceil(h.length / 64) * 64, '0'); };

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SEL2 = {
  purchase: '0x64044156', ownerOf: '0x6352211e', balanceOf: '0x70a08231',
  getL1Fee: '0x49948e0e', gasEstimateL1Component: '0x77d488a2', ensResolver: '0x0178b8bf', ensName: '0x691f3431', ensAddr: '0x3b3b57de',
};
const OP_ORACLE = '0x420000000000000000000000000000000000000F', ARB_NODE = '0x00000000000000000000000000000000000000C8';
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
// abx fixed-price minter + series token errors (selectors from the abx sdk abi, cli 0.6.0), in plain words
const ERRORS = {
  '0x7787310b': 'this wave is sold out (allocation used up) .. wait for the next wave',
  '0xd311bc39': 'no sale is configured for this collection on the minter yet',
  '0x788a686f': 'wrong payment amount .. send exactly the mint price',
  '0xf73a3632': 'the price or terms changed since the page loaded .. reload and try again',
  '0x662bebf8': 'the collection has no primary payee set .. the artist has to fix this',
  '0xab143c06': 'reentrancy guard',
  '0xeb560756': 'minting is paused on the collection',
  '0xba470cd5': 'the collection has reached its max supply',
  '0x98eac474': 'the minter is not allowed to mint on this collection',
};
const why = (data) => { const sel = String(data ?? '').slice(0, 10).toLowerCase(); return ERRORS[sel] ?? (sel.length === 10 ? `reverted with ${sel}` : null); };

async function blockNumber(chain, rpc) { return Number(BigInt(await rpcRequest(chain, 'eth_blockNumber', [], rpc))); }
async function blockTime(chain, n, rpc) { const b = await rpcRequest(chain, 'eth_getBlockByNumber', [hex(n), false], rpc, LOG_RPCS[chain]); return Number(BigInt(b.timestamp)); }
async function saleOf(chain, contract, rpc) {
  const minter = await tryCall(chain, contract, SEL.minter, rpc);
  const m = minter ? asAddr(words(minter)[0]) : null;
  if (!m || m === ZERO) return { minter: null };
  const s = await tryCall(chain, m, SEL.minterSales + addrWord(contract), rpc);
  if (!s) return { minter: m };
  const w = words(s);
  return { minter: m, configured: asUint(w[0]) === 1n, paymentToken: asAddr(w[1]), priceWei: asUint(w[2]), allocation: Number(asUint(w[3])), sold: Number(asUint(w[4])) };
}
async function basics(chain, contract, rpc) {
  const q = (sel) => tryCall(chain, contract, sel, rpc);
  const [name, owner, paused, supply, max] = await Promise.all([q(SEL.name), q(SEL.owner), q(SEL.paused), q(SEL.totalSupply), q(SEL.maxInvocations)]);
  if (!name && !supply) throw new Error(`no ABX contract found at ${contract} on ${chain}`);
  return { name: name ? decodeString(name) : null, owner: owner ? asAddr(words(owner)[0]) : null, paused: paused ? asBool(words(paused)[0]) : null,
    supply: supply ? Number(asUint(words(supply)[0])) : null, max: max ? Number(asUint(words(max)[0])) : null };
}

// ---------- logs: wide-range eth_getLogs with adaptive chunks (public rpcs cap ranges at 50-10k blocks) ----------
async function getLogs(chain, filter, from, to, rpc) {
  const urls = rpc ? [rpc] : LOG_RPCS[chain];
  // "ranges over 10000 blocks", "limited to a 500 range", "limited to 0 - 50 blocks" .. drpc's free tier also changes its limit under load
  const limitOf = (m) => { const x = String(m).match(/(?:ranges? over|limited to (?:a |0 - )?|up to|maximum(?: of)?|exceed(?:s|ed)?(?: the)?(?: max(?:imum)?)?(?: range(?: of)?)?)\s*(\d{2,6})/i); return x ? Number(x[1]) : null; };
  const isRate = (m) => /rate|too many|429|capacity|timeout|ECONN|fetch failed|temporar|retry|internal error|busy|unavailable/i.test(m) && !limitOf(m);
  let ui = 0, step = 9998;
  const call = async (a, b) => {
    for (let tries = 0; ; tries++) {
      try { return await rpcRequest(chain, 'eth_getLogs', [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }], null, [urls[ui]]); } catch (e) {
        const lim = limitOf(e.message);
        if (lim || /range|block/i.test(e.message) && /limit|support|exceed|max/i.test(e.message)) {   // too wide for this rpc: shrink, same rpc
          if (b - a < 2) throw e;
          step = Math.min(step, Math.floor((b - a) / 2), lim ? Math.max(1, lim - 2) : Infinity); return null;
        }
        if (isRate(e.message) && tries < 6) { await new Promise((ok) => setTimeout(ok, 600 * 2 ** tries)); continue; }
        if (ui < urls.length - 1) { ui++; tries = -1; continue; }
        throw e;
      }
    }
  };
  const out = [];
  for (let a = from; a <= to;) {
    const wins = []; for (let x = a, k = 0; x <= to && k < 3; k++) { const y = Math.min(to, x + step); wins.push([x, y]); x = y + 1; }
    const res = await Promise.all(wins.map(([x, y]) => call(x, y)));
    let k = 0; for (; k < wins.length && res[k] !== null; k++) out.push(...res[k]);
    a = k ? wins[k - 1][1] + 1 : a;                                                        // a window hit a smaller limit: redo from it
  }
  return out;
}
// all mint Transfer logs of a collection, two ways:
//  1. archive rpcs: split the block range on totalSupply(block) and only fetch logs where supply changed (a few dozen calls)
//  2. otherwise: walk back from the latest block until every minted token is found (no archive, no deploy-block search)
const MINT_TOPICS = [TRANSFER, '0x' + '0'.repeat(64)];
let inFlight = 0; const waiters = [];
const gate = async (fn) => { while (inFlight >= 4) await new Promise((ok) => waiters.push(ok)); inFlight++; try { return await fn(); } finally { inFlight--; waiters.shift()?.(); } };
async function supplyAt(chain, contract, n, urls) {
  for (let tries = 0; ; tries++) {
    try { const r = await gate(() => rpcRequest(chain, 'eth_call', [{ to: contract, data: SEL.totalSupply }, hex(n)], null, urls)); return r === '0x' ? 0 : Number(asUint(words(r)[0])); } catch (e) {
      if (/revert|execution reverted/i.test(e.message) || e.revert) return 0;               // before deploy
      if (tries < 7 && /rate|temporar|retry|timeout|fetch failed|429/i.test(e.message)) { await new Promise((ok) => setTimeout(ok, 400 * 2 ** tries)); continue; }
      throw e;
    }
  }
}
async function mintLogs(chain, contract, rpc, fromBlock) {
  const urls = rpc ? [rpc] : LOG_RPCS[chain];
  const end = await blockNumber(chain, rpc);
  const total = await supplyAt(chain, contract, end, urls);
  let archive = true;
  try { await supplyAt(chain, contract, Math.max(0, end - 200000), urls); } catch { archive = false; }
  if (archive) {
    const W = 450, out = [];
    const walk = async (a, b, sa, sb) => {
      if (sa === sb) return;
      if (b - a < W) { out.push(...(await gate(() => getLogs(chain, { address: contract, topics: MINT_TOPICS }, a, b, rpc)))); return; }
      const mid = Math.floor((a + b) / 2), sm = await supplyAt(chain, contract, mid, urls);
      await Promise.all([walk(a, mid, sa, sm), walk(mid + 1, b, sm, sb)]);
    };
    const start = fromBlock ?? 0;
    await walk(start, end, start ? await supplyAt(chain, contract, start - 1, urls) : 0, total);
    return { logs: out, method: 'archive bisection on totalSupply', total };
  }
  const out = []; let b = end, step = 9998;
  while (b >= (fromBlock ?? 0) && out.length < total) {
    const a = Math.max(fromBlock ?? 0, b - step);
    try { out.push(...(await rpcRequest(chain, 'eth_getLogs', [{ address: contract, topics: MINT_TOPICS, fromBlock: hex(a), toBlock: hex(b) }], null, urls))); b = a - 1; } catch (e) {
      if (step < 2) throw e; step = Math.floor(step / 2);
    }
  }
  return { logs: out, method: 'backward log scan', total };
}

// ---------- L1 data fee (what an L2 charges for posting your bytes to ethereum) ----------
async function l1Fee(chain, data, rpc) {
  const fam = ROLLUP[chain];
  try {
    if (fam === 'op') return asUint(words(await ethCall(chain, OP_ORACLE, SEL2.getL1Fee + encBytes(data), rpc))[0]);
    if (fam === 'arb') {
      const r = words(await ethCall(chain, ARB_NODE, SEL2.gasEstimateL1Component + addrWord(ZERO.replace(/0$/, '1')) + word(0) + word(96) + encBytes(data).slice(64), rpc));
      return asUint(r[0]) * asUint(r[1]);
    }
  } catch { return null; }
  return 0n;
}
async function ethUsd() {
  try { const j = await (await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { headers: { 'user-agent': 'abx-artist-kit' } })).json(); return Number(j.data.amount) || null; } catch { return null; }
}

// ---------- deploy_cost ----------
// gas model = abx cli 0.6.0's own dry-run guidance (deploy.js) + its chunk packing (estimateChunkGasForBytes, 8M budget per setup tx);
// on top of that, the L1 data fee rollups charge for the bytes, which abx's figure leaves out.
export async function deployCost({ path, bytes, chains = ['base', 'ethereum', 'arbitrum', 'robinhood'], dependencies = 0, schemas = 0, mints = 0, saleConfig = true }) {
  const script = path ? readFileSync(path) : null;
  const n = bytes ?? script?.length;
  if (!n) throw new Error('pass path (the .js you will upload) or bytes');
  const CHUNK = 22000, chunks = Math.ceil(n / CHUNK);
  const gas = 250000 + chunks * 34000 + n * 216 + schemas * 45000 + dependencies * 55000 + mints * 65000 + (saleConfig ? 80000 : 0);
  const packGas = Array.from({ length: chunks }, (_, i) => 40000 + Math.min(CHUNK, n - i * CHUNK) * 240);
  let txs = 1, cur = 0; for (const g of packGas) { if (cur && cur + g > 8_000_000) { txs++; cur = 0; } cur += g; } if (chunks) txs++;
  const sample = script ?? Buffer.from(Array.from({ length: n }, (_, i) => 32 + ((i * 7919) % 90)));
  const usd = await ethUsd();
  let sponsoredIds = SPONSORED_CHAINS, sponsorSource = 'kit default (checked 7 oct 2026)';
  try { const d = await (await fetch('https://services.abx.io/.well-known/abx-service', { headers: { 'user-agent': 'abx-artist-kit' } })).json();
    const c = d?.endpoints?.['abx-creator-wallet/v1']?.chains; if (Array.isArray(c)) { sponsoredIds = c; sponsorSource = 'live abx services catalog'; } } catch {}
  const rows = await pool(chains, 4, async (ch) => {
    try {
      const gp = BigInt(await rpcRequest(ch, 'eth_gasPrice', []));
      const exec = BigInt(gas) * gp;
      const l1 = await l1Fee(ch, sample, null);
      const deployL1 = await l1Fee(ch, Buffer.alloc(1200, 1), null);
      const total = exec + (l1 ?? 0n) + (deployL1 ?? 0n);
      return { chain: ch, gasPriceGwei: round(Number(gp) / 1e9, 4), executionEth: round(eth(exec), 8), l1DataEth: l1 == null ? null : round(eth(l1 + (deployL1 ?? 0n)), 8),
        totalEth: round(eth(total), 8), totalUsd: usd ? round(eth(total) * usd, 2) : null,
        sponsor: sponsoredIds.includes(CHAINS[ch].id) ? 'abx pays all of this with --sponsor (then hand ownership to your wallet with set-admin)' : 'not sponsored here .. your wallet pays' };
    } catch (e) { return { chain: ch, error: e.message.slice(0, 120) }; }
  });
  return {
    scriptBytes: n, chunks, transactions: txs, gasApprox: gas,
    model: 'abx cli 0.6.0 dry-run model: 250k clone+init, 34k + 216/byte per stored chunk, 45k/schema, 55k/dependency, 65k/mint (+80k sale configure, our estimate), priced at the live gas price, plus each rollup\'s L1 data fee for the bytes',
    ethUsd: usd, sponsoredChains: { ids: sponsoredIds, source: sponsorSource }, chains: rows.sort((a, b) => (a.totalEth ?? 1e9) - (b.totalEth ?? 1e9)),
    note: 'order-of-magnitude, not a quote. gas prices move by the minute (ethereum most). `abx deploy --dry-run` prints abx\'s own figure; the wallet shows the real fee before you sign.',
  };
}

// ---------- edition_preview ----------
export async function editionPreview({ path, seeds = 100, thumb = 180, size = 600, cols, labelTrait, dependencies = [], chain = 'base', outDir, chromePath, timeoutSec = 30 }) {
  const src = readFileSync(path, 'utf8');
  const libs = []; for (const d of dependencies) libs.push(await resolveDependency(d, { chain }));
  const depTags = libs.map((l) => l.tag);
  const dir = mkdtempSync(join(tmpdir(), 'abx-preview-'));
  const out = resolve(outDir ?? '.'); mkdirSync(out, { recursive: true });
  const N = Math.max(1, Math.min(400, seeds));
  const list = Array.from({ length: N }, (_, i) => '0x' + sha256(`abx-artist-kit edition preview ${i}`));
  const browser = await launchBrowser(chromePath);
  try {
    const runs = await pool(list, 3, async (seed, i) => {
      const file = join(dir, `p${i}.html`);
      writeFileSync(file, buildDocument(src, tokenDataJson({ chainId: 84532, contract: ZERO, tokenId: i, seed }), { depTags }));
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      try {
        await page.goto(pathToFileURL(file).href);
        let done = true;
        try { await page.waitForFunction(() => window.abx && window.abx.__done, null, { timeout: timeoutSec * 1000, polling: 100 }); } catch { done = false; }
        const r = await page.evaluate((t) => {
          const cs = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height);
          let img = null;
          if (cs[0]) { const c = document.createElement('canvas'), k = t / Math.max(cs[0].width, cs[0].height); c.width = Math.round(cs[0].width * k); c.height = Math.round(cs[0].height * k);
            const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cs[0], 0, 0, c.width, c.height); img = c.toDataURL('image/jpeg', 0.85); }
          return { traits: window.abx?.__traits ?? null, img };
        }, thumb);
        return { i, seed, done, ...r };
      } finally { await page.close(); }
    });
    const dist = {};
    for (const r of runs) for (const [k, v] of Object.entries(r.traits ?? {})) { dist[k] ??= {}; dist[k][String(v)] = (dist[k][String(v)] ?? 0) + 1; }
    const odds = Object.fromEntries(Object.entries(dist).map(([k, vals]) => [k, Object.fromEntries(Object.entries(vals).sort((a, b) => b[1] - a[1]).map(([v, c]) => [v, `${c}/${N} (${(c / N * 100).toFixed(1)}%)`]))]));
    const rare = Object.entries(dist).filter(([, vals]) => Object.keys(vals).length <= 12).flatMap(([k, vals]) => Object.entries(vals).filter(([, c]) => c / N < 0.05).map(([v, c]) => `${k}: ${v} (${(c / N * 100).toFixed(1)}%)`));
    const lab = labelTrait ?? Object.keys(dist).find((k) => Object.keys(dist[k]).length > 1 && Object.keys(dist[k]).length <= 12);
    const C = cols ?? Math.ceil(Math.sqrt(N));
    const cells = runs.map((r) => `<figure><img src="${r.img ?? ''}"><figcaption>#${r.i}${lab && r.traits ? ' · ' + String(r.traits[lab] ?? '').replace(/</g, '') : ''}${r.done ? '' : ' · no done()'}</figcaption></figure>`).join('');
    const sheet = join(dir, 'sheet.html');
    writeFileSync(sheet, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111;color:#bbb;font:11px system-ui,sans-serif}
      .g{display:grid;grid-template-columns:repeat(${C},${thumb}px);gap:6px;padding:10px}figure{margin:0}img{width:${thumb}px;height:${thumb}px;object-fit:contain;background:#000;display:block}
      figcaption{padding:2px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:${thumb}px}</style><div class="g">${cells}</div>`);
    const page = await browser.newPage({ viewport: { width: C * (thumb + 6) + 20, height: 400 } });
    await page.goto(pathToFileURL(sheet).href);
    const png = join(out, 'edition_preview.png');
    await page.screenshot({ path: png, fullPage: true });
    await page.close();
    const json = join(out, 'edition_preview.json');
    writeFileSync(json, JSON.stringify({ seeds: N, odds, tokens: runs.map(({ i, seed, traits, done }) => ({ i, seed, done, traits })) }, null, 2));
    const notDone = runs.filter((r) => !r.done).length;
    return {
      sheet: png, data: json, seeds: N, labelledBy: lab ?? null, odds, rare,
      uniqueCombos: new Set(runs.map((r) => JSON.stringify(r.traits))).size,
      findings: [
        ...(notDone ? [{ level: 'error', msg: `${notDone}/${N} seeds never called abx.done() within ${timeoutSec}s` }] : []),
        ...(!Object.keys(dist).length ? [{ level: 'warn', msg: 'no traits reported .. call abx.traits({...})' }] : []),
      ],
      note: 'seeds are fixed (sha256 of "abx-artist-kit edition preview <i>"), so the sheet is reproducible; real mint seeds differ, odds are what to read.',
    };
  } finally { await browser.close(); rmSync(dir, { recursive: true, force: true }); }
}

// ---------- mint_check ----------
export async function mintCheck({ contract, wallet, chain = 'base', rpc }) {
  const c = chainOf(chain);
  const [b, sale, balHex, code] = await Promise.all([basics(chain, contract, rpc), saleOf(chain, contract, rpc),
    rpcRequest(chain, 'eth_getBalance', [wallet, 'latest'], rpc), rpcRequest(chain, 'eth_getCode', [wallet, 'latest'], rpc)]);
  const problems = [], notes = [`the wallet must be on ${chain} (chain id ${c.id}) .. a wallet on another network shows no fee or the wrong price`];
  if (code && /^0xef0100/i.test(code)) notes.push('this wallet has an EIP-7702 delegation (a smart-account upgrade) .. fine, as long as the wallet app supports this chain');
  else if (code && code !== '0x') notes.push('this address is a contract (smart wallet / safe) .. it can mint, but the wallet app has to support this chain');
  if (!sale.minter) problems.push('no minter set on the collection');
  else if (!sale.configured) problems.push('no sale configured on the minter');
  if (sale.paymentToken && sale.paymentToken !== ZERO) notes.push(`priced in an ERC-20 (${sale.paymentToken}) .. this check only simulates ETH sales`);
  if (b.paused) problems.push('minting is paused');
  if (sale.configured && sale.sold >= sale.allocation) problems.push(`this wave is sold out (${sale.sold}/${sale.allocation})`);
  if (b.max && b.supply >= b.max) problems.push(`max supply reached (${b.supply}/${b.max})`);
  const balance = BigInt(balHex);
  let sim = null, fee = null;
  if (sale.minter && sale.configured) {
    const data = SEL2.purchase + addrWord(contract) + addrWord(ZERO) + word(sale.priceWei);
    const tx = { from: wallet, to: sale.minter, data, value: hex(sale.priceWei) };
    try {
      const r = await rpcRequest(chain, 'eth_call', [tx, 'latest'], rpc);
      sim = { ok: true, wouldMintTokenId: Number(asUint(words(r)[0])) };
    } catch (e) {
      const reason = why(e.data) ?? (/insufficient funds/i.test(e.message) ? 'not enough ETH for the price' : e.message.slice(0, 160));
      sim = { ok: false, reason };
      problems.push(`a mint from this wallet would fail: ${reason}`);
    }
    try {
      const g = BigInt(await rpcRequest(chain, 'eth_estimateGas', [tx], rpc)), gp = BigInt(await rpcRequest(chain, 'eth_gasPrice', [], rpc));
      const l1 = (await l1Fee(chain, Buffer.from(data.slice(2), 'hex'), rpc)) ?? 0n;
      fee = { gas: Number(g), networkFeeEth: round(eth(g * gp + l1), 8) };
      const need = sale.priceWei + g * gp + l1;
      if (balance < need) problems.push(`balance ${round(eth(balance), 6)} ETH is below price + fee (${round(eth(need), 6)} ETH)`);
      if (fee.networkFeeEth < 0.000005) notes.push(`the network fee is tiny (${fee.networkFeeEth} ETH) .. wallets may round it to 0, which is normal on ${chain}`);
    } catch { /* estimate fails when the call reverts; the simulation above already says why */ }
  }
  return {
    contract, chain, wallet, collection: b.name, explorer: `${c.explorer}/address/${contract}`,
    sale: sale.configured ? { priceEth: eth(sale.priceWei), allocation: sale.allocation, sold: sale.sold, left: sale.allocation - sale.sold } : null,
    supply: { minted: b.supply, max: b.max }, paused: b.paused,
    balanceEth: round(eth(balance), 6), simulation: sim, fee,
    verdict: problems.length ? 'would not mint' : 'should mint fine', problems, notes,
  };
}

// ---------- collectors ----------
async function ensName(addr) {
  try {
    const node = namehash(addr.toLowerCase().slice(2) + '.addr.reverse');
    const res = asAddr(words(await ethCall('ethereum', ENS_REGISTRY, SEL2.ensResolver + node.slice(2)))[0]);
    if (res === ZERO) return null;
    const name = decodeString(await ethCall('ethereum', res, SEL2.ensName + node.slice(2)));
    if (!name) return null;
    const fwd = namehash(name), fres = asAddr(words(await ethCall('ethereum', ENS_REGISTRY, SEL2.ensResolver + fwd.slice(2)))[0]);
    const back = asAddr(words(await ethCall('ethereum', fres, SEL2.ensAddr + fwd.slice(2)))[0]);
    return back.toLowerCase() === addr.toLowerCase() ? name : null;
  } catch { return null; }
}
async function tokenMeta(chain, contract, id, rpc) {
  try {
    const uri = decodeString(await ethCall(chain, contract, SEL.tokenURI + word(id), rpc));
    if (uri.startsWith('data:application/json')) {
      const body = uri.split(',').slice(1).join(',');
      return JSON.parse(/;base64/.test(uri.split(',')[0]) ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body));
    }
    const url = uri.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/').replace(/^ar:\/\//, 'https://arweave.net/');
    return await (await fetch(url, { headers: { 'user-agent': 'abx-artist-kit', accept: 'application/json' } })).json();
  } catch { return null; }
}
const traitsOf = (meta) => Object.fromEntries((meta?.attributes ?? meta?.traits ?? []).map((a) => [a.trait_type ?? a.key, a.value]));

export async function collectors({ contract, chain = 'base', fromBlock, names = true, traits = true, rareTrait, rareValues = [], rpc }) {
  const b = await basics(chain, contract, rpc);
  const { logs, method, total } = await mintLogs(chain, contract, rpc, fromBlock);
  const mints = logs.map((l) => ({ tokenId: Number(BigInt(l.topics[3])), to: asAddr(l.topics[2].slice(2)), block: Number(BigInt(l.blockNumber)), tx: l.transactionHash }))
    .sort((x, y) => x.tokenId - y.tokenId);
  const meta = traits ? await pool(mints.slice(0, 600), 8, (m) => tokenMeta(chain, contract, m.tokenId, rpc)) : [];
  mints.forEach((m, i) => { if (meta[i]) m.traits = traitsOf(meta[i]); });
  const by = new Map();
  for (const m of mints) { const k = m.to.toLowerCase(); const e = by.get(k) ?? { address: m.to, tokens: [], rare: [] }; e.tokens.push(m.tokenId);
    if (rareTrait && m.traits && rareValues.map(String).includes(String(m.traits[rareTrait]))) e.rare.push(`#${m.tokenId} ${m.traits[rareTrait]}`); by.set(k, e); }
  const owner = b.owner?.toLowerCase();
  const list = [...by.values()].map((e) => ({ ...e, count: e.tokens.length, isOwner: e.address.toLowerCase() === owner })).sort((x, y) => y.count - x.count);
  if (names) await pool(list.slice(0, 60), 6, async (e) => { e.ens = await ensName(e.address); });
  const dist = {};
  for (const m of mints) for (const [k, v] of Object.entries(m.traits ?? {})) { dist[k] ??= {}; dist[k][String(v)] = (dist[k][String(v)] ?? 0) + 1; }
  const [t0, t1] = mints.length ? await Promise.all([blockTime(chain, mints[0].block, rpc), blockTime(chain, mints.at(-1).block, rpc)]) : [null, null];
  return {
    contract, chain, collection: b.name, scan: method,
    minted: mints.length, ...(total > mints.length ? { warning: `totalSupply is ${total} but ${mints.length} mints were found .. pass fromBlock lower, or an archive rpc` } : {}), collectors: list.filter((e) => !e.isOwner).length, ownerMints: list.find((e) => e.isOwner)?.count ?? 0,
    firstMint: t0 ? new Date(t0 * 1000).toISOString() : null, lastMint: t1 ? new Date(t1 * 1000).toISOString() : null,
    byCollector: list.map(({ address, ens, count, tokens, rare, isOwner }) => ({ address, ens: ens ?? null, count, tokens, ...(rare.length ? { rare } : {}), ...(isOwner ? { note: 'collection owner (reserves)' } : {}) })),
    traitCounts: dist,
    mints: mints.map(({ tokenId, to, block, tx, traits: t }) => ({ tokenId, to, block, tx, ...(t ? { traits: t } : {}) })),
    note: 'minters = who received each mint (Transfer from 0x0), not current holders. names = ens reverse records that resolve back (checked on ethereum).',
  };
}

// ---------- wave_status ----------
export async function waveStatus({ contract, chain = 'base', breakHours, rpc }) {
  const [b, sale] = await Promise.all([basics(chain, contract, rpc), saleOf(chain, contract, rpc)]);
  const urls = rpc ? [rpc] : LOG_RPCS[chain];
  const end = await blockNumber(chain, rpc);
  const now = Math.floor(Date.now() / 1000);
  const tEnd = await blockTime(chain, end, rpc), tBack = await blockTime(chain, Math.max(0, end - 5000), rpc);
  const perBlock = Math.max(0.1, (tEnd - tBack) / 5000), day = Math.ceil(86400 / perBlock);
  const sNow = await supplyAt(chain, contract, end, urls);
  let mints24 = null, lastBlock = null;
  try {
    mints24 = sNow - await supplyAt(chain, contract, Math.max(0, end - day), urls);
    let lo = 0, hi = end;                       // last mint = first block where supply already equals today's
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if ((await supplyAt(chain, contract, mid, urls)) >= sNow) hi = mid; else lo = mid + 1; }
    lastBlock = sNow ? lo : null;
  } catch {                                      // no archive state: read the last day of logs instead
    const recent = await getLogs(chain, { address: contract, topics: MINT_TOPICS }, Math.max(0, end - day), end, rpc);
    mints24 = recent.length; lastBlock = recent.length ? Number(BigInt(recent.at(-1).blockNumber)) : null;
  }
  const lastAt = lastBlock != null ? await blockTime(chain, lastBlock, rpc) : null;
  const soldOut = sale.configured && sale.sold >= sale.allocation;
  const out = {
    contract, chain, collection: b.name, paused: b.paused,
    supply: { minted: b.supply, max: b.max, left: b.max != null ? b.max - b.supply : null },
    sale: sale.configured ? { priceEth: eth(sale.priceWei), allocation: sale.allocation, sold: sale.sold, leftInWave: Math.max(0, sale.allocation - sale.sold), soldOut } : { configured: false },
    mintsLast24h: mints24,
    lastMintAt: lastAt ? new Date(lastAt * 1000).toISOString() : null,
  };
  if (soldOut && lastAt) {
    out.soldOutAt = out.lastMintAt;
    if (breakHours != null) { const next = lastAt + breakHours * 3600; out.nextWaveFrom = new Date(next * 1000).toISOString(); out.nextWaveIn = next > now ? `${((next - now) / 3600).toFixed(1)} h` : 'now'; }
  }
  out.notes = [
    ...(b.paused ? ['minting is paused'] : []),
    ...(soldOut ? ['wave allocation used up .. the owner opens the next one by raising the allocation on the minter (abx configure the sale again)'] : []),
    ...(!soldOut && sale.configured && mints24 === 0 ? ['no mints in the last 24 h'] : []),
  ];
  return out;
}

// ---------- export_token ----------
export async function exportToken({ contract, tokenId, chain = 'base', width = 4096, outDir, chromePath, timeoutSec = 120, rpc }) {
  const tmp = mkdtempSync(join(tmpdir(), 'abx-export-'));
  const out = resolve(outDir ?? '.'); mkdirSync(out, { recursive: true });
  const rb = await rebuildToken({ contract, tokenId, chain, rpc, outDir: tmp });
  const browser = await launchBrowser(chromePath);
  try {
    const W = Math.max(256, Math.min(8192, width));
    const page = await browser.newPage({ viewport: { width: W, height: W } });
    await page.goto(pathToFileURL(rb.file).href + `?w=${W}`);
    try { await page.waitForFunction(() => window.abx && window.abx.__done, null, { timeout: timeoutSec * 1000, polling: 200 }); } catch {}
    const r = await page.evaluate(async () => {
      const cs = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height);
      if (!cs[0]) return null;
      const blob = await new Promise((res) => cs[0].toBlob(res, 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { w: cs[0].width, h: cs[0].height, b64: btoa(s) };
    });
    const file = join(out, `${contract.slice(0, 8).toLowerCase()}_${tokenId}_${W}.png`);
    let method;
    if (r && r.w >= W * 0.9) { writeFileSync(file, Buffer.from(r.b64, 'base64')); method = `canvas pixels (${r.w}x${r.h})`; }
    else { await page.screenshot({ path: file }); method = `screenshot of a ${W}px viewport (the canvas is ${r ? r.w + 'x' + r.h : 'missing'}, so the piece doesn't scale to the window)`; }
    await page.close();
    return { file, width: W, method, fromChainAlone: rb.fullyFromChain, codeSha256: rb.codeSha256, seed: rb.seed,
      note: 'rebuilt from chain data (rebuild_token), then rendered locally. pieces that size to the window or read ?w= export at full size; fixed-size canvases are upscaled by the screenshot.' };
  } finally { await browser.close(); rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- marketplace_check ----------
export async function marketplaceCheck({ contract, tokenIds, chain = 'base', openseaKey, refresh = false, rpc }) {
  const key = openseaKey ?? process.env.OPENSEA_API_KEY ?? null, slug = OPENSEA_SLUG[chain];
  const ids = (tokenIds?.length ? tokenIds : [0]).slice(0, 30);
  const rows = await pool(ids, 4, async (id) => {
    const meta = await tokenMeta(chain, contract, id, rpc);
    const row = { tokenId: id, metadata: !!meta, image: meta?.image ?? null, traits: traitsOf(meta) };
    if (meta?.image && /^https?:/.test(meta.image)) { try { const r = await fetch(meta.image, { method: 'GET', headers: { 'user-agent': 'abx-artist-kit', range: 'bytes=0-15' } }); row.imageStatus = r.status; } catch (e) { row.imageStatus = 'unreachable'; } }
    row.openseaUrl = slug ? `https://opensea.io/item/${slug}/${contract.toLowerCase()}/${id}` : null;
    if (!slug) { row.opensea = 'opensea does not list this chain (as far as this kit knows)'; return row; }
    if (!key) { row.opensea = 'no OPENSEA_API_KEY .. open the link and compare, use "refresh metadata" there if the image or traits are missing'; return row; }
    try {
      const j = await (await fetch(`https://api.opensea.io/api/v2/chain/${slug}/contract/${contract}/nfts/${id}`, { headers: { 'x-api-key': key, 'user-agent': 'abx-artist-kit' } })).json();
      const n = j.nft ?? {};
      const os = Object.fromEntries((n.traits ?? []).map((t) => [t.trait_type, t.value]));
      const missing = Object.keys(row.traits).filter((k) => !(k in os)), differ = Object.keys(row.traits).filter((k) => k in os && String(os[k]) !== String(row.traits[k]));
      const placeholder = !(n.traits ?? []).length || !(n.display_image_url || n.image_url);
      row.opensea = { found: !!j.nft, traitsMatch: !missing.length && !differ.length, missing, differ, image: n.display_image_url ?? n.image_url ?? null, placeholder };
      if ((placeholder || missing.length || differ.length) && refresh) {
        const r = await fetch(`https://api.opensea.io/api/v2/chain/${slug}/contract/${contract}/nfts/${id}/refresh`, { method: 'POST', headers: { 'x-api-key': key, 'user-agent': 'abx-artist-kit' } });
        row.opensea.refreshRequested = r.ok;
      }
    } catch (e) { row.opensea = `opensea read failed: ${e.message.slice(0, 80)}`; }
    return row;
  });
  const stale = rows.filter((r) => r.opensea && typeof r.opensea === 'object' && (r.opensea.placeholder || !r.opensea.traitsMatch)).map((r) => r.tokenId);
  return { contract, chain, checked: rows.length, staleOnOpensea: stale, tokens: rows,
    note: 'source of truth = the contract\'s tokenURI (what abx serves). opensea caches; a placeholder right after mint is normal for a while (lesson: opensea-placeholder-cache). refresh only runs when you pass refresh: true.' };
}
