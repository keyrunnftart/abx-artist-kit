// nothing here moves .. rebuild any token from Base alone.
//
//   node rebuild.mjs 2            -> writes nhm_2.html, open it in any browser
//   node rebuild.mjs 2 --rpc URL  -> use your own Base RPC
//
// No dependencies, no ABX, no keyrun servers. Node 18+.
// Reads the artist code (script chunks) and the token's mint seed straight from the
// contract with eth_call, then wraps them exactly the way ABX's generator does.

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CONTRACT = '0xB13971551bd3C14A0F793571347dDCdfB08902ba'; // nothing here moves (Base, chain 8453)
const CHAIN_ID = 8453;

const args = process.argv.slice(2);
const tokenId = BigInt(args.find((a) => /^\d+$/.test(a)) ?? '0');
const rpcAt = args.indexOf('--rpc');
const RPCS = rpcAt >= 0 ? [args[rpcAt + 1]] : ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'];

// function selectors (first 4 bytes of keccak256 of the signature)
const SEL = {
  scriptChunkCount: '0x92d9906f', // scriptChunkCount()
  scriptChunk: '0x6aaf7607',      // scriptChunk(uint256) -> bytes
  scriptLocked: '0x7d0b7ae4',     // scriptLocked() -> bool
  tokenParam: '0x6bd39222',       // tokenParam(uint256,bytes32) -> (bytes32 value, bool valueIsHash, bool isSet)
  tokenParamKeys: '0xe1b79381',   // tokenParamKeys(uint256) -> bytes32[]
  contractParamKeys: '0x55580cca',// contractParamKeys() -> bytes32[]
};

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const key32 = (s) => Buffer.from(s).toString('hex').padEnd(64, '0');
const words = (hex) => hex.replace(/^0x/, '').match(/.{64}/g) ?? [];

async function call(data) {
  let last;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: CONTRACT, data }, 'latest'] }),
      });
      const j = await res.json();
      if (j.result) return j.result;
      last = JSON.stringify(j.error ?? j);
    } catch (e) { last = e.message; }
  }
  throw new Error(`eth_call failed on every RPC: ${last}`);
}

function decodeBytes(hex) {
  const h = hex.replace(/^0x/, '');
  const off = Number(BigInt('0x' + h.slice(0, 64))) * 2;
  const len = Number(BigInt('0x' + h.slice(off, off + 64)));
  return Buffer.from(h.slice(off + 64, off + 64 + len * 2), 'hex');
}

function decodeKeys(hex) {
  const w = words(hex);
  const n = Number(BigInt('0x' + w[1]));
  return w.slice(2, 2 + n).map((k) => Buffer.from(k, 'hex').toString().replace(/\0+$/, ''));
}

// 1. the artist code, stored on-chain in chunks
const count = Number(BigInt(await call(SEL.scriptChunkCount)));
const chunks = [];
for (let i = 0; i < count; i++) chunks.push(decodeBytes(await call(SEL.scriptChunk + word(i))));
const script = chunks.map((c) => c.toString('utf8')).join('\n'); // ABX joins chunks with a newline
const locked = BigInt(await call(SEL.scriptLocked)) === 1n;

// 2. the token's seed, written on-chain at mint
const [seedWord, isHash, isSet] = words(await call(SEL.tokenParam + word(tokenId) + key32('seed')));
if (BigInt('0x' + isSet) !== 1n) throw new Error(`token #${tokenId} has no seed .. not minted?`);
if (BigInt('0x' + isHash) !== 0n) throw new Error('seed is stored as a hash, not a literal');
const seed = '0x' + seedWord;

// 3. anything else the program could be fed (expected: only the seed)
const tokenKeys = decodeKeys(await call(SEL.tokenParamKeys + word(tokenId)));
const contractKeys = decodeKeys(await call(SEL.contractParamKeys));
const extra = [...tokenKeys.filter((k) => k !== 'seed'), ...contractKeys];

// 4. assemble the page, same shape as ABX's buildGeneratorDocument
const tokenData = JSON.stringify({ chainId: CHAIN_ID, contractAddress: CONTRACT.toLowerCase(), seed, tokenId: tokenId.toString() });
const ABX_JS = `(function(){var abx=(window.abx=window.abx||{});abx.tokenData=window.abxTokenData;
abx.traits=function(t){abx.__traits=t;console.log('traits',JSON.stringify(t));return t};
abx.done=function(){abx.__done=true;document.title='done';}})();`;
const html = [
  '<!doctype html>',
  '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  `<title>nothing here moves #${tokenId}</title>`,
  '<style>html,body{margin:0;padding:0;overflow:hidden}canvas{display:block}</style>',
  `<script>window.abxTokenData=${tokenData.replace(/</g, '\\u003c')};</script>`,
  `<script>${ABX_JS}</script>`,
  '</head><body>',
  `<script>\n${script.replace(/<\/(script)/gi, '<\\/$1')}\n</script>`,
  '</body></html>',
].join('\n');

const out = `nhm_${tokenId}.html`;
writeFileSync(out, html);

const urls = script.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
console.log(`nothing here moves #${tokenId} .. rebuilt from Base ${CONTRACT}`);
console.log(`  code   ${script.length.toLocaleString()} bytes in ${count} on-chain chunk(s), locked: ${locked}`);
console.log(`  sha256 ${createHash('sha256').update(script).digest('hex')}`);
console.log(`  seed   ${seed}`);
console.log(`  inputs ${extra.length ? 'ALSO ' + extra.join(', ') : 'seed only'} · libraries: none · external urls: ${urls.length}`);
console.log(`  -> ${out} (open in a browser; traits print to the console)`);
