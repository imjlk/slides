<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { configs, useNav } from '@slidev/client'

type FeedbackKey = 'okay' | 'good' | 'great' | 'mindBlown'

enum ConnectionState {
	Connecting = 'connecting',
	Connected = 'connected',
	Reconnecting = 'reconnecting',
	Offline = 'offline',
}

enum SendType {
	Reactions = 'reactions',
	SlideUpdate = 'slideupdate',
	Ping = 'ping',
	Pong = 'pong',
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
}

interface HeartbeatPingState {
	mtype: SendType.Ping
	type: 'heartbeat'
	ts: number
}

interface HeartbeatPongState {
	mtype: SendType.Pong
	type: 'heartbeat'
	ts: number
}

interface ConnectedState {
	type: 'connected'
	id: string
}

interface AnimatedEmoji {
	id: number
	emoji: string
	x: number
	bottom: number
	scale: number
	drift: number
}

interface QueuedReaction {
	createdAt: number
	payload: ReactionState
}

const HEARTBEAT_INTERVAL_MS = 10_000
const STALE_CONNECTION_TIMEOUT_MS = 25_000
const RECONNECT_DELAY_MAX_MS = 10_000
const REACTION_QUEUE_LIMIT = 10
const REACTION_QUEUE_TTL_MS = 15_000
const REACTION_QUEUE_FLUSH_INTERVAL_MS = 120
const REACTION_TAP_THROTTLE_MS = 180

type OutboundMessage = ReactionState | SlideUpdateState | HeartbeatPingState
type InboundMessage = ReactionState | SlideUpdateState | HeartbeatPongState | ConnectedState

const { isPresenter, slides, currentPage, queryClicks, go } = useNav()

const socketState = ref<ConnectionState>(ConnectionState.Connecting)
const animatedEmojis = ref<AnimatedEmoji[]>([])
const backgroundTone = ref<'light' | 'dark'>('dark')

let webSocket: WebSocket | undefined
let emojiCounter = 0
let heartbeatTimer: number | undefined
let reconnectTimer: number | undefined
let queueFlushTimer: number | undefined
let reconnectAttempts = 0
let lastReactionTapAt = 0
let lastServerActivityAt = 0
let isActive = false
let hasConnectedOnce = false
let queuedReactions: QueuedReaction[] = []

const intentionallyClosedSockets = new WeakSet<WebSocket>()

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

function getReactionStageRect() {
	const stage = document.querySelector('.emoji-stage') as HTMLElement | null
	const rect = stage?.getBoundingClientRect()

	if (rect && rect.width > 0 && rect.height > 0)
		return rect

	return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}

function resolveReactionAnchor(key?: FeedbackKey) {
	const scale = getCurrentSlideScale()
	const stageRect = getReactionStageRect()
	const selector = key ? `[data-reaction-key="${key}"]` : ''
	const button = selector ? document.querySelector(selector) as HTMLElement | null : null

	if (!button) {
		return {
			x: stageRect.width * 0.84 / scale,
			bottom: 76 / scale,
			scale,
		}
	}

	const rect = button.getBoundingClientRect()

	return {
		x: clamp(rect.left + rect.width / 2 - stageRect.left, 24, Math.max(24, stageRect.width - 24)) / scale,
		bottom: clamp(stageRect.bottom - rect.top + 4, 18, Math.max(18, stageRect.height - 18)) / scale,
		scale,
	}
}

function addAnimatedEmoji(emoji: string, key?: FeedbackKey) {
	const anchor = resolveReactionAnchor(key)
	const item = {
		id: emojiCounter++,
		emoji,
		x: anchor.x,
		bottom: anchor.bottom,
		scale: anchor.scale,
		drift: ((Math.random() * 14) - 7) / anchor.scale,
	}

	animatedEmojis.value.push(item)

	window.setTimeout(() => {
		animatedEmojis.value = animatedEmojis.value.filter(candidate => candidate.id !== item.id)
	}, 2800)
}

function sendPayload(payload: OutboundMessage) {
	if (!webSocket || webSocket.readyState !== WebSocket.OPEN)
		return false

	try {
		webSocket.send(JSON.stringify(payload))
		return true
	} catch {
		restartConnection({ immediate: true })
		return false
	}
}

function clearHeartbeatTimer() {
	if (heartbeatTimer === undefined)
		return

	window.clearInterval(heartbeatTimer)
	heartbeatTimer = undefined
}

function clearReconnectTimer() {
	if (reconnectTimer === undefined)
		return

	window.clearTimeout(reconnectTimer)
	reconnectTimer = undefined
}

function clearQueueFlushTimer() {
	if (queueFlushTimer === undefined)
		return

	window.clearTimeout(queueFlushTimer)
	queueFlushTimer = undefined
}

function canMaintainConnection() {
	if (!isActive)
		return false

	if (document.visibilityState === 'hidden')
		return false

	if (typeof navigator !== 'undefined' && 'onLine' in navigator && !navigator.onLine)
		return false

	return true
}

function getNextActiveState() {
	return hasConnectedOnce ? ConnectionState.Reconnecting : ConnectionState.Connecting
}

function isSocketOpen() {
	return webSocket?.readyState === WebSocket.OPEN
}

function isConnectionStale(referenceTime = Date.now()) {
	return lastServerActivityAt > 0 && referenceTime - lastServerActivityAt >= STALE_CONNECTION_TIMEOUT_MS
}

function isSocketHealthy(referenceTime = Date.now()) {
	return socketState.value === ConnectionState.Connected && isSocketOpen() && !isConnectionStale(referenceTime)
}

function markServerActivity() {
	lastServerActivityAt = Date.now()
}

function pruneQueuedReactions(referenceTime = Date.now()) {
	queuedReactions = queuedReactions
		.filter(item => referenceTime - item.createdAt <= REACTION_QUEUE_TTL_MS)
		.slice(-REACTION_QUEUE_LIMIT)
}

function flushQueuedReactions() {
	clearQueueFlushTimer()
	pruneQueuedReactions()

	if (!queuedReactions.length || !isSocketHealthy())
		return

	const nextReaction = queuedReactions[0]
	if (!sendPayload(nextReaction.payload)) {
		ensureActiveConnection({ immediate: true })
		return
	}

	queuedReactions = queuedReactions.slice(1)

	if (queuedReactions.length) {
		queueFlushTimer = window.setTimeout(() => {
			queueFlushTimer = undefined
			flushQueuedReactions()
		}, REACTION_QUEUE_FLUSH_INTERVAL_MS)
	}
}

function enqueueReaction(payload: ReactionState, createdAt = Date.now()) {
	pruneQueuedReactions(createdAt)
	queuedReactions.push({ createdAt, payload })
	pruneQueuedReactions(createdAt)
}

function startHeartbeatLoop() {
	clearHeartbeatTimer()

	if (!canMaintainConnection() || !isSocketOpen())
		return

	heartbeatTimer = window.setInterval(() => {
		if (!canMaintainConnection()) {
			goOffline()
			return
		}

		if (!isSocketOpen())
			return

		if (isConnectionStale()) {
			restartConnection()
			return
		}

		if (!sendPayload({
			mtype: SendType.Ping,
			type: 'heartbeat',
			ts: Date.now(),
		})) {
			restartConnection({ immediate: true })
		}
	}, HEARTBEAT_INTERVAL_MS)
}

function scheduleReconnect({ immediate = false, nextState = getNextActiveState() }: { immediate?: boolean, nextState?: ConnectionState } = {}) {
	if (!canMaintainConnection())
		return

	if (webSocket && (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING))
		return

	if (!immediate && reconnectTimer !== undefined)
		return

	clearReconnectTimer()

	if (!immediate)
		reconnectAttempts += 1

	socketState.value = nextState

	const delay = immediate
		? 0
		: Math.min(1000 * 2 ** Math.max(0, reconnectAttempts - 1), RECONNECT_DELAY_MAX_MS)

	reconnectTimer = window.setTimeout(() => {
		reconnectTimer = undefined
		connect()
	}, delay)
}

function closeSocket(socket: WebSocket | undefined, nextState: ConnectionState, reconnect = false, immediateReconnect = false) {
	clearHeartbeatTimer()
	clearReconnectTimer()
	clearQueueFlushTimer()

	if (socket)
		intentionallyClosedSockets.add(socket)

	if (webSocket === socket)
		webSocket = undefined

	lastServerActivityAt = 0
	socketState.value = nextState
	socket?.close()

	if (reconnect)
		scheduleReconnect({ immediate: immediateReconnect, nextState })
}

function ensureActiveConnection({ immediate = false } = {}) {
	if (!canMaintainConnection()) {
		socketState.value = ConnectionState.Offline
		return
	}

	if (isSocketOpen() && isConnectionStale()) {
		restartConnection({ immediate: true })
		return
	}

	scheduleReconnect({ immediate, nextState: getNextActiveState() })
}

function restartConnection({ immediate = false } = {}) {
	if (!canMaintainConnection()) {
		goOffline()
		return
	}

	closeSocket(webSocket, ConnectionState.Reconnecting, true, immediate)
}

function goOffline() {
	closeSocket(webSocket, ConnectionState.Offline)
}

function handleConnectionReady() {
	const shouldSyncSlide = socketState.value !== ConnectionState.Connected

	hasConnectedOnce = true
	reconnectAttempts = 0
	markServerActivity()
	socketState.value = ConnectionState.Connected
	startHeartbeatLoop()
	flushQueuedReactions()

	if (shouldSyncSlide)
		broadcastSlideUpdate()
}

function sendReaction(key: FeedbackKey) {
	if (isPresenter.value)
		return

	const now = Date.now()
	if (now - lastReactionTapAt < REACTION_TAP_THROTTLE_MS)
		return

	lastReactionTapAt = now

	const page = currentPage.value
	const slideTitle = slides.value[page - 1]?.meta.slide.title || `Slide ${page}`
	const emoji = emojiMap.value[key]
	const payload = {
		mtype: SendType.Reactions,
		emoji,
		type: 'broadcast',
		page,
		slideTitle,
		feedback: key,
	} satisfies ReactionState

	addAnimatedEmoji(emoji, key)
	pruneQueuedReactions(now)

	if (isSocketHealthy(now) && sendPayload(payload))
		return

	enqueueReaction(payload, now)
	ensureActiveConnection({ immediate: true })
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
		const payload = JSON.parse(event.data) as InboundMessage

		markServerActivity()
		handleConnectionReady()

		if (payload.type === 'connected' || payload.type === 'heartbeat')
			return

		if (payload.type !== 'broadcast' || isPresenter.value)
			return

		if (payload.mtype === SendType.SlideUpdate) {
			go(Number(payload.page), payload.click)
			return
		}

		if (payload.mtype === SendType.Reactions && Number(payload.page) === currentPage.value)
			addAnimatedEmoji(payload.emoji, payload.feedback)
	} catch {
		restartConnection({ immediate: true })
	}
}

function connect() {
	if (!canMaintainConnection())
		return

	if (webSocket && (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING))
		return

	clearReconnectTimer()

	const socket = new WebSocket(getWsUrl())
	webSocket = socket

	socket.addEventListener('open', () => {
		if (webSocket !== socket)
			return

		lastServerActivityAt = Date.now()
		startHeartbeatLoop()
		sendPayload({
			mtype: SendType.Ping,
			type: 'heartbeat',
			ts: Date.now(),
		})
	})

	socket.addEventListener('message', handleMessage as EventListener)

	socket.addEventListener('close', () => {
		const closedIntentionally = intentionallyClosedSockets.has(socket)
		if (closedIntentionally) {
			intentionallyClosedSockets.delete(socket)
			return
		}

		if (webSocket !== socket && webSocket !== undefined)
			return

		if (webSocket === socket)
			webSocket = undefined

		clearHeartbeatTimer()
		clearQueueFlushTimer()
		lastServerActivityAt = 0
		scheduleReconnect({ nextState: ConnectionState.Reconnecting })
	})

	socket.addEventListener('error', () => {
		if (webSocket !== socket)
			return

		restartConnection({ immediate: true })
	})
}

function disconnect() {
	goOffline()
}

function handleVisibilityChange() {
	if (document.visibilityState === 'visible') {
		ensureActiveConnection({ immediate: true })
		return
	}

	goOffline()
}

function handlePageShow() {
	ensureActiveConnection({ immediate: true })
}

function handlePageHide() {
	goOffline()
}

function handleOffline() {
	goOffline()
}

watch([currentPage, queryClicks], () => {
	broadcastSlideUpdate()
})

watch(currentPage, async () => {
	await nextTick()
	detectBackgroundTone()
})

onMounted(() => {
	isActive = true
	detectBackgroundTone()
	ensureActiveConnection({ immediate: true })
	document.addEventListener('visibilitychange', handleVisibilityChange)
	window.addEventListener('focus', handlePageShow)
	window.addEventListener('offline', handleOffline)
	window.addEventListener('pagehide', handlePageHide)
	window.addEventListener('pageshow', handlePageShow)
	window.addEventListener('online', handlePageShow)
})

onUnmounted(() => {
	isActive = false
	document.removeEventListener('visibilitychange', handleVisibilityChange)
	window.removeEventListener('focus', handlePageShow)
	window.removeEventListener('offline', handleOffline)
	window.removeEventListener('pagehide', handlePageHide)
	window.removeEventListener('pageshow', handlePageShow)
	window.removeEventListener('online', handlePageShow)
	goOffline()
})
</script>

<template>
	<div v-if="!isPresenter" class="reaction-bar">
		<button
			v-for="(emoji, key) in emojiMap"
			:key="key"
			type="button"
			class="reaction-button"
			:data-reaction-key="key"
			:title="`${key} reaction`"
			@click="sendReaction(key as FeedbackKey)"
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
			:style="{ left: `${emoji.x}px`, bottom: `${emoji.bottom}px`, '--reaction-item-scale': String(emoji.scale), '--reaction-drift': `${emoji.drift}px` }"
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

@media (orientation: landscape) and (max-height: 500px) and (hover: none) and (pointer: coarse) {
	.reaction-bar {
		right: 16px;
		bottom: 14px;
	}
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

.reaction-status[data-state='connecting'] {
	color: #93c5fd;
}

.reaction-status[data-state='reconnecting'] {
	color: #fcd34d;
}

.reaction-status[data-state='offline'] {
	color: rgba(255, 255, 255, 0.55);
}

.emoji-stage {
	position: fixed;
	inset: 0;
	z-index: 1100;
	pointer-events: none;
	overflow: hidden;
	--reaction-bubble-size: 5.45rem;
	--reaction-emoji-size: 3.2rem;
}

.animated-emoji {
	position: absolute;
	display: grid;
	place-items: center;
	width: calc(var(--reaction-bubble-size) / var(--reaction-item-scale, 1));
	height: calc(var(--reaction-bubble-size) / var(--reaction-item-scale, 1));
	border-radius: 999px;
	font-size: calc(var(--reaction-emoji-size) / var(--reaction-item-scale, 1));
	text-shadow:
		0 1px 0 rgba(255, 255, 255, 0.4),
		0 8px 18px rgba(15, 23, 42, 0.35);
	background: rgba(15, 23, 42, 0.24);
	border: 1px solid rgba(255, 255, 255, 0.28);
	box-shadow:
		0 18px 30px rgba(15, 23, 42, 0.22),
		inset 0 1px 0 rgba(255, 255, 255, 0.24);
	backdrop-filter: blur(10px) saturate(1.1);
	will-change: transform, opacity;
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

@media (hover: none) and (pointer: coarse) {
	.emoji-stage {
		--reaction-bubble-size: 2.55rem;
		--reaction-emoji-size: 1.5rem;
	}
}

@keyframes float-up {
	0% {
		transform: translate(-50%, 0) scale(0.9);
		opacity: 0;
	}

	12% {
		opacity: 1;
	}

	100% {
		transform: translate(
			calc(-50% + var(--reaction-drift, 0px)),
			calc(-42vh / var(--reaction-item-scale, 1))
		) scale(1.06);
		opacity: 0;
	}
}
</style>

<style>
@media (orientation: landscape) and (max-height: 500px) and (hover: none) and (pointer: coarse) {
	.slidev-slide-container > .absolute.bottom-0.left-0,
	.slidev-slide-container > .absolute.bottom-0.left-0 * {
		pointer-events: none !important;
		opacity: 0 !important;
	}
}
</style>
