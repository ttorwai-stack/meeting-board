const path = require('path');
const { makeEnv } = require('./gas-harness');
const CODE = path.join(__dirname, '..', 'Code.gs');
const assert = require('assert');
const env = makeEnv(CODE);
const { post, get, book } = env;
let n = 0;
const ok = (name, cond) => { assert(cond, name); console.log('PASS', name); };
const room = 'roomtest1';
const cid = () => 'c' + (++n);

// 1) 방장 가입 + 방 생성
const A = post({ action: 'login', room, nick: '김방장', pin: '1234', uid: 'uidAAAAAAAA' });
ok('방장 가입', A.ok && A.token && A.uid === 'uidAAAAAAAA');
ok('토큰 없이 쓰기 거부', post({ action: 'add', room, type: 'room', uid: 'uidAAAAAAAA', nick: '김방장', payload: { title: 't' }, cid: cid() }).error === 'auth');
ok('방 생성', post({ action: 'add', room, type: 'room', uid: A.uid, token: A.token, nick: '김방장', payload: { title: '회의', start: '2026-11-02', end: '2026-12-01' }, cid: cid() }).ok);
ok('방 중복 생성 거부', post({ action: 'add', room, type: 'room', uid: A.uid, token: A.token, nick: '김방장', payload: {}, cid: cid() }).error === 'exists');

// 2) 일반 참가자
const B = post({ action: 'login', room, nick: '이참석', pin: '5678', uid: 'uidBBBBBBBB' });
ok('참가자 가입', B.ok);
ok('잘못된 토큰 거부', post({ action: 'add', room, type: 'chat', uid: B.uid, token: 'bad', nick: '이참석', payload: { text: 'hi' }, cid: cid() }).error === 'auth');
ok('남의 uid 사칭 거부', post({ action: 'add', room, type: 'chat', uid: A.uid, token: B.token, nick: '김방장', payload: { text: 'fake' }, cid: cid() }).error === 'auth');
ok('채팅', post({ action: 'add', room, type: 'chat', uid: B.uid, token: B.token, nick: '이참석', payload: { text: '안녕' }, cid: cid() }).ok);
ok('장소 제안', post({ action: 'add', room, type: 'place', uid: B.uid, token: B.token, nick: '이참석', payload: { id: 'p1', name: '수원시청' }, cid: cid() }).ok);
ok('투표(사유)', post({ action: 'add', room, type: 'vote', uid: B.uid, token: B.token, nick: '이참석', payload: { target: 'p1', v: -1, reason: '멀어요' }, cid: cid() }).ok);
ok('일반 참가자 요약 올리기 거부', post({ action: 'add', room, type: 'summary', uid: B.uid, token: B.token, nick: '이참석', payload: { text: 'x' }, cid: cid() }).error === 'forbidden');
ok('방장 요약 올리기', post({ action: 'add', room, type: 'summary', uid: A.uid, token: A.token, nick: '김방장', payload: { text: '요약' }, cid: cid() }).ok);

// 3) 비밀번호 이어가기 (다른 브라우저 = 새 uid)
const B2bad = post({ action: 'login', room, nick: '이참석', pin: '0000', uid: 'uidB2222222' });
ok('틀린 비번 거부', B2bad.error === 'wrong_pin');
const B2 = post({ action: 'login', room, nick: '이참석', pin: '5678', uid: 'uidB2222222' });
ok('다른 기기에서 같은 이름+비번 → 기존 신원', B2.ok && B2.uid === B.uid && B2.token === B.token);
ok('대소문자·공백 무시', post({ action: 'login', room, nick: ' 이참석 ', pin: '5678', uid: 'uidB3333333' }).uid === B.uid);
// 잠금
for (let i = 0; i < 5; i++) post({ action: 'login', room, nick: '김방장', pin: 'wrong' + i, uid: 'uidX0000000' });
ok('5회 오류 후 잠금', post({ action: 'login', room, nick: '김방장', pin: '1234', uid: 'uidAAAAAAAA' }).error === 'locked');
env.cache['bad_' + 'x'] = null;
Object.keys(env.cache).filter(k => k.startsWith('bad_')).forEach(k => delete env.cache[k]);
ok('잠금 해제 후 정상 로그인', post({ action: 'login', room, nick: '김방장', pin: '1234', uid: 'uidAAAAAAAA' }).ok);
ok('비번 길이 검사', post({ action: 'login', room, nick: '가나', pin: '12', uid: 'uidCCCCCCCC' }).error === 'bad_pin');

// 4) 옛 기록(등록 전) 이름 보호
env.book.events.appendRow([room, 'avail', 'legacyuid001', '박옛날', '{"days":{}}', Date.now(), 'old1']);
ok('옛 이름은 다른 신원이 가로채기 불가', post({ action: 'login', room, nick: '박옛날', pin: '1111', uid: 'uidD4444444' }).error === 'name_taken');
const L = post({ action: 'login', room, nick: '박옛날', pin: '1111', uid: 'legacyuid001' });
ok('옛 기록의 원래 신원은 비번 설정 가능', L.ok && L.uid === 'legacyuid001');

// 5) 읽기: 익명 처리 + mine
const pa = post({ action: 'pull', room, since: 1, uid: A.uid, token: A.token });
const voteRowA = pa.rows.find(r => r.type === 'vote');
const placeRowA = pa.rows.find(r => r.type === 'place');
ok('방장 화면: 투표 행에 이름 없음', voteRowA.nick === '' && voteRowA.uid !== B.uid && !voteRowA.mine);
ok('방장 화면: 장소 행에 이름 없음', placeRowA.nick === '' && placeRowA.uid !== B.uid);
ok('채팅 행은 이름 유지', pa.rows.find(r => r.type === 'chat').nick === '이참석');
const pb = post({ action: 'pull', room, since: 1, uid: B.uid, token: B.token });
ok('본인 화면: mine 표시', pb.rows.find(r => r.type === 'vote').mine === true && pb.rows.find(r => r.type === 'vote').uid === B.uid);
ok('남의 uid만으로 mine 훔치기 불가(토큰 필요)', post({ action: 'pull', room, since: 1, uid: B.uid, token: 'bad' }).error === 'auth');
ok('GET 읽기는 mine 없음', get({ action: 'pull', room, since: 1 }).rows.every(r => !r.mine));

// 6) 시트 줄 번호 리셋
const reset = post({ action: 'pull', room, since: 9999, uid: A.uid, token: A.token });
ok('since 초과 시 reset + 전체 재전송', reset.reset === true && reset.rows.length > 3);

// 7) 방장 기능
ok('일반 참가자 관리 목록 거부', post({ action: 'admin_list', room, uid: B.uid, token: B.token }).error === 'forbidden');
const list = post({ action: 'admin_list', room, uid: A.uid, token: A.token });
ok('방장 관리 목록', list.ok && list.members.length >= 3 && list.host === A.uid);
ok('일반 참가자 내보내기 거부', post({ action: 'kick', room, uid: B.uid, token: B.token, target: A.uid }).error === 'forbidden');
ok('방장 자기 자신 제외 불가', post({ action: 'kick', room, uid: A.uid, token: A.token, target: A.uid }).error === 'bad_target');
ok('내보내기', post({ action: 'kick', room, uid: A.uid, token: A.token, target: B.uid }).ok);
const afterKick = post({ action: 'pull', room, since: 1, uid: A.uid, token: A.token });
ok('제외된 사람 기록이 모두에게서 숨겨짐', afterKick.rows.every(r => r.uid !== B.uid && r.nick !== '이참석') && !afterKick.rows.some(r => r.type === 'place'));
ok('제외된 사람 pull → kicked', post({ action: 'pull', room, since: 1, uid: B.uid, token: B.token }).kicked === true);
ok('제외된 사람 쓰기 거부', post({ action: 'add', room, type: 'chat', uid: B.uid, token: B.token, nick: '이참석', payload: { text: 'x' }, cid: cid() }).error === 'kicked');
ok('제외된 이름으로 재로그인 거부', post({ action: 'login', room, nick: '이참석', pin: '5678', uid: 'uidB9999999' }).error === 'kicked');
ok('복원', post({ action: 'kick', room, uid: A.uid, token: A.token, target: B.uid, on: false }).ok);
ok('복원 후 기록 다시 표시', post({ action: 'pull', room, since: 1, uid: A.uid, token: A.token }).rows.some(r => r.type === 'place'));
// 옛 참가자 내보내기
ok('옛 참가자(등록 안 된 uid) 내보내기', post({ action: 'kick', room, uid: A.uid, token: A.token, target: 'legacyzzzz99' }).ok === true);

// 8) 요약 제한
const noKey = post({ action: 'summarize', room, uid: A.uid, token: A.token, prompt: 'p', text: 't', cid: cid() });
ok('API 키 없으면 no_key', noKey.error === 'no_key');
console.log('\nALL SERVER TESTS PASSED');

// 제외 명단이 바뀌면 열려 있는 다른 화면도 처음부터 다시 받게 됨(kv)
{
  const e2 = makeEnv(CODE);
  const r = 'kvroom01', mk = (nick, uid) => e2.post({ action: 'login', room: r, nick, pin: '1234', uid });
  const a = mk('방장', 'hostuid0001'), b = mk('참가', 'partuid0001');
  e2.post({ action: 'add', room: r, type: 'room', uid: a.uid, token: a.token, nick: '방장', payload: { title: 't', start: '2026-11-02', end: '2026-12-01' }, cid: 'k1' });
  e2.post({ action: 'add', room: r, type: 'chat', uid: b.uid, token: b.token, nick: '참가', payload: { text: 'x' }, cid: 'k2' });
  const p1 = e2.post({ action: 'pull', room: r, since: 1, uid: a.uid, token: a.token, kv: '' });
  const same = e2.post({ action: 'pull', room: r, since: p1.last, uid: a.uid, token: a.token, kv: p1.kv });
  assert(!same.reset && same.rows.length === 0, 'kv 동일하면 새 글만');
  e2.post({ action: 'kick', room: r, uid: a.uid, token: a.token, target: b.uid });
  const p2 = e2.post({ action: 'pull', room: r, since: p1.last, uid: a.uid, token: a.token, kv: p1.kv });
  assert(p2.reset === true && p2.kv !== p1.kv && !p2.rows.some(x => x.nick === '참가'), 'kv 변경 → reset, 제외된 기록 제거');
  console.log('PASS 제외 명단 변경 시 다른 화면도 초기화(kv)');
}

// 회의 설정 수정은 방장만 / 대화명 16자
{
  const e3 = makeEnv(CODE);
  const r = 'editroom1';
  const a = e3.post({ action: 'login', room: r, nick: '홍길동(경기도교육청)', pin: '1234', uid: 'hostuid0002' });
  assert(a.ok && a.nick === '홍길동(경기도교육청)', '긴 대화명 허용');
  const b = e3.post({ action: 'login', room: r, nick: '이영희(서울)', pin: '1234', uid: 'partuid0002' });
  e3.post({ action: 'add', room: r, type: 'room', uid: a.uid, token: a.token, nick: a.nick, payload: { title: 't', start: '2026-11-02', end: '2026-12-01' }, cid: 'e1' });
  assert(e3.post({ action: 'add', room: r, type: 'roomedit', uid: b.uid, token: b.token, nick: b.nick, payload: { title: 'x' }, cid: 'e2' }).error === 'forbidden', '참가자 설정 수정 거부');
  assert(e3.post({ action: 'add', room: r, type: 'roomedit', uid: a.uid, token: a.token, nick: a.nick, payload: { title: '새 이름', start: '2026-11-10', end: '2026-12-20' }, cid: 'e3' }).ok, '방장 설정 수정');
  console.log('PASS 회의 설정 수정 방장 전용 + 긴 대화명');
}
