// libraries (p5, three, ...) for ABX code projects.
// ABX resolves a dependency two ways (CLI 0.2.0 - 0.4.2):
//   onchain  .. a data contract address; the library is that contract's bytecode (minus the leading STOP byte)
//   registry .. a name@version looked up in Art Blocks' DependencyRegistryV0. ABX only knows that registry
//               on Ethereum and Sepolia, so on Base its resolver falls back to a CDN (jsdelivr).
// We go further: a registry library that is stored on-chain on Ethereum is pulled from there, so a Base
// project using p5@1.0.0 can still be rebuilt from chain data alone (two chains, no CDN).

import { gunzipSync } from 'node:zlib';
import {
  AB_DEPENDENCY_REGISTRY, getCode, ethCall, words, asUint, decodeString, word, registryDetails, registryScript,
} from './chain.mjs';

const ETH_REGISTRY = AB_DEPENDENCY_REGISTRY[1];
const cache = new Map();

// the same fallback map ABX's resolver uses when nothing on-chain answers
export function cdnUrl(nameAtVersion) {
  const at = nameAtVersion.lastIndexOf('@');
  if (at <= 0) return null;
  const name = nameAtVersion.slice(0, at), v = nameAtVersion.slice(at + 1);
  const known = {
    p5js: `https://cdn.jsdelivr.net/npm/p5@${v}/lib/p5.min.js`, p5: `https://cdn.jsdelivr.net/npm/p5@${v}/lib/p5.min.js`,
    threejs: `https://cdn.jsdelivr.net/npm/three@${v}/build/three.min.js`, three: `https://cdn.jsdelivr.net/npm/three@${v}/build/three.min.js`,
    tonejs: `https://cdn.jsdelivr.net/npm/tone@${v}/build/Tone.js`,
  };
  return known[name] ?? `https://cdn.jsdelivr.net/npm/${name}@${v}`;
}

const inline = (src) => `<script>${src.replace(/<\/(script)/gi, '<\\/$1')}</script>`;

// dep: "p5@1.0.0" | "0x…" (data contract) | { resolution, name } from readDependencies
export async function resolveDependency(dep, { chain = 'base', registry, rpc } = {}) {
  const name = typeof dep === 'string' ? dep.trim() : dep.name;
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(name);
  const key = `${chain}|${registry ?? ''}|${name}`;
  if (cache.has(key)) return cache.get(key);
  let out;

  if (isAddr) {
    const code = await getCode(chain, name, rpc);
    if (code && code.length > 4) {
      out = { name, onchain: true, source: `${chain} data contract ${name}`, tag: inline(Buffer.from(code.slice(4), 'hex').toString('utf8')) };
    } else {
      out = { name, onchain: false, source: 'missing', tag: '', note: `no bytecode at ${name} on ${chain}` };
    }
  } else {
    // 1. the project's own registry, when it exists on the same chain
    const tries = [];
    if (registry && !/^0x0{40}$/i.test(registry)) {
      const code = await getCode(chain, registry, rpc).catch(() => '0x');
      if (code && code.length > 2) tries.push({ chain, address: registry, label: `${chain} registry ${registry}` });
    }
    // 2. Art Blocks' registry on Ethereum
    tries.push({ chain: 'ethereum', address: ETH_REGISTRY, label: 'Art Blocks registry on Ethereum' });
    let cdn = null;
    for (const t of tries) {
      const d = await registryDetails(t.chain, t.address, name).catch(() => null);
      if (!d) continue;
      if (d.availableOnChain && d.scriptCount > 0) {
        const b64 = await registryScript(t.chain, t.address, name, d.scriptCount);
        const src = gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
        out = { name, onchain: true, source: t.label, bytes: Buffer.byteLength(src), license: d.license || null, tag: inline(src) };
        break;
      }
      if (d.cdn && !cdn) cdn = d.cdn;
    }
    if (!out) {
      const url = cdn ?? cdnUrl(name);
      out = url
        ? { name, onchain: false, source: `CDN ${url}`, tag: `<script src="${url}"></script>`, note: 'not stored on-chain anywhere we can read .. this part of the piece depends on a CDN' }
        : { name, onchain: false, source: 'missing', tag: '', note: 'unknown library' };
    }
  }
  cache.set(key, out);
  return out;
}

// what Art Blocks' registry holds, and which entries are fully on-chain
export async function listLibraries() {
  const n = await ethCall('ethereum', ETH_REGISTRY, '0x44346a5f'); // getDependencyCount()
  const count = Number(asUint(words(n)[0]));
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = decodeString(await ethCall('ethereum', ETH_REGISTRY, '0xb1d24cb2' + word(i))); // getDependencyNameAndVersion(i)
    const d = await registryDetails('ethereum', ETH_REGISTRY, name).catch(() => null);
    out.push({ name, onchain: !!(d?.availableOnChain && d.scriptCount > 0), cdn: d?.cdn || null, license: d?.license || null });
  }
  return {
    registry: `${ETH_REGISTRY} (Ethereum)`,
    libraries: out,
    note: "ABX reads this registry on Ethereum/Sepolia only, so on ethereum a name@version library is served from chain. On Base, Arbitrum and Robinhood, ABX's live view loads a name@version library from a CDN; rebuild_token still pulls the on-chain copy from Ethereum when one exists. For an on-chain library on those chains, deploy it as a data contract and add it by address.",
  };
}
