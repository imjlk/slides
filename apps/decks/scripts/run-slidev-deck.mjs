import { spawn } from 'node:child_process'
import { basename, extname, resolve } from 'node:path'

const [, , mode = 'dev', inputEntry = 'slides/service-domain-review.md', ...restArgs] = process.argv
const rootDir = process.cwd()
const entryPath = resolve(rootDir, inputEntry)
const deckId = basename(entryPath, extname(entryPath))
const bunxBin = process.platform === 'win32' ? 'bunx.cmd' : 'bunx'

const baseArgs = ['slidev']

if (mode === 'dev') {
	baseArgs.push(entryPath, '--open')
} else if (mode === 'export') {
	baseArgs.push('export', entryPath)
} else if (mode === 'build') {
	baseArgs.push('build', entryPath)
} else {
	throw new Error(`Unsupported mode: ${mode}`)
}

baseArgs.push(...restArgs)

const child = spawn(bunxBin, baseArgs, {
	cwd: rootDir,
	stdio: 'inherit',
	env: {
		...process.env,
		VITE_SLIDEV_PRESENTATION_ID: deckId,
	},
})

child.on('exit', (code) => {
	process.exit(code ?? 1)
})

child.on('error', (error) => {
	console.error(error)
	process.exit(1)
})
