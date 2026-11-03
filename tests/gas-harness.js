// Apps Script 모의 환경: Code.gs 를 그대로 불러와서 시트·캐시·잠금을 메모리로 흉내낸다.
const vm = require('vm');
const fs = require('fs');
const crypto = require('crypto');

function makeEnv(codePath, opts = {}) {
  const book = {};
  const props = {};
  const cache = {};
  class Sheet {
    constructor(name) { this.name = name; this.rows = []; }
    getLastRow() {
      let l = this.rows.length;
      while (l > 0 && (!this.rows[l - 1] || this.rows[l - 1].every(c => c === '' || c == null))) l--;
      return l;
    }
    appendRow(a) { const l = this.getLastRow(); this.rows[l] = a.slice(); }
    setFrozenRows() {}
    getRange(r, c, nr = 1, nc = 1) {
      const self = this;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = self.rows[r - 1 + i] || [];
            const o = [];
            for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; o.push(v == null ? '' : v); }
            out.push(o);
          }
          return out;
        },
        setValue(v) { const row = (self.rows[r - 1] ||= []); row[c - 1] = v; }
      };
    }
  }
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheetByName: n => book[n] || null,
      insertSheet: n => (book[n] = new Sheet(n))
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); }
    }) },
    CacheService: { getScriptCache: () => ({
      get: k => { const e = cache[k]; if (!e) return null; if (e.exp < Date.now()) { delete cache[k]; return null; } return e.v; },
      put: (k, v, s = 600) => { cache[k] = { v: String(v), exp: Date.now() + s * 1000 }; },
      remove: k => { delete cache[k]; }
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      formatDate: () => '20261102'
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: s => ({ text: s, setMimeType() { return this; } })
    },
    UrlFetchApp: { fetch: opts.fetch || (() => { throw new Error('no network'); }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx);
  const get = p => JSON.parse(vm.runInContext('doGet', ctx)({ parameter: p }).text);
  const post = b => JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify(b) } }).text);
  return { ctx, book, props, cache, get, post };
}
module.exports = { makeEnv };
