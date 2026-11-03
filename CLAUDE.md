# 회의 조율 보드 — 작업 안내 (Claude Code용)

참석자가 한 링크에서 **회의 일정(달력 가능/불가) · 장소(추천/비추, 익명 사유) · 안건 · 채팅**을 정리하고, 활동이 멈추면 **AI가 자동 요약**하는 공유 페이지.
사용자는 한국어(반말 가능)로 소통한다. 설명보다 **바로 동작하는 결과**를 선호한다.

## 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 전체(단일 파일, 외부 라이브러리 없음). GitHub Pages로 서비스. 맨 위 `API_URL`이 서버 주소. 비어 있으면 **데모 모드**(브라우저 localStorage에만 저장) |
| `Code.gs` | 서버. 구글시트에 붙은 Apps Script 웹 앱. 시트가 곧 DB |
| `tests/` | 서버 단위 테스트(`server-test.js`), 브라우저 통합 테스트(`e2e/`) |

- 공개 주소: `https://ttorwai-stack.github.io/meeting-board/` (main 브랜치 push → Pages 자동 반영)
- 방 링크 형식: `…/meeting-board/?r=<방번호>`
- Apps Script 웹 앱 주소는 `index.html`의 `API_URL` 참고. 시트 ID·스크립트 프로젝트 ID는 공개 저장소라 여기에 적지 않았다(사용자에게 물을 것).

## 데이터 모델

시트 탭 두 개(서버가 자동 생성, **직접 편집·줄 삭제 금지**):

- `events` — `room, type, uid, nick, payload(JSON), ts, cid`. 모든 활동을 한 줄씩 append.
  - type: `room`(방 생성, 첫 줄의 uid가 방장) · `roomedit`(방장만: 이름·후보 기간 수정) · `avail`(내 가능/불가 날짜 전체) · `place` · `agenda` · `vote`(`{target,v:1|-1|0,reason}`) · `del` · `chat` · `summary`(방장 또는 서버 요약)
  - 화면은 이벤트를 순서대로 접어서(`derive()`) 상태를 만든다. 같은 사람의 마지막 `avail`/`vote`가 유효.
- `members` — `room, key(소문자 정규화 대화명), nick, hash(h+SHA-256), uid, token, kicked, ts`. 비밀번호 원문은 저장하지 않음.

## 신원·보안 모델 (바꿀 때 주의)

- 입장 = **대화명 + 비밀번호(4~12자)** 로그인(`login_`). 처음이면 가입, 이미 있으면 같은 비번으로 **기존 uid·token을 이어받음**(다른 기기에서도 같은 사람). 5회 오류 시 10분 잠금. 이름 변경은 같은 uid에 새 이름 등록.
- 로그인 도입 전의 옛 기록 이름은, **같은 uid(같은 브라우저)** 만 비번을 정해 인수할 수 있다(`nickUsedByOther_`).
- 클라이언트는 방별로 `localStorage['mb_id_<방>']`에 `{uid, token, nick}` 저장. 글쓰기·읽기·관리는 모두 **token 검증**(`auth_`). 서버는 token 없이는 쓰기를 받지 않는다.
- **방장** = `room` 이벤트의 uid. 방장 전용: `roomedit`, `summary` 올리기, `kick`, `admin_list`. 클라이언트가 숨기는 것만이 아니라 서버가 `hostOf_`로 강제한다.
- **내보내기(kick)**: `members.kicked=1`. 서버 `pull_`이 그 uid의 행을 모두에게서 숨기고, 본인에게는 `kicked:true`를 준다. 제외 명단이 바뀌면 `kv` 값이 달라져 다른 화면도 처음부터 다시 받는다(`reset`).
- **익명**: `place`·`vote`·장소 `del` 행은 서버가 `nick`을 지우고 uid를 가명(`anonId_`)으로 바꿔 내려보낸다. 본인 행만 토큰 검증 후 `mine:true`. 이 규칙을 깨는 변경(예: 이 행들에 닉네임 노출)은 금지. 단, 시트를 여는 사람(방 소유자)은 원본을 볼 수 있다.

## 읽기 동기화

- 화면이 4초마다 `pull`(POST). `since`는 지금까지 본 시트 행 번호. 서버가 `since > last`(줄이 지워짐) 또는 `kv` 불일치면 `reset:true`로 처음부터 재전송 → 클라이언트가 상태를 비우고 다시 구성.
- 쓰기는 낙관적 반영(`pending`) 후 서버로 전송, `cid`로 중복 방지. Apps Script 왕복이 건당 2~4초라서 UI는 즉시 반영하고 뒤에서 저장한다.

## AI 요약

- 스크립트 속성 `ANTHROPIC_API_KEY`(선택)가 있으면 `pull` 응답의 `ai:true`. 접속 중인 화면이 **활동이 90초 멈추고 직전 요약 후 5분 지났을 때** 자동 요청(`maybeAuto`). 서버는 방당 2분 1회, 하루 150회로 제한(`DAILY_SUMMARY_CAP`). 모델 문자열은 `Code.gs`의 `claude-sonnet-5-5`.
- 키가 없으면 방장이 ⚙ 관리 → 요약 도구에서 텍스트를 복사해 Claude에 붙이고, 결과를 "요약으로 올리기".
- 요약 입력(`summaryPayload`)에 장소 의견은 익명 사유만 들어간다.

## 배포

1. **화면**: `index.html` 수정 → `git push origin main` → Pages 반영(1~2분).
2. **서버**: `Code.gs` 수정 → Apps Script 편집기에 반영 → **배포 → 배포 관리 → 연필 → 버전: 새 버전 → 배포**(주소 유지). 새 서비스/스코프를 쓰면 권한 승인을 다시 요구할 수 있다(승인은 사용자 몫).
   - 작은 수정은 편집기(Monaco)에서 해당 줄만 바꾸고 저장해도 된다. 반영 후 편집기 내용 길이가 로컬 `Code.gs`와 같은지 확인할 것.
3. 확인: 공개 주소에서 방 하나 만들어 채팅·장소·투표가 시트 `events`에 쌓이는지 본 뒤, **테스트 줄은 지운다**(`batch_clear_values`로 값만 비우면 줄 번호가 안 밀린다).

## 테스트

```bash
node tests/server-test.js      # Code.gs 로직을 메모리 시트로 흉내내 검증 (로그인·익명·내보내기·방장 권한 등)
bash tests/run-e2e.sh          # 로컬 모의 서버 + Playwright 브라우저 통합 테스트 (pip install playwright && playwright install chromium)
```

- `tests/gas-harness.js`가 Apps Script 전역(SpreadsheetApp, CacheService, LockService, Utilities 등)을 흉내낸다. 새로 쓰는 Apps Script API가 있으면 여기에 스텁을 추가.
- 서버/화면을 바꾸면 위 두 테스트를 모두 돌리고 통과 확인 후 push.

## 알려진 한계·주의

- 로그인은 간이 본인 확인이다(임시 번호 쓰도록 화면에 안내). 같은 브라우저를 쓰는 사람은 서로를 구분하지 못한다.
- 시트 줄을 지우거나 순서를 바꾸면 기록이 사라진다. 지운 뒤에는 열린 화면 새로고침(서버가 reset을 보내긴 한다).
- 기록이 수천 줄 넘으면 첫 로드가 느려질 수 있다(전체 읽기).
- 데모 모드(`API_URL=''`)에서는 비밀번호 확인·서버 강제 규칙이 없다.
- 기존에 로그인 없이 쓰던 방의 방장은, 처음 쓰던 **같은 브라우저**에서 비밀번호를 한 번 정해야 방장 권한을 이어받는다.

## 남은 과제 / 아이디어

- 일정 투표에 시간대(오전/오후) 추가
- 방장이 장소·안건을 대신 삭제(주의: 장소 삭제는 익명 가명 uid 때문에 방장 판별 로직 필요)
- 대화명 `이름(지역)` 형식 강제(현재는 입력 예시만)
- 방장 이양, 방 보관/종료
- 시트 규모가 커지면 `pull` 범위 제한(방별 시작 행 캐시)
