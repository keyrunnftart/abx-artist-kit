// read-only chain access for ABX SeriesCode contracts .. plain eth_call, no keys, no ABX servers.

export const CHAINS = {
  base: { id: 8453, rpcs: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'], explorer: 'https://basescan.org' },
  'base-sepolia': { id: 84532, rpcs: ['https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'], explorer: 'https://sepolia.basescan.org' },
};

// selectors from the ABX SDK seriesCodeAbi (CLI 0.2.0)
export const SEL = {
  name: '0x06fdde03', symbol: '0x95d89b41', owner: '0x8da5cb5b', paused: '0x5c975abb',
  totalSupply: '0x18160ddd', maxInvocations: '0x6cbdef61', minter: '0x07546172', primaryPayee: '0xd8b4f8ac',
  getTransferValidator: '0x098144d4', royaltyInfo: '0x2a55205a', maxRoyaltyBps: '0xb18f004a',
  scriptChunkCount: '0x92d9906f', scriptChunk: '0x6aaf7607', scriptLocked: '0x7d0b7ae4',
  dependencyCount: '0xd90f5df2', dependenciesLocked: '0xea58f971',
  paramHooks: '0x3c59f1bb', paramHooksLocked: '0x6c59f759',
  tokenURIBase: '0x261220a3', tokenURILocked: '0xac998f45', tokenURIRenderer: '0xd50bac33',
  contractParamKeys: '0x55580cca', tokenParamKeys: '0xe1b79381', tokenParam: '0x6bd39222',
  tokenURI: '0xc87b56dd', minterSales: '0xc6b9f06a',
};

export const word = (n) => BigInt(n).toString(16).padStart(64, '0');
export const key32 = (s) => Buffer.from(s).toString('hex').padEnd(64, '0');
export const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const words = (hex) => hex.replace(/^0x/, '').match(/.{64}/g) ?? [];
export const asAddr = (w) => '0x' + w.slice(24);
export const asUint = (w) => BigInt('0x' + w);
export const asBool = (w) => BigInt('0x' + w) === 1n;
export const ZERO = '0x0000000000000000000000000000000000000000';

export function chainOf(name = 'base') {
  const c = CHAINS[name];
  if (!c) throw new Error(`unknown chain "${name}" .. use one of ${Object.keys(CHAINS).join(', ')}`);
  return c;
}

export async function ethCall(chain, to, data, rpc) {
  const urls = rpc ? [rpc] : chainOf(chain).rpcs;
  let last;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'abx-artist-kit' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      });
      const j = await res.json();
      if (j.result !== undefined) return j.result;
      last = j.error?.message ?? JSON.stringify(j);
      if (/revert/i.test(last)) throw Object.assign(new Error(last), { revert: true });
    } catch (e) {
      if (e.revert) throw e;
      last = e.message;
    }
  }
  throw new Error(`eth_call failed on every RPC: ${last}`);
}

// returns null instead of throwing when the function reverts or doesn't exist
export async function tryCall(chain, to, data, rpc) {
  try {
    const r = await ethCall(chain, to, data, rpc);
    return r === '0x' ? null : r;
  } catch (e) {
    if (e.revert) return null;
    throw e;
  }
}

export function decodeBytes(hex) {
  const h = hex.replace(/^0x/, '');
  const off = Number(BigInt('0x' + h.slice(0, 64))) * 2;
  const len = Number(BigInt('0x' + h.slice(off, off + 64)));
  return Buffer.from(h.slice(off + 64, off + 64 + len * 2), 'hex');
}
export const decodeString = (hex) => decodeBytes(hex).toString('utf8');

export function decodeKeys(hex) {
  const w = words(hex);
  const n = Number(asUint(w[1]));
  return w.slice(2, 2 + n).map((k) => Buffer.from(k, 'hex').toString().replace(/\0+$/, ''));
}

export async function readScript(chain, contract, rpc) {
  const count = Number(asUint(words(await ethCall(chain, contract, SEL.scriptChunkCount, rpc))[0]));
  const chunks = [];
  for (let i = 0; i < count; i++) chunks.push(decodeBytes(await ethCall(chain, contract, SEL.scriptChunk + word(i), rpc)));
  return { count, script: chunks.map((c) => c.toString('utf8')).join('\n') }; // ABX joins chunks with a newline
}

export async function readSeed(chain, contract, tokenId, rpc) {
  const [value, isHash, isSet] = words(await ethCall(chain, contract, SEL.tokenParam + word(tokenId) + key32('seed'), rpc));
  if (!asBool(isSet)) return null;
  return { seed: '0x' + value, isHash: asBool(isHash) };
}
