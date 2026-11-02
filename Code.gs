/**
 * 회의 조율 보드 — Apps Script 서버
 * - 구글시트에 붙은(컨테이너 바인딩) 스크립트로 만든다.
 * - 모든 활동(일정 응답, 장소 제안, 투표, 안건, 채팅, 요약)을 'events' 시트에 한 줄씩 쌓는 방식.
 * - (선택) 스크립트 속성에 ANTHROPIC_API_KEY 를 넣으면 화면의 'AI 요약' 버튼이 바로 동작한다.
 */

const SHEET_NAME = 'events';
const HEADER = ['room', 'type', 'uid', 'nick', 'payload', 'ts', 'cid'];
const TYPES = ['room', 'avail', 'place', 'agenda', 'vote', 'del', 'chat', 'summary'];
const MAX_PAYLOAD = 12000;
const DAILY_SUMMARY_CAP = 150;   // 하루 자동·수동 요약 최대 횟수(API 비용 보호)

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName(SHEET_NAME);
  if (!s) {
    s = ss.insertSheet(SHEET_NAME);
    s.appendRow(HEADER);
    s.setFrozenRows(1);
  }
  return s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function hasKey_() {
  return !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'pull') return json_(pull_(String(p.room || ''), Number(p.since) || 1, clean_(p.uid, 40)));
  return json_({ ok: true, hello: 'meeting-board' });
}

function salt_() {
  const props = PropertiesService.getScriptProperties();
  let v = props.getProperty('SALT');
  if (!v) { v = Utilities.getUuid(); props.setProperty('SALT', v); }
  return v;
}

// 익명으로 보여줘야 하는 기록: 장소 제안, 모든 투표, 장소 삭제
function isAnon_(type, payload) {
  return type === 'place' || type === 'vote' || (type === 'del' && String(payload.target || '').charAt(0) === 'p');
}

function anonId_(room, uid, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + room + '|' + uid);
  return 'x' + bytes.slice(0, 6).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function pull_(room, since, viewer) {
  const s = sheet_();
  const last = s.getLastRow();
  const out = { ok: true, last: last, ai: hasKey_(), rows: [] };
  if (!room || last <= since) return out;
  const salt = salt_();
  const vals = s.getRange(since + 1, 1, last - since, HEADER.length).getValues();
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    if (r[0] !== room) continue;
    let payload = {};
    try { payload = JSON.parse(r[4]); } catch (err) {}
    const row = { n: since + 1 + i, type: r[1], uid: r[2], nick: r[3], payload: payload, ts: r[5], cid: r[6] };
    if (isAnon_(r[1], payload)) {
      // 이름은 지우고, 사람 구분용 가명 ID만 내려보낸다. 본인 기록은 mine 표시.
      row.mine = !!viewer && r[2] === viewer;
      row.uid = row.mine ? r[2] : anonId_(room, r[2], salt);
      row.nick = '';
    }
    out.rows.push(row);
  }
  return out;
}

function clean_(str, max) {
  // 시트에서 수식으로 해석되지 않도록 앞의 = + - @ 제거
  return String(str == null ? '' : str).slice(0, max).replace(/^[=+\-@\s]+/, '');
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  if (body.action === 'add') return json_(add_(body));
  if (body.action === 'summarize') return json_(summarize_(body));
  return json_({ ok: false, error: 'unknown_action' });
}

function add_(b) {
  const room = String(b.room || '');
  if (!/^[A-Za-z0-9]{4,40}$/.test(room)) return { ok: false, error: 'bad_room' };
  if (TYPES.indexOf(b.type) < 0) return { ok: false, error: 'bad_type' };
  const payload = JSON.stringify(b.payload || {});
  if (payload.length > MAX_PAYLOAD) return { ok: false, error: 'too_long' };
  const cid = clean_(b.cid, 40);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const s = sheet_();
    const last = s.getLastRow();
    // 재전송으로 인한 중복 방지: 최근 300줄의 cid 확인
    if (cid && last > 1) {
      const from = Math.max(2, last - 299);
      const cids = s.getRange(from, 7, last - from + 1, 1).getValues();
      for (let i = 0; i < cids.length; i++) if (cids[i][0] === cid) return { ok: true, n: from + i, dup: true };
    }
    s.appendRow([room, b.type, clean_(b.uid, 40), clean_(b.nick, 20), payload, Date.now(), cid]);
    return { ok: true, n: s.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}

function summarize_(b) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return { ok: false, error: 'no_key' };
  const room = String(b.room || '');
  if (!/^[A-Za-z0-9]{4,40}$/.test(room)) return { ok: false, error: 'bad_room' };
  const cache = CacheService.getScriptCache();
  if (cache.get('sum_' + room)) return { ok: false, error: 'too_fast' };
  cache.put('sum_' + room, '1', 120);

  const props = PropertiesService.getScriptProperties();
  const dayKey = 'cnt_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  const used = Number(props.getProperty(dayKey) || 0);
  if (used >= DAILY_SUMMARY_CAP) return { ok: false, error: 'daily_cap' };
  props.setProperty(dayKey, String(used + 1));

  const text = String(b.text || '').slice(0, 30000);
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: 2500,
      messages: [{ role: 'user', content: String(b.prompt || '').slice(0, 4000) + '\n\n' + text }]
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'api_' + res.getResponseCode() };
  const data = JSON.parse(res.getContentText());
  const out = (data.content || []).map(function (c) { return c.text || ''; }).join('').trim();
  if (!out) return { ok: false, error: 'empty' };
  add_({ room: room, type: 'summary', uid: b.uid, nick: b.nick, payload: { text: out }, cid: clean_(b.cid, 40) });
  return { ok: true };
}
