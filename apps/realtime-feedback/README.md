# Realtime Feedback Worker

여러 Slidev 덱에서 공용으로 사용할 수 있는 실시간 리액션 서버입니다.

## Endpoints

- `GET /healthz`
- `GET /ws/:presentationId`
- `GET /api/presentations`
- `GET /api/presentations/:presentationId`
- `GET /api/presentations/:presentationId/feedback`

## Commands

- `bun --cwd apps/realtime-feedback run dev`
- `bun --cwd apps/realtime-feedback run check`
- `bun --cwd apps/realtime-feedback run deploy`
