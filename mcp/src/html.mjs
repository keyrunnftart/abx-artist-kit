// wraps artist code + token data the same way ABX's buildGeneratorDocument does (CLI 0.2.0),
// plus a tiny shim that records traits/done so a headless browser can read them back.

const ABX_JS = `(function(){var abx=(window.abx=window.abx||{});abx.tokenData=window.abxTokenData;
abx.__traits=null;abx.__done=false;
abx.traits=function(t){abx.__traits=t;try{document.dispatchEvent(new CustomEvent('abx:traits',{detail:t}))}catch(e){}return t};
abx.done=function(){abx.__done=true;abx.__doneAt=performance.now();try{document.dispatchEvent(new CustomEvent('abx:done'))}catch(e){}}})();`;

// counts nondeterministic calls during a render (render_check only)
export const PROBE_JS = `(function(){var p=(window.__probe={random:0,dateNow:0,perfNow:0,fetch:0});
var r=Math.random;Math.random=function(){p.random++;return r.call(Math)};
var d=Date.now;Date.now=function(){p.dateNow++;return d.call(Date)};
if(window.fetch){var f=window.fetch;window.fetch=function(){p.fetch++;return f.apply(window,arguments)}}})();`;

export function tokenDataJson({ chainId, contract, tokenId, seed }) {
  const data = { chainId, contractAddress: contract.toLowerCase(), seed, tokenId: String(tokenId) };
  const sorted = {};
  for (const k of Object.keys(data).sort()) sorted[k] = data[k];
  return JSON.stringify(sorted);
}

export function buildDocument(script, tokenData, { title = 'abx token', probe = false } = {}) {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${title.replace(/</g, '')}</title>`,
    '<style>html,body{margin:0;padding:0;overflow:hidden}canvas{display:block}</style>',
    probe ? `<script>${PROBE_JS}</script>` : '',
    `<script>window.abxTokenData=${tokenData.replace(/</g, '\\u003c')};</script>`,
    `<script>${ABX_JS}</script>`,
    '</head><body>',
    `<script>\n${script.replace(/<\/(script)/gi, '<\\/$1')}\n</script>`,
    '</body></html>',
  ].join('\n');
}
