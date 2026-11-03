from playwright.sync_api import sync_playwright
import re, sys

BASE = 'http://localhost:8791/index.html'
errs = []
def check(name, cond):
    print(('PASS ' if cond else 'FAIL ') + name)
    if not cond: errs.append(name)

def newpage(b, label):
    ctx = b.new_context(viewport={'width': 1200, 'height': 900})
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(f'{label} pageerror: {e}'))
    return ctx, pg

def login(pg, nick, pin):
    pg.fill('#ln1', nick); pg.fill('#lp1', pin); pg.click('#lok')

with sync_playwright() as p:
    b = p.chromium.launch()

    # 1) 방장이 방 만들기
    hctx, H = newpage(b, 'H')
    H.goto(BASE)
    H.fill('#lt', '통합 테스트 회의'); H.fill('#ln', '김방장'); H.fill('#lp', '1234'); H.click('#mk')
    H.wait_for_url(re.compile(r'\?r='), timeout=10000)
    H.wait_for_selector('#cal .day[data-d]', timeout=10000)
    ROOM_URL = H.url
    check('방 생성 후 바로 입장(재로그인 없음)', H.inner_text('#title') == '통합 테스트 회의')
    H.wait_for_timeout(500)
    check('방장에게 ⚙ 관리 버튼 보임', H.is_visible('#adminbtn'))

    # 2) 참가자 P 입장(처음) - 로그인 창
    pctx, P = newpage(b, 'P')
    P.goto(ROOM_URL)
    P.wait_for_selector('#ln1')
    login(P, '이참석', '5678')
    P.wait_for_selector('#cal .day[data-d]', timeout=10000)
    check('참가자는 ⚙ 관리 버튼 없음', not P.is_visible('#adminbtn'))
    P.click('.tab[data-t=place]'); P.fill('#pn', '수원시청'); P.click('#padd')
    P.wait_for_timeout(600)
    P.locator('#places .item', has_text='수원시청').locator('button.dn').click()
    P.fill('#rsn', '대중교통이 불편해요'); P.click('#rok')
    P.fill('#ci', '안녕하세요 참석자입니다'); P.press('#ci', 'Enter')
    P.click('.tab[data-t=cal]'); L = P.locator('#cal .day[data-d]'); L.nth(3).click(); P.wait_for_timeout(1200)

    # 3) 방장 화면에서 익명 확인
    H.wait_for_timeout(5500)
    H.click('.tab[data-t=place]')
    txt = H.inner_text('#places')
    check('방장 화면에 장소가 보임', '수원시청' in txt)
    check('장소 목록에 제안자/투표자 이름 없음', '이참석' not in txt and '김방장' not in txt)
    H.locator('#places .item', has_text='수원시청').locator('button.tg').click()
    check('비추 사유가 익명으로 보임', '대중교통이 불편해요' in H.inner_text('#places'))
    check('채팅은 이름과 함께 보임', '이참석' in H.inner_text('#msgs'))
    # 네트워크 응답에도 이름이 없는지 (원본 확인)
    raw = H.evaluate("JSON.stringify(server.filter(e=>e.type==='place'||e.type==='vote'))")
    check('수신 데이터의 장소/투표 행에 닉네임 없음', '이참석' not in raw)

    # 4) 다른 브라우저(P2)에서 같은 이름+비번으로 이어가기
    p2ctx, P2 = newpage(b, 'P2')
    P2.goto(ROOM_URL); P2.wait_for_selector('#ln1')
    login(P2, '이참석', '0000')
    P2.wait_for_timeout(800)
    check('틀린 비번 → 안내 메시지', '맞지 않아요' in P2.inner_text('#lmsg'))
    P2.fill('#lp1', '5678'); P2.click('#lok')
    P2.wait_for_selector('#cal .day[data-d]', timeout=10000)
    P2.wait_for_timeout(800)
    P2.click('.tab[data-t=place]')
    check('다른 기기에서도 내가 제안한 장소 삭제 버튼 보임', P2.locator('#places .item button.x').count() == 1)
    P2.locator('#places .item', has_text='수원시청').locator('button.tg').click()
    check('내 의견 표시가 이어짐', '(내 의견)' in P2.inner_text('#places'))
    P2.click('.tab[data-t=cal]')
    check('내 일정 응답이 이어짐', P2.locator('#cal .day.my-y').count() == 1)

    # 5) 방장이 관리 메뉴에서 내보내기
    H.click('#adminbtn'); H.wait_for_selector('#adlist button[data-a]', timeout=8000)
    lst = H.inner_text('#adlist')
    check('참가자 목록에 이참석 보임', '이참석' in lst and '방장' in lst)
    H.locator('#adlist button[data-a=kick]').first.click()
    H.wait_for_timeout(400)
    check('내보내기는 두 번 눌러야 실행', '한 번 더' in H.inner_text('#adlist'))
    H.locator('#adlist button[data-a=kick]').first.click()
    H.wait_for_timeout(1500)
    check('목록에 제외됨 표시', '제외됨' in H.inner_text('#adlist'))
    H.click('#adx')
    H.wait_for_timeout(1500)
    H.click('.tab[data-t=place]')
    check('내보낸 사람의 장소가 방장 화면에서 사라짐', '수원시청' not in H.inner_text('#places'))
    check('내보낸 사람의 채팅도 사라짐', '이참석' not in H.inner_text('#msgs'))

    # 6) 제외된 사람 화면
    P.wait_for_timeout(6000)
    check('제외된 사람 화면에 안내', '제외되었어요' in P.inner_text('body'))
    P2.reload(); P2.wait_for_timeout(2500)
    check('다른 기기로 들어와도 제외 상태', '제외되었어요' in P2.inner_text('body'))

    # 7) 복원
    H.click('#adminbtn'); H.wait_for_selector('#adlist button[data-a=restore]', timeout=8000)
    H.click('#adlist button[data-a=restore]'); H.wait_for_timeout(1500)
    check('복원됨(제외됨 표시 사라짐)', '제외됨' not in H.inner_text('#adlist'))
    H.click('#adx'); H.wait_for_timeout(1500)
    H.click('.tab[data-t=place]')
    check('복원 후 장소 다시 보임', '수원시청' in H.inner_text('#places'))

    # 8) 대화명 변경(이름 바꿔도 기록 이어짐)
    P3ctx, P3 = newpage(b, 'P3')
    P3.goto(ROOM_URL); P3.wait_for_selector('#ln1'); login(P3, '이참석', '5678')
    P3.wait_for_selector('#cal .day[data-d]', timeout=10000)
    P3.click('#rename'); P3.wait_for_selector('#ln1')
    P3.fill('#ln1', '이참석2'); P3.fill('#lp1', '5678'); P3.click('#lok')
    P3.wait_for_timeout(2500)
    check('이름 변경 후에도 같은 신원(내 일정 유지)', P3.locator('#cal .day.my-y').count() == 1)
    H.wait_for_timeout(5000)
    H.click('.tab[data-t=cal]')
    check('방장 화면에 새 이름 표시', '이참석2' in H.inner_text('#who'))

    # 9) 이름 중복 방지: 다른 사람이 방장 이름 사용 시도
    xctx, X = newpage(b, 'X')
    X.goto(ROOM_URL); X.wait_for_selector('#ln1'); login(X, '김방장', '9999')
    X.wait_for_timeout(1000)
    check('다른 사람이 방장 이름으로 입장 불가', 'tt' not in X.inner_text('#lmsg') and ('이미' in X.inner_text('#lmsg') or '맞지' in X.inner_text('#lmsg')))


    # 10) 방장이 회의 설정(이름·기간) 수정
    H.click('#adminbtn'); H.wait_for_selector('#ed-save')
    H.fill('#ed-t', '수정된 회의 이름'); H.fill('#ed-s', '2026-11-10'); H.fill('#ed-e', '2026-12-20')
    H.click('#ed-save'); H.wait_for_timeout(600); H.click('#adx')
    H.wait_for_timeout(500)
    check('방장 화면에 새 이름·기간 즉시 반영', H.inner_text('#title') == '수정된 회의 이름' and '11/10' in H.inner_text('#range') and '12/20' in H.inner_text('#range'))
    P3.wait_for_timeout(6500)
    check('참석자 화면에도 새 이름·기간 반영', P3.inner_text('#title') == '수정된 회의 이름' and '11/10' in P3.inner_text('#range'))
    check('참석자는 설정 수정 버튼 없음', not P3.is_visible('#adminbtn'))
    # 참가자가 직접 이벤트를 보내도 무시/거부
    r = P3.evaluate("backend.add({room:ROOM,type:'roomedit',uid:UID,nick:NICK,payload:{title:'해킹'},cid:'hack1'})")
    check('참가자의 설정 변경 요청은 서버가 거부', r.get('error') == 'forbidden')

    b.close()

print('\nFAILED:' if errs else '\nALL E2E PASSED', errs if errs else '')
sys.exit(1 if errs else 0)
