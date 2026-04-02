import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

const rootDir = process.cwd()
const slidesDir = resolve(rootDir, 'slides')
const distDir = resolve(rootDir, 'dist')
const bunxBin = process.platform === 'win32' ? 'bunx.cmd' : 'bunx'

const slideEntries = (await readdir(slidesDir))
  .filter(name => extname(name) === '.md')
  .sort()

if (!slideEntries.length)
  throw new Error('No slide decks found in ./slides')

await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

const decks = []

for (const fileName of slideEntries) {
  const deckId = basename(fileName, '.md')
  const entryPath = join('slides', fileName)
  const tempOutputPath = resolve(slidesDir, `.slidev-dist-${deckId}`)
  const title = await resolveDeckTitle(resolve(slidesDir, fileName), deckId)

  decks.push({ deckId, title })

  await rm(tempOutputPath, { recursive: true, force: true })

  await runCommand(
    bunxBin,
    [
    'slidev',
    'build',
    entryPath,
    '--base',
    `/${deckId}/`,
    '--out',
    tempOutputPath,
    ],
    {
      VITE_SLIDEV_PRESENTATION_ID: deckId,
    },
  )

  await unlink(resolve(tempOutputPath, '_redirects')).catch(() => {})
  await cp(tempOutputPath, resolve(distDir, deckId), { recursive: true })
  await rm(tempOutputPath, { recursive: true, force: true })
}

await writeFile(resolve(distDir, 'index.html'), renderDeckIndex(decks), 'utf8')
await writeFile(resolve(distDir, '404.html'), renderNotFound(decks), 'utf8')
await writeFile(
  resolve(distDir, '_redirects'),
  `${decks.map(({ deckId }) => `/${deckId} /${deckId}/ 308`).join('\n')}\n`,
  'utf8',
)

async function resolveDeckTitle(filePath, fallback) {
  const source = await readFile(filePath, 'utf8')
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)

  if (frontmatter) {
    const title = frontmatter[1].match(/(?:^|\n)title:\s*(.+)/)
    if (title?.[1])
      return stripWrappingQuotes(title[1].trim())
  }

  const heading = source.match(/^#\s+(.+)$/m)
  return heading?.[1]?.trim() || fallback
}

function stripWrappingQuotes(value) {
  return value.replace(/^['"]|['"]$/g, '')
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function renderDeckIndex(decks) {
  const items = decks.map(({ deckId, title }) => `
      <a class="deck-card" href="/${deckId}/">
        <span class="deck-id">/${deckId}/</span>
        <strong>${escapeHtml(title)}</strong>
      </a>
    `).join('\n')

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Slidev Deck Index</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Noto Sans KR", system-ui, sans-serif;
        background: #f8fafc;
        color: #0f172a;
      }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(96, 165, 250, 0.16), transparent 28rem),
          radial-gradient(circle at bottom right, rgba(20, 184, 166, 0.16), transparent 28rem),
          #f8fafc;
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 72px 24px 96px;
      }
      h1 {
        margin: 0;
        font-size: clamp(2.2rem, 4vw, 4rem);
        line-height: 1.05;
        letter-spacing: -0.03em;
      }
      p {
        margin: 16px 0 0;
        max-width: 56rem;
        color: #334155;
        line-height: 1.7;
      }
      .deck-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
        margin-top: 40px;
      }
      .deck-card {
        display: block;
        border: 1px solid #cbd5e1;
        border-radius: 20px;
        padding: 20px;
        background: rgba(255, 255, 255, 0.84);
        backdrop-filter: blur(8px);
        color: inherit;
        text-decoration: none;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }
      .deck-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 16px 36px rgba(15, 23, 42, 0.10);
      }
      .deck-id {
        display: inline-block;
        margin-bottom: 10px;
        padding: 4px 10px;
        border-radius: 999px;
        background: #e2e8f0;
        color: #0f766e;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
      }
      strong {
        display: block;
        font-size: 1.05rem;
        line-height: 1.5;
      }
      code {
        padding: 0.15rem 0.4rem;
        border-radius: 0.5rem;
        background: #e2e8f0;
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        font-size: 0.92em;
      }
    </style>
  </head>
  <body>
    <main>
      <div>Cloudflare Pages / Multi Slidev Decks</div>
      <h1>배포된 슬라이드 덱 목록</h1>
      <p>
        <code>slides/*.md</code> 파일은 각각 같은 이름의 하위 경로로 배포됩니다.
        새 덱을 추가한 뒤 <code>bun run build:pages</code>만 실행하면 목록도 자동 갱신됩니다.
      </p>
      <section class="deck-grid">
${items}
      </section>
    </main>
  </body>
</html>
`
}

function renderNotFound(decks) {
  const links = decks.map(({ deckId, title }) =>
    `<li><a href="/${deckId}/">${escapeHtml(title)} <span>/${deckId}/</span></a></li>`,
  ).join('\n')

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Not Found</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "Noto Sans KR", system-ui, sans-serif;
        background: #0f172a;
        color: white;
      }
      article {
        width: min(720px, calc(100vw - 48px));
        padding: 32px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 24px;
        background: rgba(15, 23, 42, 0.72);
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(2rem, 4vw, 3rem);
      }
      p {
        margin: 0 0 24px;
        line-height: 1.7;
        color: rgba(255, 255, 255, 0.78);
      }
      ul {
        margin: 0;
        padding-left: 1.25rem;
      }
      li + li {
        margin-top: 10px;
      }
      a {
        color: #67e8f9;
      }
      span {
        opacity: 0.72;
      }
    </style>
  </head>
  <body>
    <article>
      <h1>요청한 경로를 찾지 못했습니다.</h1>
      <p>아래 덱 목록으로 이동하거나 올바른 하위 경로인지 확인해 주세요.</p>
      <ul>
        ${links}
      </ul>
    </article>
  </body>
</html>
`
}

function runCommand(command, args, envOverrides = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...envOverrides,
      },
    })

    child.on('exit', (code) => {
      if (code === 0)
        resolvePromise()
      else
        rejectPromise(new Error(`Command failed with exit code ${code}: ${command} ${args.join(' ')}`))
    })

    child.on('error', rejectPromise)
  })
}
