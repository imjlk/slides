<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { configs, useNav } from '@slidev/client'

type FeedbackKey = 'okay' | 'good' | 'great' | 'mindBlown'

enum ConnectionState {
	Connected = 'connected',
	Disconnected = 'disconnected',
	Error = 'error',
}

enum SendType {
	Reactions = 'reactions',
	SlideUpdate = 'slideupdate',
}

interface SlideUpdateState {
	mtype: SendType.SlideUpdate
	page: number | string
	click: number
	type: 'broadcast'
}

interface ReactionState {
	mtype: SendType.Reactions
	emoji: string
	type: 'broadcast'
	page: number | string
	slideTitle: string
	feedback: FeedbackKey
	positionX?: number
}

interface AnimatedEmoji {
	id: number
	emoji: string
	x: number
	delay: number
	scale: number
}

const { isPresenter, slides, currentPage, queryClicks, go } = useNav()

const socketState = ref<ConnectionState>(ConnectionState.Disconnected)
const animatedEmojis = ref<AnimatedEmoji[]>([])
const backgroundTone = ref<'light' | 'dark'>('dark')

let webSocket: WebSocket | undefined
let emojiCounter = 0

const emojiMap = computed(() => {
	const reactions = configs.liveReactions || {}
	return {
		okay: reactions.okay || '👀',
		good: reactions.good || '👍',
		great: reactions.great || '❤️',
		mindBlown: reactions.mindBlown || '🤯',
	}
})

function slugify(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max)
}

function resolvePresentationId() {
	const envValue = import.meta.env.VITE_SLIDEV_PRESENTATION_ID
	if (envValue)
		return envValue

	const segments = window.location.pathname.split('/').filter(Boolean)
	if (segments.length)
		return segments[0]

	return slugify(configs.title || 'slidev-deck')
}

function getWsUrl() {
	const server = (import.meta.env.VITE_SLIDEV_REACTIONS_SERVER || configs.liveReactions?.server || 'ws://localhost:8787')
		.replace('http://', 'ws://')
		.replace('https://', 'wss://')
		.replace(/\/+$/, '')

	const presentationId = resolvePresentationId()
	const url = new URL(`${server}/ws/${encodeURIComponent(presentationId)}`)
	url.searchParams.set('title', configs.title || presentationId)
	return url.toString()
}

function resolveViewportX(positionX?: number) {
	const viewportWidth = window.innerWidth
	const safeRatio = clamp(positionX ?? 0.84, 0.08, 0.92)
	return safeRatio * viewportWidth / getCurrentSlideScale()
}

function parseRgbChannels(color: string) {
	const match = color.match(/rgba?\(([^)]+)\)/)
	if (!match)
		return null

	const [red, green, blue, alpha = '1'] = match[1].split(',').map(value => value.trim())
	return {
		r: Number.parseFloat(red),
		g: Number.parseFloat(green),
		b: Number.parseFloat(blue),
		a: Number.parseFloat(alpha),
	}
}

function relativeLuminance(channel: number) {
	const value = channel / 255
	return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function detectBackgroundTone() {
	const candidates = [
		document.querySelector('.slidev-layout') as HTMLElement | null,
		document.querySelector('.slidev-slide-content') as HTMLElement | null,
		document.body,
	]

	for (const element of candidates) {
		if (!element)
			continue

		const channels = parseRgbChannels(getComputedStyle(element).backgroundColor)
		if (!channels || channels.a === 0)
			continue

		const luminance = 0.2126 * relativeLuminance(channels.r) + 0.7152 * relativeLuminance(channels.g) + 0.0722 * relativeLuminance(channels.b)
		backgroundTone.value = luminance > 0.72 ? 'light' : 'dark'
		return
	}

	backgroundTone.value = 'dark'
}

function getCurrentSlideScale() {
	const cssValue = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slidev-slide-scale'))
	return Number.isFinite(cssValue) && cssValue > 0 ? cssValue : 1
}

function addAnimatedEmoji(emoji: string, positionX?: number) {
	const x = resolveViewportX(positionX)
	const delay = Math.random() * 500
	const item = { id: emojiCounter++, emoji, x, delay, scale: getCurrentSlideScale() }

	animatedEmojis.value.push(item)

	window.setTimeout(() => {
		animatedEmojis.value = animatedEmojis.value.filter(candidate => candidate.id !== item.id)
	}, 2800)
}

function sendPayload(payload: ReactionState | SlideUpdateState) {
	if (!webSocket || webSocket.readyState !== WebSocket.OPEN)
		return

	webSocket.send(JSON.stringify(payload))
}

function resolveReactionPositionX(event: MouseEvent) {
	const target = event.currentTarget

	if (!(target instanceof HTMLElement))
		return 0.84

	const rect = target.getBoundingClientRect()
	const viewportWidth = Math.max(window.innerWidth, 1)
	const centerX = rect.left + rect.width / 2

	return clamp(centerX / viewportWidth, 0.08, 0.92)
}

function sendReaction(key: FeedbackKey, event: MouseEvent) {
	if (isPresenter.value)
		return

	const page = currentPage.value
	const slideTitle = slides.value[page - 1]?.meta.slide.title || `Slide ${page}`
	const emoji = emojiMap.value[key]
	const positionX = resolveReactionPositionX(event)

	sendPayload({
		mtype: SendType.Reactions,
		emoji,
		type: 'broadcast',
		page,
		slideTitle,
		feedback: key,
		positionX,
	})

	addAnimatedEmoji(emoji, positionX)
}

function broadcastSlideUpdate() {
	if (!isPresenter.value)
		return

	sendPayload({
		mtype: SendType.SlideUpdate,
		page: currentPage.value,
		click: queryClicks.value,
		type: 'broadcast',
	})
}

function handleMessage(event: MessageEvent<string>) {
	try {
		const payload = JSON.parse(event.data) as ReactionState | SlideUpdateState

		if (payload.type !== 'broadcast' || isPresenter.value)
			return

		if (payload.mtype === SendType.SlideUpdate) {
			go(Number(payload.page), payload.click)
			return
		}

		if (payload.mtype === SendType.Reactions && Number(payload.page) === currentPage.value)
			addAnimatedEmoji(payload.emoji, payload.positionX)
	} catch {
		socketState.value = ConnectionState.Error
	}
}

function connect() {
	webSocket = new WebSocket(getWsUrl())

	webSocket.addEventListener('open', () => {
		socketState.value = ConnectionState.Connected
		broadcastSlideUpdate()
	})

	webSocket.addEventListener('message', handleMessage as EventListener)

	webSocket.addEventListener('close', () => {
		socketState.value = ConnectionState.Disconnected
	})

	webSocket.addEventListener('error', () => {
		socketState.value = ConnectionState.Error
	})
}

function disconnect() {
	webSocket?.close()
	webSocket = undefined
}

watch([currentPage, queryClicks], () => {
	broadcastSlideUpdate()
})

watch(currentPage, async () => {
	await nextTick()
	detectBackgroundTone()
})

onMounted(() => {
	detectBackgroundTone()
	connect()
})

onUnmounted(() => {
	disconnect()
})
</script>

<template>
	<div v-if="!isPresenter" class="reaction-bar">
		<button
			v-for="(emoji, key) in emojiMap"
			:key="key"
			type="button"
			class="reaction-button"
			:title="`${key} reaction`"
			@click="sendReaction(key as FeedbackKey, $event)"
		>
			{{ emoji }}
		</button>
		<span class="reaction-status" :data-state="socketState">{{ socketState }}</span>
	</div>

	<div class="emoji-stage" :data-background-tone="backgroundTone" aria-hidden="true">
		<div
			v-for="emoji in animatedEmojis"
			:key="emoji.id"
			class="animated-emoji"
			:style="{ left: `${emoji.x}px`, animationDelay: `${emoji.delay}ms`, '--reaction-item-scale': String(emoji.scale) }"
		>
			{{ emoji.emoji }}
		</div>
	</div>
</template>

<style scoped>
.reaction-bar {
	position: fixed;
	right: 20px;
	bottom: 18px;
	z-index: 1000;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 12px;
	border: 1px solid rgba(148, 163, 184, 0.2);
	border-radius: 999px;
	background: rgba(15, 23, 42, 0.72);
	backdrop-filter: blur(12px);
	box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
}

.reaction-button {
	width: 40px;
	height: 40px;
	border: 0;
	border-radius: 999px;
	background: rgba(255, 255, 255, 0.1);
	cursor: pointer;
	font-size: 22px;
	transition: transform 0.15s ease, background 0.15s ease;
}

.reaction-button:hover {
	transform: translateY(-1px) scale(1.04);
	background: rgba(255, 255, 255, 0.18);
}

.reaction-status {
	padding: 0 10px;
	font-size: 11px;
	font-weight: 700;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: rgba(255, 255, 255, 0.72);
}

.reaction-status[data-state='connected'] {
	color: #5eead4;
}

.reaction-status[data-state='error'] {
	color: #fca5a5;
}

.emoji-stage {
	position: fixed;
	inset: 0;
	z-index: 1100;
	pointer-events: none;
	overflow: hidden;
}

.animated-emoji {
	position: absolute;
	bottom: calc(88px / var(--reaction-item-scale, 1));
	display: grid;
	place-items: center;
	width: calc(3.4rem / var(--reaction-item-scale, 1));
	height: calc(3.4rem / var(--reaction-item-scale, 1));
	margin-left: calc(-1.7rem / var(--reaction-item-scale, 1));
	border-radius: 999px;
	font-size: calc(2rem / var(--reaction-item-scale, 1));
	text-shadow:
		0 1px 0 rgba(255, 255, 255, 0.4),
		0 8px 18px rgba(15, 23, 42, 0.35);
	background: rgba(15, 23, 42, 0.24);
	border: 1px solid rgba(255, 255, 255, 0.28);
	box-shadow:
		0 18px 30px rgba(15, 23, 42, 0.22),
		inset 0 1px 0 rgba(255, 255, 255, 0.24);
	backdrop-filter: blur(10px) saturate(1.1);
	animation: float-up 2.8s ease-out forwards;
}

.emoji-stage[data-background-tone='light'] .animated-emoji {
	background: rgba(15, 23, 42, 0.62);
	border-color: rgba(255, 255, 255, 0.42);
	box-shadow:
		0 18px 34px rgba(15, 23, 42, 0.3),
		inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.emoji-stage[data-background-tone='dark'] .animated-emoji {
	background: rgba(255, 255, 255, 0.18);
	border-color: rgba(255, 255, 255, 0.18);
}

@keyframes float-up {
	0% {
		transform: translateY(0) scale(0.92);
		opacity: 0;
	}

	12% {
		opacity: 1;
	}

	100% {
		transform: translateY(-68vh) scale(1.08);
		opacity: 0;
	}
}
</style>
