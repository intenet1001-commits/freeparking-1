# 아이폰 주차 알림 설정

1. `supabase/migrations/20261004000000_push_notifications.sql`을 연결된 Supabase에 적용한다. 새 테이블은 RLS가 켜져 있고 서버의 service role만 접근한다.
2. `npx web-push generate-vapid-keys --json`으로 키 쌍을 **한 번만** 만든다. 기존 구독을 유지하려면 이후 키를 바꾸지 않는다.
3. Vercel Production 환경 변수에 `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`(실제 `mailto:` 연락처), `CRON_SECRET`을 설정한다. `CRON_SECRET`은 긴 임의 문자열로 설정한다. Service role 키와 VAPID 개인 키는 브라우저에 노출하지 않는다.
4. GitHub Actions 저장소 secrets에 같은 `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`를 설정한다. 기존 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PARKING_APP_URL`, `CRON_SECRET`도 유지한다. 자동 등록 오류 푸시와 정오 보조 호출에 사용한다.
5. Production을 배포한 뒤 아이폰 Safari에서 앱 주소를 홈 화면에 추가해 실행한다. 앱의 **주차 알림 → 알림 켜기**를 누르고 iOS 알림 권한을 허용한다. 이어서 **테스트** 버튼으로 실제 수신을 확인한다. 이미 홈 화면에 설치한 사용자는 앱을 새로고침하거나 종료 후 다시 열면 된다.

일요일 정오(KST)에 Vercel Cron이 `/api/cron/sunday-summary`를 호출한다. 예약 실행은 플랫폼 사정에 따라 늦어질 수 있다. 요약은 현재 하이파킹 조회와 당일 처리 기록을 구분해 표시하며, 조회에 실패하면 `조회 불가`로 표시한다. 오류 알림은 종류별로 한 시간에 한 번으로 제한한다.

서비스 워커는 알림과 클릭만 처리하며 페이지 요청을 캐시하지 않는다. 배포된 수정은 앱의 **새로고침** 버튼 또는 완전 종료 후 재실행으로 가져올 수 있다. 앱을 다시 설치할 필요는 없다.
