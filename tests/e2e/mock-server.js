const http = require('http');
const path = require('path');
const { makeEnv } = require('../gas-harness');
const env = makeEnv(path.join(__dirname, '..', '..', 'Code.gs'));
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const send = o => { res.setHeader('Content-Type', 'application/json'); res.end(o.text); };
  const delay = fn => setTimeout(fn, 120);   // Apps Script 지연 흉내
  if (req.method === 'GET') {
    const u = new URL(req.url, 'http://x'); const p = Object.fromEntries(u.searchParams);
    return delay(() => send(env.ctx.doGet ? require('vm').runInContext('doGet', env.ctx)({ parameter: p }) : { text: '{}' }));
  }
  let body = ''; req.on('data', c => body += c);
  req.on('end', () => delay(() => send(require('vm').runInContext('doPost', env.ctx)({ postData: { contents: body } }))));
}).listen(8790, () => console.log('mock GAS on 8790'));
