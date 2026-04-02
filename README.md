# Slides Workspace

이 저장소는 Bun workspace 기반의 Slidev 모노레포입니다.

## Workspace layout

- `apps/decks`: 여러 Slidev 덱을 빌드해서 Cloudflare Pages에 올리는 앱
- `apps/realtime-feedback`: 여러 발표에서 공용으로 쓰는 Cloudflare Worker + Durable Objects 피드백 서버

## Commands

- `bun install`: 전체 워크스페이스 의존성 설치
- `bun run dev:pages`: 기본 덱 실행
- `bun run dev:deck -- slides/another-deck.md`: 특정 덱 실행
- `bun run build:pages`: `apps/decks/slides/*.md` 전체를 Pages 산출물로 빌드
- `bun run check:feedback`: 피드백 서버 타입 체크
- `bun run cf-typegen:feedback`: 워커 타입 재생성

Slidev 덱은 `global.vue`의 로컬 리액션 클라이언트를 사용하며, `presentationId`는 슬라이드 제목이 아니라 파일명에서 안정적으로 계산됩니다.

## Deploy

GitHub Actions로 Cloudflare에 배포하도록 구성되어 있습니다.

- `deploy-pages.yml`: `main` 브랜치에 푸시되면 Slidev 산출물을 Cloudflare Pages로 직접 업로드
- `deploy-realtime-feedback.yml`: `main` 브랜치에 푸시되면 피드백 Worker 배포

필요한 GitHub Secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

선택 GitHub Variables:

- `CLOUDFLARE_PAGES_PROJECT_NAME`
  설정하지 않으면 workflow는 기본값으로 `slides`를 사용합니다.

## Notes

- Cloudflare Pages 문서 기준으로, 이미 Git integration으로 만든 Pages 프로젝트는 Direct Upload로 전환할 수 없습니다.
- 다만 기존 Git-integrated Pages 프로젝트에서 자동 배포를 끄면, Wrangler를 사용한 직접 배포를 계속 사용할 수 있습니다.
- 이 저장소는 그 전제를 두고 GitHub Actions에서 `wrangler pages deploy`를 실행하도록 구성했습니다.
