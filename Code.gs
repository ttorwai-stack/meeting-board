/**
 * 회의 조율 보드 — Apps Script 서버
 * - 구글시트에 붙은(컨테이너 바인딩) 스크립트로 만든다.
 * - 'events' 탭: 모든 활동(일정 응답, 장소 제안, 투표, 안건, 채팅, 요약)을 한 줄씩 쌓는다.
 * - 'members' 탭: 방별 참가자(대화명, 비밀번호 해시, 신원 ID, 토큰, 제외 여부). 직접 고치지 말 것.
 * - (선택) 스크립트 속성 ANTHROPIC_API_KEY 를 넣으면 자동 요약이 켜진다.
 *
 * 보안 요약
 * - 비밀번호는 솔트+SHA-256 해시로만 저장한다(원문 저장 안 함). 5회 틀리면 10분 잠금.
 * - 로그인하면 토큰을 받고, 글쓰기·읽기(내 기록 표시)·관리 기능은 토큰으로 검증한다.
 * - 방장 = 방을 만든 사람. 내보내기·요약 올리기·참가자 목록은 방장 토큰만 가능.
 */

const EVENTS = 'events';
const MEMBERS = 'members';
const E_HEADER = ['room', 'type', 'uid', 'nick', 'payload', 'ts', 'cid'];
const M_HEADER = ['room', 'key', 'nick', 'hash', 'uid', 'token', 'kicked', 'ts'];
const TYPES = ['room', 'roomedit', 'avail', 'place', 'agenda', 'vote', 'del', 'chat', 'summary'];
const MAX_PAYLOAD = 12000;
const DAILY_SUMMARY_CAP = 150;   // 하루 요약 최대 횟수(API 비용 보호)
const MAX_MEMBERS = 5000;
const MAX_BAD = 5;               // 비밀번호 연속 오류 허용 횟수
const LOCK_SEC = 600;            // 초과 시 잠금 시간(초)

/* ---------- 공통 ---------- */

function sheet_(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    s.appendRow(header);
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

function roomOk_(room) {
  return /^[A-Za-z0-9]{4,40}$/.test(String(room || ''));
}

function clean_(str, max) {
  // 시트에서 수식으로 해석되지 않도록 앞의 = + - @ 제거
  return String(str == null ? '' : str).slice(0, max).replace(/^[=+\-@\s]+/, '');
}

function norm_(nick) {
  return String(nick == null ? '' : nick).trim().replace(/\s+/g, ' ').toLowerCase();
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function sha_(text) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text));
}

function salt_() {
  const props = PropertiesService.getScriptProperties();
  let v = props.getProperty('SALT');
  if (!v) { v = Utilities.getUuid(); props.setProperty('SALT', v); }
  return v;
}

/* ---------- 참가자(members) ---------- */

function readMembers_() {
  const s = sheet_(MEMBERS, M_HEADER);
  const last = s.getLastRow();
  if (last < 2) return [];
  const v = s.getRange(2, 1, last - 1, M_HEADER.length).getValues();
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const r = v[i];
    if (!r[0]) continue;
    out.push({ row: i + 2, room: r[0], key: r[1], nick: r[2], hash: r[3], uid: r[4], token: r[5], kicked: Number(r[6]) === 1 });
  }
  return out;
}

function authList_(room) {
  const cache = CacheService.getScriptCache();
  const k = 'auth_' + room;
  const hit = cache.get(k);
  if (hit) return JSON.parse(hit);
  const list = readMembers_().filter(function (m) { return m.room === room; })
    .map(function (m) { return { uid: m.uid, token: m.token, kicked: m.kicked }; });
  try { cache.put(k, JSON.stringify(list), 300); } catch (err) {}
  return list;
}

function bust_(room) {
  CacheService.getScriptCache().remove('auth_' + room);
}

function auth_(room, uid, token) {
  if (!roomOk_(room) || !uid || !token) return null;
  const list = authList_(room);
  for (let i = 0; i < list.length; i++) {
    if (list[i].uid === uid && list[i].token === token) return list[i];
  }
  return null;
}

function kickedSet_(room) {
  const set = {};
  authList_(room).forEach(function (m) { if (m.kicked) set[m.uid] = true; });
  return set;
}

function hostOf_(room) {
  const cache = CacheService.getScriptCache();
  const k = 'host_' + room;
  const hit = cache.get(k);
  if (hit) return hit;
  const s = sheet_(EVENTS, E_HEADER);
  const last = s.getLastRow();
  if (last < 2) return '';
  const v = s.getRange(2, 1, last - 1, 3).getValues();
  for (let i = 0; i < v.length; i++) {
    if (v[i][0] === room && v[i][1] === 'room') {
      try { cache.put(k, String(v[i][2]), 21600); } catch (err) {}
      return String(v[i][2]);
    }
  }
  return '';
}

// 이 방의 기록에서 같은 대화명을 '다른 신원'이 이미 쓴 적이 있는가 (등록 전 옛 기록 보호)
function nickUsedByOther_(room, key, uid) {
  const s = sheet_(EVENTS, E_HEADER);
  const last = s.getLastRow();
  if (last < 2) return false;
  const v = s.getRange(2, 1, last - 1, 4).getValues();
  for (let i = 0; i < v.length; i++) {
    if (v[i][0] === room && v[i][3] && norm_(v[i][3]) === key && v[i][2] !== uid) return true;
  }
  return false;
}

/* ---------- 라우팅 ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'pull') return json_(pull_(String(p.room || ''), Number(p.since) || 1, '', '', ''));
  return json_({ ok: true, hello: 'meeting-board' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  try {
    switch (body.action) {
      case 'pull': return json_(pull_(String(body.room || ''), Number(body.since) || 1, clean_(body.uid, 40), String(body.token || ''), String(body.kv || '')));
      case 'login': return json_(login_(body));
      case 'add': return json_(add_(body));
      case 'kick': return json_(kick_(body));
      case 'admin_list': return json_(adminList_(body));
      case 'summarize': return json_(summarize_(body));
    }
  } catch (err) {
    return json_({ ok: false, error: 'server_error' });
  }
  return json_({ ok: false, error: 'unknown_action' });
}

/* ---------- 읽기 ---------- */

// 장소 제안·모든 투표·장소 삭제는 이름을 지우고 가명 ID만 내려보낸다.
function isAnon_(type, payload) {
  return type === 'place' || type === 'vote' || (type === 'del' && String(payload.target || '').charAt(0) === 'p');
}

function anonId_(room, uid, salt) {
  return 'x' + sha_(salt + '|' + room + '|' + uid).slice(0, 12);
}

function pull_(room, since, uid, token, kv) {
  const s = sheet_(EVENTS, E_HEADER);
  const last = s.getLastRow();
  const out = { ok: true, last: last, ai: hasKey_(), rows: [] };
  if (!roomOk_(room)) return out;

  let me = null;
  if (uid || token) {
    me = auth_(room, uid, token);
    if (!me) return { ok: false, error: 'auth' };
    if (me.kicked) return { ok: true, kicked: true, last: last, ai: false, rows: [] };
  }

  const kicked = kickedSet_(room);
  const curKv = sha_(Object.keys(kicked).sort().join(',')).slice(0, 10);   // 제외 명단이 바뀌면 달라지는 값
  out.kv = curKv;
  if (since > last || kv !== curKv) { since = 1; out.reset = true; }   // 줄 번호가 어긋났거나 제외 명단이 바뀐 경우: 처음부터 다시
  if (last <= since) return out;

  const salt = salt_();
  const vals = s.getRange(since + 1, 1, last - since, E_HEADER.length).getValues();
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    if (r[0] !== room) continue;
    if (kicked[r[2]]) continue;                        // 제외된 사람의 기록은 모두에게서 숨김
    let payload = {};
    try { payload = JSON.parse(r[4]); } catch (err) {}
    const row = { n: since + 1 + i, type: r[1], uid: r[2], nick: r[3], payload: payload, ts: r[5], cid: r[6] };
    if (isAnon_(r[1], payload)) {
      row.mine = !!me && r[2] === uid;
      row.uid = row.mine ? r[2] : anonId_(room, r[2], salt);
      row.nick = '';
    }
    out.rows.push(row);
  }
  return out;
}

/* ---------- 로그인(대화명 + 비밀번호) ---------- */

function login_(b) {
  const room = String(b.room || '');
  if (!roomOk_(room)) return { ok: false, error: 'bad_room' };
  const nick = clean_(b.nick, 16);
  const pin = String(b.pin == null ? '' : b.pin);
  const uid = clean_(b.uid, 40);
  if (!nick) return { ok: false, error: 'bad_nick' };
  if (pin.length < 4 || pin.length > 12) return { ok: false, error: 'bad_pin' };
  if (!/^[A-Za-z0-9]{8,40}$/.test(uid)) return { ok: false, error: 'bad_uid' };

  const key = norm_(nick);
  const cache = CacheService.getScriptCache();
  const badKey = 'bad_' + sha_(room + '|' + key).slice(0, 32);
  const bad = Number(cache.get(badKey) || 0);
  if (bad >= MAX_BAD) return { ok: false, error: 'locked' };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const all = readMembers_();
    const ms = all.filter(function (m) { return m.room === room; });
    const h = 'h' + sha_(salt_() + '|' + room + '|' + key + '|' + pin);
    const rec = ms.filter(function (m) { return m.key === key; })[0];

    if (rec) {
      if (rec.kicked) return { ok: false, error: 'kicked' };
      if (rec.hash !== h) {
        cache.put(badKey, String(bad + 1), LOCK_SEC);
        return { ok: false, error: 'wrong_pin' };
      }
      cache.remove(badKey);
      return { ok: true, uid: rec.uid, token: rec.token, nick: rec.nick };
    }

    if (nickUsedByOther_(room, key, uid)) return { ok: false, error: 'name_taken' };
    const same = ms.filter(function (m) { return m.uid === uid; })[0];   // 같은 신원이 다른 이름으로 이미 등록된 경우(이름 변경)
    if (same && same.kicked) return { ok: false, error: 'kicked' };
    if (all.length >= MAX_MEMBERS) return { ok: false, error: 'full' };

    const token = same ? same.token : 't' + Utilities.getUuid().replace(/-/g, '');
    sheet_(MEMBERS, M_HEADER).appendRow([room, key, nick, h, uid, token, 0, Date.now()]);
    bust_(room);
    return { ok: true, uid: uid, token: token, nick: nick, created: true };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 쓰기 ---------- */

function append_(room, type, uid, nick, payload, cid) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const s = sheet_(EVENTS, E_HEADER);
    const last = s.getLastRow();
    // 재전송으로 인한 중복 방지: 최근 300줄의 cid 확인
    if (cid && last > 1) {
      const from = Math.max(2, last - 299);
      const cids = s.getRange(from, 7, last - from + 1, 1).getValues();
      for (let i = 0; i < cids.length; i++) if (cids[i][0] === cid) return { ok: true, n: from + i, dup: true };
    }
    s.appendRow([room, type, uid, clean_(nick, 20), JSON.stringify(payload || {}), Date.now(), cid]);
    return { ok: true, n: s.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}

function add_(b) {
  const room = String(b.room || '');
  if (!roomOk_(room)) return { ok: false, error: 'bad_room' };
  if (TYPES.indexOf(b.type) < 0) return { ok: false, error: 'bad_type' };
  const payloadText = JSON.stringify(b.payload || {});
  if (payloadText.length > MAX_PAYLOAD) return { ok: false, error: 'too_long' };

  const uid = clean_(b.uid, 40);
  const me = auth_(room, uid, String(b.token || ''));
  if (!me) return { ok: false, error: 'auth' };
  if (me.kicked) return { ok: false, error: 'kicked' };

  if (b.type === 'room' && hostOf_(room)) return { ok: false, error: 'exists' };
  if ((b.type === 'summary' || b.type === 'roomedit') && hostOf_(room) !== uid) return { ok: false, error: 'forbidden' };   // 요약 올리기·회의 설정 수정은 방장만

  return append_(room, b.type, uid, b.nick, b.payload, clean_(b.cid, 40));
}

/* ---------- 방장 기능 ---------- */

function hostAuth_(b) {
  const room = String(b.room || '');
  const uid = clean_(b.uid, 40);
  const me = auth_(room, uid, String(b.token || ''));
  if (!me || me.kicked) return null;
  if (hostOf_(room) !== uid) return null;
  return { room: room, uid: uid };
}

function adminList_(b) {
  const h = hostAuth_(b);
  if (!h) return { ok: false, error: 'forbidden' };
  const out = {};
  readMembers_().forEach(function (m) {
    if (m.room !== h.room) return;
    out[m.uid] = { uid: m.uid, nick: m.nick, kicked: m.kicked };
  });
  // 로그인 도입 전에 남긴 옛 기록의 참가자도 목록에 포함
  const s = sheet_(EVENTS, E_HEADER);
  const last = s.getLastRow();
  if (last >= 2) {
    const v = s.getRange(2, 1, last - 1, 4).getValues();
    for (let i = 0; i < v.length; i++) {
      if (v[i][0] === h.room && v[i][2] && v[i][3] && !out[v[i][2]]) {
        out[v[i][2]] = { uid: v[i][2], nick: v[i][3], kicked: false, legacy: true };
      }
    }
  }
  return { ok: true, host: h.uid, members: Object.keys(out).map(function (k) { return out[k]; }) };
}

function kick_(b) {
  const h = hostAuth_(b);
  if (!h) return { ok: false, error: 'forbidden' };
  const target = clean_(b.target, 40);
  const on = b.on !== false;
  if (!target || target === h.uid) return { ok: false, error: 'bad_target' };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const s = sheet_(MEMBERS, M_HEADER);
    const rows = readMembers_().filter(function (m) { return m.room === h.room && m.uid === target; });
    if (rows.length) {
      rows.forEach(function (m) { s.getRange(m.row, 7).setValue(on ? 1 : 0); });
    } else if (on) {
      // 로그인 도입 전의 옛 참가자: 이름을 점유한 채 제외 처리
      let nick = '';
      const es = sheet_(EVENTS, E_HEADER);
      const last = es.getLastRow();
      if (last >= 2) {
        const v = es.getRange(2, 1, last - 1, 4).getValues();
        for (let i = 0; i < v.length; i++) if (v[i][0] === h.room && v[i][2] === target && v[i][3]) nick = String(v[i][3]);
      }
      s.appendRow([h.room, norm_(nick) || ('legacy-' + target), nick, '', target, 'x-disabled', 1, Date.now()]);
    }
    bust_(h.room);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- AI 요약 ---------- */

function summarize_(b) {
  const room = String(b.room || '');
  if (!roomOk_(room)) return { ok: false, error: 'bad_room' };
  const uid = clean_(b.uid, 40);
  const me = auth_(room, uid, String(b.token || ''));
  if (!me) return { ok: false, error: 'auth' };
  if (me.kicked) return { ok: false, error: 'kicked' };

  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return { ok: false, error: 'no_key' };
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
  append_(room, 'summary', uid, b.nick, { text: out }, clean_(b.cid, 40));
  return { ok: true };
}
