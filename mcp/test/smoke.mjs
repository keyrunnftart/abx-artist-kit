// quick end-to-end run of every tool against real contracts (read-only)
import { tmpdir } from 'node:os';
import { rebuildToken, inspectContract, lintScript, preflight, lessons } from '../src/tools.mjs';

const NHM = '0xB13971551bd3C14A0F793571347dDCdfB08902ba';
const show = (label, x) => console.log(`\n== ${label}\n` + JSON.stringify(x, null, 1).slice(0, 2500));

show('inspect base NHM', await inspectContract({ contract: NHM }));
show('inspect sepolia rehearsal', await inspectContract({ contract: '0xf6AA7fbE0BEE0A72826F4460f4DC6B75CF182B3D', chain: 'base-sepolia' }));
show('rebuild #2', await rebuildToken({ contract: NHM, tokenId: 2, outDir: tmpdir() }));
show('lint bad script', lintScript({ source: 'import x from "y";\nconst r = Math.random();\nfetch("https://cdn.example.com/p5.js");\ncreateCanvas(400,400);' }));
show('preflight risky plan', preflight({ commands: [
  'ABX_CHAIN=base npx abx deploy-code --script a.js --721c recommended --onchain-uri --sponsor',
  'ABX_CHAIN=base npx abx attach 0x1 image "ar://x/logo.jpg" --collection --sponsor',
].join('\n') }));
show('lessons', await lessons({ topic: 'deploy' }));
