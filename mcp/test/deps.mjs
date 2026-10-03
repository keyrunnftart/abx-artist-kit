// p5 from Art Blocks' on-chain registry on Ethereum: good sketch passes, unseeded sketch is caught
import { renderCheck, lintScript } from '../src/tools.mjs';
import { listLibraries } from '../src/deps.mjs';
const libs = await listLibraries();
console.log('on-chain:', libs.libraries.filter((l) => l.onchain).map((l) => l.name).join(' '));
console.log('cdn only:', libs.libraries.filter((l) => !l.onchain).map((l) => l.name).join(' '));
console.log('lint p5_good:', lintScript({ path: 'test/fixtures/p5_good.js' }).findings.map((f) => f.level + ' ' + f.msg).join(' | '));
for (const [f, dep] of [['p5_good', 'p5@1.0.0'], ['p5_good', 'p5@1.9.0'], ['p5_unseeded', 'p5@1.0.0']]) {
  const r = await renderCheck({ path: `test/fixtures/${f}.js`, seeds: 4, dependencies: [dep] });
  console.log(`\n${f} + ${dep}: ok=${r.ok} deterministic=${r.deterministic} ms=${r.timeMs.max} canvas=${r.canvas} random=${r.nondeterminismProbe.random}`);
  for (const x of r.findings) console.log('  ', x.level, x.msg);
}
