# 회의 조율 보드

회의 일정(달력 가능/불가), 장소(추천/비추·익명 사유), 안건, 채팅, 자동 요약을 한 링크에서 처리하는 공유 페이지.

## 구성
- `index.html` — 화면 (GitHub Pages 등에 올림). 맨 위 `API_URL` 에 Apps Script 웹앱 주소를 넣는다. 비어 있으면 데모 모드.
- `Code.gs` — 서버 (구글시트에 붙인 Apps Script). 모든 기록을 `events` 시트에 쌓는다.

## 배포 순서
1. 새 구글시트 → 확장 프로그램 → Apps Script 에 `Code.gs` 붙여넣기
2. 배포 → 새 배포 → 웹 앱 (실행: 나 / 액세스: 모든 사용자) → URL 복사
3. `index.html` 의 `const API_URL = ''` 에 URL 입력 후 호스팅
4. (선택) Apps Script 스크립트 속성에 `ANTHROPIC_API_KEY` 추가 → 자동 요약 활성화
