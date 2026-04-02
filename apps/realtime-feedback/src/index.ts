import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { logger } from 'hono/logger';

type FeedbackType = 'okay' | 'good' | 'great' | 'mindBlown';
type BroadcastType = 'broadcast';
type HeartbeatType = 'heartbeat';
type ConnectedType = 'connected';

interface PresentationEntry {
	id: number;
	title: string;
	presentation_id: string;
}

interface SlideEntry {
	id: number;
	slide_id: number;
	slide_title: string;
	feedback_okay: number;
	feedback_good: number;
	feedback_great: number;
	feedback_mindBlown: number;
}

interface PresentationRegistration {
	presentationId: string;
	title: string;
}

interface SessionState {
	id?: string;
	reactionTimestamps?: number[];
}

enum SendType {
	REACTIONS = 'reactions',
	SLIDEUPDATE = 'slideupdate',
	PING = 'ping',
	PONG = 'pong',
}

interface SlideUpdateState {
	mtype: SendType.SLIDEUPDATE;
	page: number | string;
	click: number;
	type: BroadcastType;
}

interface ReactionState {
	mtype: SendType.REACTIONS;
	emoji: string;
	type: BroadcastType;
	page: number | string;
	slideTitle: string;
	feedback: FeedbackType;
}

interface HeartbeatPingState {
	mtype: SendType.PING;
	type: HeartbeatType;
	ts: number;
}

interface HeartbeatPongState {
	mtype: SendType.PONG;
	type: HeartbeatType;
	ts: number;
}

interface ConnectedState {
	type: ConnectedType;
	id: string;
}

const FEEDBACK_COLUMNS: Record<FeedbackType, string> = {
	okay: 'feedback_okay',
	good: 'feedback_good',
	great: 'feedback_great',
	mindBlown: 'feedback_mindBlown',
};

const REACTION_RATE_LIMIT_WINDOW_MS = 5000;
const REACTION_RATE_LIMIT_MAX = 12;

type SocketMessage = ReactionState | SlideUpdateState | HeartbeatPingState | HeartbeatPongState;

function parseSocketMessage(message: ArrayBuffer | string): SocketMessage | null {
	try {
		const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
		return JSON.parse(raw) as SocketMessage;
	} catch {
		return null;
	}
}

function normalizePresentationId(value: string | undefined): string {
	try {
		return decodeURIComponent(value ?? '').trim();
	} catch {
		return (value ?? '').trim();
	}
}

function normalizePresentationTitle(value: string | null | undefined, fallback: string): string {
	return (value ?? '').trim() || fallback;
}

export class Presentation extends DurableObject {
	sql: SqlStorage;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.sql = this.ctx.storage.sql;

		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS presentation (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				title TEXT NOT NULL,
				presentation_id TEXT NOT NULL UNIQUE
			)
		`);
	}

	getAllEntries(): PresentationEntry[] {
		const result = this.sql.exec('SELECT * FROM presentation ORDER BY id DESC');
		return result.toArray() as unknown as PresentationEntry[];
	}

	getEntry(presentationId: string): PresentationEntry | null {
		const result = this.sql.exec('SELECT * FROM presentation WHERE presentation_id = ?', presentationId).toArray() as unknown as PresentationEntry[];
		return result[0] ?? null;
	}

	upsertEntry(input: PresentationRegistration): PresentationEntry | null {
		const presentationId = normalizePresentationId(input.presentationId);
		const title = normalizePresentationTitle(input.title, presentationId);

		if (!presentationId)
			return null;

		const existing = this.getEntry(presentationId);

		if (!existing) {
			this.sql.exec('INSERT INTO presentation (title, presentation_id) VALUES (?, ?)', title, presentationId);
			return this.getEntry(presentationId);
		}

		if (existing.title !== title)
			this.sql.exec('UPDATE presentation SET title = ? WHERE presentation_id = ?', title, presentationId);

		return this.getEntry(presentationId);
	}
}

export class Slide extends DurableObject {
	session: Map<WebSocket, SessionState>;
	sql: SqlStorage;
	env: Env;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.session = new Map<WebSocket, SessionState>();
		this.sql = this.ctx.storage.sql;
		this.ctx.getWebSockets().forEach((ws) => {
			const session = this.normalizeSession(ws.deserializeAttachment() as SessionState | undefined);
			this.session.set(ws, session);
			ws.serializeAttachment(session);
		});
		this.env = env;

		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS slide (id INTEGER PRIMARY KEY AUTOINCREMENT, slide_id INTEGER, slide_title TEXT, feedback_okay INTEGER DEFAULT 0, feedback_good INTEGER DEFAULT 0, feedback_great INTEGER DEFAULT 0, feedback_mindBlown INTEGER DEFAULT 0)`
		);
	}

	getFeedback(): SlideEntry[] {
		const result = this.sql.exec('SELECT * FROM slide ORDER BY slide_id');
		return result.toArray() as unknown as SlideEntry[];
	}

	private normalizeSession(session?: SessionState): SessionState {
		return {
			id: session?.id,
			reactionTimestamps: Array.isArray(session?.reactionTimestamps)
				? session.reactionTimestamps.filter((value) => typeof value === 'number')
				: [],
		};
	}

	private createSession(): SessionState {
		return {
			id: crypto.randomUUID(),
			reactionTimestamps: [],
		};
	}

	private persistSession(ws: WebSocket, session: SessionState) {
		this.session.set(ws, session);
		ws.serializeAttachment(session);
	}

	private sendConnected(ws: WebSocket, session: SessionState) {
		if (!session.id)
			return;

		ws.send(JSON.stringify({ type: 'connected', id: session.id } satisfies ConnectedState));
	}

	private acceptReaction(session: SessionState) {
		const now = Date.now();
		const timestamps = (session.reactionTimestamps ?? []).filter((timestamp) => now - timestamp < REACTION_RATE_LIMIT_WINDOW_MS);

		if (timestamps.length >= REACTION_RATE_LIMIT_MAX) {
			session.reactionTimestamps = timestamps;
			return false;
		}

		timestamps.push(now);
		session.reactionTimestamps = timestamps;
		return true;
	}

	private addSlide(id: number, title: string) {
		const exists = this.sql.exec('SELECT * FROM slide WHERE slide_id = ?', id);
		if (exists.toArray()[0]) return 'Slide already exists';
		return this.sql.exec('INSERT INTO slide (slide_id, slide_title) VALUES (?, ?)', id, title).toArray();
	}

	private addFeedback(id: number, title: string, feedback: FeedbackType) {
		const exists = this.sql.exec('SELECT * FROM slide WHERE slide_id = ?', id);

		if (!FEEDBACK_COLUMNS[feedback])
			return;

		if (!exists.toArray()[0]) {
			this.addSlide(id, title);
		} else {
			this.sql.exec('UPDATE slide SET slide_title = ? WHERE slide_id = ?', title, id);
		}

		const feedbackColumn = FEEDBACK_COLUMNS[feedback];
		const query = `UPDATE slide SET ${feedbackColumn} = ${feedbackColumn} + 1 WHERE slide_id = ?`;
		this.sql.exec(query, id).toArray();
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const presentationId = normalizePresentationId(url.pathname.split('/').pop());
		const presentationTitle = normalizePresentationTitle(
			url.searchParams.get('title') ?? url.searchParams.get('presentationTitle'),
			presentationId
		);

		if (!presentationId)
			return new Response('Missing presentation id', { status: 400 });

		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);
		const session = this.createSession();
		this.ctx.acceptWebSocket(server);
		this.persistSession(server, session);
		this.sendConnected(server, session);

		const presentationStub = this.env.PRESENTATION.get(this.env.PRESENTATION.idFromName('presentation'));
		await presentationStub.upsertEntry({
			presentationId,
			title: presentationTitle,
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		const session = this.session.get(ws) ?? this.createSession();
		this.persistSession(ws, session);

		const receivedMessage = parseSocketMessage(message);
		if (!receivedMessage)
			return;

		if (receivedMessage.type === 'heartbeat') {
			if (receivedMessage.mtype === SendType.PING)
				ws.send(JSON.stringify({ type: 'heartbeat', mtype: SendType.PONG, ts: receivedMessage.ts } satisfies HeartbeatPongState));

			return;
		}

		const { page, type, mtype } = receivedMessage;

		if (type === 'broadcast' && mtype === 'reactions') {
			if (!this.acceptReaction(session)) {
				this.persistSession(ws, session);
				return;
			}

			this.persistSession(ws, session);
			const { slideTitle, feedback } = receivedMessage;
			this.addFeedback(Number(page), slideTitle, feedback);
			this.broadcast(ws, receivedMessage);
		}
		if (type === 'broadcast' && mtype === 'slideupdate')
			this.broadcast(ws, receivedMessage);
	}

	private broadcast(sender: WebSocket, message: ReactionState | SlideUpdateState) {
		const id = this.session.get(sender)?.id;

		for (let [ws] of this.session) {
			if (sender === ws) continue;
			ws.send(JSON.stringify({ ...message, id }));
		}
	}

	private close(ws: WebSocket) {
		this.session.delete(ws);
	}
	webSocketClose(ws: WebSocket) {
		this.close(ws);
	}
	webSocketError(ws: WebSocket) {
		this.close(ws);
	}
}

const app = new Hono<{ Bindings: Env }>();

app.use(logger());

app.get('/healthz', (c) => {
	return c.json({ ok: true });
});

app.get('/ws/:presentationId', async (c) => {
	const presentationId = normalizePresentationId(c.req.param('presentationId'));

	if (!presentationId) {
		return c.json({ error: 'presentationId is required' }, 400);
	}

	const slideId = c.env.SLIDE.idFromName(presentationId);
	const slideStub = c.env.SLIDE.get(slideId);

	return slideStub.fetch(c.req.raw);
});

app.get('/api/presentations', async (c) => {
	const id = c.env.PRESENTATION.idFromName('presentation');
	const stub = c.env.PRESENTATION.get(id);
	const result = await stub.getAllEntries();

	const formattedResult = result.map((entry) => {
		return {
			'No.': entry.id,
			Title: entry.title,
			Slug: entry.presentation_id,
			PresentationId: entry.presentation_id,
		};
	});

	return c.json(formattedResult);
});

app.get('/api/presentations/:presentationId', async (c) => {
	const presentationId = normalizePresentationId(c.req.param('presentationId'));
	const registryId = c.env.PRESENTATION.idFromName('presentation');
	const registryStub = c.env.PRESENTATION.get(registryId);
	const result = await registryStub.getEntry(presentationId);

	if (!result)
		return c.json({ error: 'Presentation not found' }, 404);

	return c.json({
		id: result.id,
		title: result.title,
		presentationId: result.presentation_id,
	});
});

type AppContext = Context<{ Bindings: Env }>;

async function getFeedbackResponse(c: AppContext, presentationId: string) {
	const id = c.env.SLIDE.idFromName(presentationId);
	const stub = c.env.SLIDE.get(id);
	const result = await stub.getFeedback();

	const formattedResult = result.map((entry) => {
		return {
			'Slide No.': entry.slide_id,
			Title: entry.slide_title,
			Okay: entry.feedback_okay,
			Good: entry.feedback_good,
			Great: entry.feedback_great,
			'Mind Blown': entry.feedback_mindBlown,
		};
	});

	return c.json(formattedResult);
}

app.get('/api/presentations/:presentationId/feedback', async (c) => {
	const presentationId = normalizePresentationId(c.req.param('presentationId'));

	if (!presentationId)
		return c.json({ error: 'presentationId is required' }, 400);

	return getFeedbackResponse(c, presentationId);
});

app.get('/api/feedback/:presentationId', async (c) => {
	const presentationId = normalizePresentationId(c.req.param('presentationId'));

	if (!presentationId)
		return c.json({ error: 'presentationId is required' }, 400);

	return getFeedbackResponse(c, presentationId);
});

export default app;
