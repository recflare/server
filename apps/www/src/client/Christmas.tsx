import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { CSSProperties, ReactNode, RefObject } from 'react'

/**
 * The November 1st thaw.
 *
 * Until `REVEAL_AT` the homepage (`/` only) is a countdown with Santa frozen in a block of
 * ice. Cracks form in it as the time runs down, each with a sound, and at 12:00 AM Eastern the
 * ice breaks, the whole site is flashed with frost, and the frost melts away on a Christmas
 * site: 8-bit snow, Santa flying across the top, and a few secrets. The Christmas overlay
 * retires by itself at `CHRISTMAS_ENDS`.
 *
 * Nobody can start it early. The moment is one fixed instant, the page reads the time from the
 * server (not the visitor's clock, which they could change), and nothing in the page cracks the
 * ice for them. This is a front-end effect, so a determined visitor with the developer tools
 * open can still peek; what it rules out is anyone doing it by clicking or by changing a clock.
 *
 * Two pieces are mounted from App.tsx and share one tiny store (below), so they agree on what
 * phase it is without threading state through the router:
 *   - {@link XmasHome} stands in for the homepage while it is still frozen;
 *   - {@link ChristmasLayer} is global, like the Halloween overlay: the ice flash, then the snow.
 *
 * On the dev server only: `?xmas=preview` runs a 15 second countdown, `?xmas=on` skips to the
 * Christmas site and `?xmas=off` hides it all. The live site ignores all three.
 *
 * Sound effects are synthesised in the browser (Web Audio), so there are no files for them. The
 * song is `apps/www/public/audio/all-i-want-for-christmas-is-you.mp3`, scheduled on the audio
 * clock so that its beat drop (at `SONG_DROP_AT` seconds in) lands on the instant the ice breaks:
 * it starts that long before zero, and a visitor who turns sound on late is dropped in at the
 * right place in the track. Browsers only allow sound once the visitor has touched the page, so
 * the effects and the song are for whoever has tapped "enable sound" (or knocked on the ice).
 */

const SANTA_FULL = new URL('./christmas/santa-sleigh.png', import.meta.url).href
const SANTA_FROZEN = new URL('./christmas/santa-frozen.png', import.meta.url).href
const SONG_URL = '/audio/all-i-want-for-christmas-is-you.mp3'

/**
 * When the ice breaks: 12:00 AM Eastern on November 1st, 2026, one instant for everybody. The
 * clocks in New York only go back at 2 AM that day, so midnight is still daylight time and this
 * is 04:00 UTC. (Literal "EST", UTC-5, would be 1:00 AM on a New York clock.)
 */
const REVEAL_AT = Date.UTC(2026, 10, 1, 4, 0, 0)
/** The Christmas overlay stops showing itself after this: midnight Eastern, January 7th 2027. */
const CHRISTMAS_ENDS = Date.UTC(2027, 0, 7, 5, 0, 0)
/** The `?xmas=` shortcuts exist on the dev server only: on the live site no one can start it early. */
const DEV = import.meta.env.DEV

const OFF_KEY = 'rf_xmas_off'
const MUTE_KEY = 'rf_xmas_muted'
const PREVIEW_SECONDS = 15
/** Where the beat drops in the song, in seconds: it starts this long before the ice breaks. */
const SONG_DROP_AT = 51
/** Seconds left at which each crack appears in the ice: an hour, 15 minutes, 5 minutes, a minute. */
const CRACK_AT = [3600, 900, 300, 60]
const PREVIEW_CRACK_AT = [12, 9, 6, 3]
/** Each snow pixel is this many screen pixels wide: the canvas is small and scaled up, hard-edged. */
const SNOW_SCALE = 3

/** `wait` is the moment before the server has told us what time it really is. */
type Phase = 'wait' | 'countdown' | 'cracking' | 'frost' | 'thaw' | 'christmas' | 'off'

const vars = (o: Record<string, string | number>) => o as CSSProperties

const reducedMotion = () =>
	typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** How long each stage of the reveal lasts, in ms. Shortened for anyone who asks for less motion. */
const timings = () =>
	reducedMotion() ? { crack: 500, frost: 600, thaw: 600 } : { crack: 2400, frost: 1700, thaw: 1500 }

function readFlag(key: string): boolean {
	try {
		return localStorage.getItem(key) === '1'
	} catch {
		return false
	}
}

function writeFlag(key: string, on: boolean) {
	try {
		if (on) localStorage.setItem(key, '1')
		else localStorage.removeItem(key)
	} catch {
		// Storage can be unavailable; the choice still holds for this visit.
	}
}

// ---- The shared phase ---------------------------------------------------------------------

interface Store {
	phase: Phase
	/** `live` follows the real clock; `preview` is the dev countdown; `fixed` is `?xmas=on|off`. */
	mode: 'live' | 'preview' | 'fixed'
	revealAt: number
	/** Set once the ice has started to break on this page, so a clock correction can't undo it. */
	revealing: boolean
	/** Where the frost spreads from: the middle of the ice cube. */
	origin: { x: number; y: number }
}

let store: Store | null = null
const listeners = new Set<() => void>()

function initialStore(): Store {
	const params = DEV ? new URLSearchParams(window.location.search) : null
	const mode = params?.get('xmas') ?? null
	// `?xmas=preview&secs=90` is a longer run, to hear the song's lead-in.
	const previewSeconds = Number(params?.get('secs')) || PREVIEW_SECONDS
	const origin = { x: window.innerWidth / 2, y: window.innerHeight * 0.5 }
	const base = { revealing: false, origin }
	if (mode === 'off') return { ...base, phase: 'off', mode: 'fixed', revealAt: 0 }
	if (mode === 'on') return { ...base, phase: 'christmas', mode: 'fixed', revealAt: 0 }
	if (mode === 'preview') {
		return {
			...base,
			phase: 'countdown',
			mode: 'preview',
			revealAt: Date.now() + previewSeconds * 1000,
		}
	}
	return { ...base, phase: 'wait', mode: 'live', revealAt: REVEAL_AT }
}

function current(): Store {
	store ??= initialStore()
	return store
}

function setPhase(phase: Phase) {
	current().phase = phase
	for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

// ---- The clock: the server's, not the visitor's --------------------------------------------

/** The server's time minus this device's clock, in ms. Zero until the first sync. */
let skew = 0

const serverNow = () => Date.now() + skew

/**
 * Ask the server what time it is, from the `Date` header of a cheap request.
 *
 * The header is only to the second, so one answer is good to about half a second. Asked several
 * times a little apart, the answers pin it down: each says the server's time was somewhere in
 * the second it names, and was made between our send and our receive, which bounds the skew
 * from both sides. The seconds tick over during the run, and every answer on either side of a
 * tick narrows the bounds, so the intersection ends up within a few tens of milliseconds. That
 * matters because the song's beat drop is aimed at the moment the ice breaks.
 *
 * `onFirst` runs after the first answer, so the page can settle without waiting for the rest.
 * Returns false when the server could not be reached.
 */
async function syncClock(onFirst?: () => void): Promise<boolean> {
	let lo = -Infinity
	let hi = Infinity
	let answers = 0
	let quickest: { rtt: number; skew: number } | null = null
	for (let i = 0; i < 12 && (i < 3 || hi - lo > 120); i++) {
		if (i > 0) await new Promise((resolve) => window.setTimeout(resolve, 137))
		try {
			const sent = Date.now()
			const res = await fetch('/', { method: 'HEAD', cache: 'no-store' })
			const got = Date.now()
			const at = Date.parse(res.headers.get('date') ?? '')
			if (Number.isNaN(at)) continue
			// A copy served from a cache says how old it is; its Date is when it was made.
			const made = at + Number(res.headers.get('age') ?? 0) * 1000
			lo = Math.max(lo, made - got)
			hi = Math.min(hi, made + 999 - sent)
			const rtt = got - sent
			if (!quickest || rtt < quickest.rtt) quickest = { rtt, skew: made + 500 - (sent + rtt / 2) }
			answers += 1
			if (answers === 1) {
				skew = quickest.skew
				onFirst?.()
			}
		} catch {
			// Try again; the device clock is the fallback.
		}
	}
	if (!quickest) return false
	// Bounds that contradict each other mean a slow answer misled us; trust the quickest one.
	skew = lo <= hi ? (lo + hi) / 2 : quickest.skew
	return true
}

/** What phase the (server) clock says it should be. */
function phaseForNow(): Phase {
	const t = serverNow()
	if (t < REVEAL_AT) return 'countdown'
	return t < CHRISTMAS_ENDS ? 'christmas' : 'off'
}

/** Settle `wait` once we know the time, and take back a Christmas that a wrong clock jumped to. */
function reconcile() {
	const s = current()
	if (s.mode !== 'live') return
	const should = phaseForNow()
	if (s.phase === 'wait') setPhase(should)
	else if (s.phase === 'christmas' && should === 'countdown' && !s.revealing) setPhase('countdown')
}

let controller: number | undefined
let armed = false

/** One timer for the whole page: it syncs the clock, starts the song, and notices zero. */
function ensureController() {
	if (controller !== undefined) return
	if (current().mode === 'live') {
		// If the server doesn't answer, the device clock decides rather than hanging on a blank page.
		const giveUp = window.setTimeout(reconcile, 2500)
		void syncClock(() => {
			window.clearTimeout(giveUp)
			reconcile()
		})
		window.setInterval(() => void syncClock().then(reconcile), 120_000)
	}
	controller = window.setInterval(() => {
		const s = current()
		maybeStartSong()
		if (s.phase !== 'countdown') return
		const ms = s.revealAt - serverNow()
		if (ms <= 0) beginReveal()
		else if (ms < 400 && !armed) {
			// Close enough that a poll could be late: set the timer to the exact moment instead.
			armed = true
			window.setTimeout(beginReveal, ms)
		}
	}, 200)
}

function beginReveal() {
	const s = current()
	if (s.phase !== 'countdown') return
	s.revealing = true
	const cube = document.querySelector('[data-xmas-cube]')
	if (cube) {
		const r = cube.getBoundingClientRect()
		s.origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
	}
	const t = timings()
	setPhase('cracking')
	sfxRumble(t.crack / 1000)
	window.setTimeout(() => {
		sfxShatter()
		setPhase('frost')
	}, t.crack)
	window.setTimeout(() => setPhase('thaw'), t.crack + t.frost)
	window.setTimeout(() => setPhase('christmas'), t.crack + t.frost + t.thaw)
}

function useXmasPhase(): Phase {
	const phase = useSyncExternalStore(
		subscribe,
		() => current().phase,
		() => 'off' as Phase
	)
	useEffect(() => ensureController(), [])
	return phase
}

function useNow(everyMs: number): number {
	const [now, setNow] = useState(() => serverNow())
	useEffect(() => {
		const id = window.setInterval(() => setNow(serverNow()), everyMs)
		return () => window.clearInterval(id)
	}, [everyMs])
	return now
}

// ---- Sound --------------------------------------------------------------------------------

// The effects are made here rather than loaded: noise through filters for the cracks and the
// rumble, short sine pings for the glassy ring. No files, nothing to host or license.

let ac: AudioContext | null = null
let soundUnlocked = false
let noise: AudioBuffer | null = null

/** Made on a tap: a browser keeps an AudioContext silent until the visitor has touched the page. */
function unlockAudio() {
	try {
		ac ??= new AudioContext()
		void ac.resume()
		soundUnlocked = true
	} catch {
		// No Web Audio here: the effects stay silent.
	}
}

/** The audio context, but only when sound is allowed right now: tapped on, running, not muted. */
const sfx = (): AudioContext | null =>
	ac !== null && ac.state === 'running' && !readFlag(MUTE_KEY) ? ac : null

function noiseBuffer(c: AudioContext): AudioBuffer {
	if (!noise) {
		noise = c.createBuffer(1, c.sampleRate, c.sampleRate)
		const data = noise.getChannelData(0)
		for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
	}
	return noise
}

interface Burst {
	type: BiquadFilterType
	freq: number
	/** Sweep the filter to this by the end. */
	to?: number
	dur: number
	gain: number
	/** Seconds from now. */
	at?: number
	/** Build up to the peak instead of starting on it: a rumble rather than a crack. */
	swell?: boolean
}

/** Filtered noise: the body of a crack, a rumble, a shatter. Never throws: sound must not stall the thaw. */
function burst(o: Burst) {
	const c = sfx()
	if (!c) return
	try {
		const t = c.currentTime + (o.at ?? 0)
		const src = c.createBufferSource()
		src.buffer = noiseBuffer(c)
		// The buffer is a second long; looping it lets a rumble run as long as it likes.
		src.loop = true
		const filter = c.createBiquadFilter()
		filter.type = o.type
		filter.frequency.setValueAtTime(o.freq, t)
		if (o.to) filter.frequency.exponentialRampToValueAtTime(o.to, t + o.dur)
		const gain = c.createGain()
		gain.gain.setValueAtTime(0.0001, t)
		gain.gain.exponentialRampToValueAtTime(o.gain, t + (o.swell ? o.dur * 0.85 : 0.006))
		gain.gain.exponentialRampToValueAtTime(0.0001, t + o.dur)
		src.connect(filter).connect(gain).connect(c.destination)
		src.start(t, Math.random() * 0.4)
		src.stop(t + o.dur + 0.05)
	} catch (err) {
		// A browser that won't make the node: stay silent, but say why for whoever is debugging.
		console.warn('xmas sound effect failed', err)
	}
}

/** A short glassy ring. */
function ping(freq: number, at: number, dur: number, gain: number) {
	const c = sfx()
	if (!c) return
	try {
		const t = c.currentTime + at
		const osc = c.createOscillator()
		osc.type = 'sine'
		osc.frequency.setValueAtTime(freq, t)
		const g = c.createGain()
		g.gain.setValueAtTime(0.0001, t)
		g.gain.exponentialRampToValueAtTime(gain, t + 0.004)
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
		osc.connect(g).connect(c.destination)
		osc.start(t)
		osc.stop(t + dur + 0.05)
	} catch (err) {
		console.warn('xmas sound effect failed', err)
	}
}

/** The ice settling: one dry tick, for each of the last ten seconds. */
function sfxTick() {
	burst({ type: 'highpass', freq: 3800, dur: 0.035, gain: 0.1 })
}

/** Knocking on the ice. */
function sfxKnock() {
	ping(1900, 0, 0.2, 0.13)
	ping(2850, 0.02, 0.14, 0.08)
	burst({ type: 'lowpass', freq: 400, dur: 0.07, gain: 0.25 })
}

/** A new crack opening; each of the four is a little bigger. */
function sfxCrack(stage: number) {
	const big = 0.7 + stage * 0.15
	burst({ type: 'highpass', freq: 7000, to: 900, dur: 0.2, gain: 0.32 * big })
	burst({ type: 'lowpass', freq: 220, dur: 0.14, gain: 0.45 * big })
	ping(2400 + stage * 450, 0.03, 0.18, 0.06)
}

/** The ice groaning as it gives way. */
function sfxRumble(seconds: number) {
	burst({ type: 'lowpass', freq: 150, to: 260, dur: seconds, gain: 0.5, swell: true })
	for (let i = 0; i < 7; i++) {
		burst({
			type: 'highpass',
			freq: 6000,
			to: 1200,
			dur: 0.12,
			gain: 0.2,
			at: (seconds * (i + 1)) / 8,
		})
	}
}

/** The block breaking apart. */
function sfxShatter() {
	burst({ type: 'highpass', freq: 9000, to: 1800, dur: 0.9, gain: 0.5 })
	burst({ type: 'bandpass', freq: 3200, dur: 0.5, gain: 0.3, at: 0.03 })
	burst({ type: 'lowpass', freq: 90, dur: 0.7, gain: 0.65 })
	for (let i = 0; i < 14; i++) ping(2500 + ((i * 397) % 4200), 0.02 + i * 0.035, 0.28, 0.07)
}

// ---- The song -----------------------------------------------------------------------------

let songBuffer: AudioBuffer | null = null
let songLoading = false
let songStarted = false
let songGain: GainNode | null = null

/** Turn the sound on: wake the audio context and start fetching the track, once. */
function enableSound() {
	unlockAudio()
	loadSong()
}

/** Fetch and decode the track. With no file there, or one that won't decode, there is simply no song. */
function loadSong() {
	const c = ac
	if (!c || songBuffer || songLoading) return
	songLoading = true
	fetch(SONG_URL)
		.then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
		.then((bytes) => c.decodeAudioData(bytes))
		.then((decoded) => {
			songBuffer = decoded
		})
		.catch(() => {
			songLoading = false
		})
}

/** The track's volume follows the mute switch, so muting never loses its place in the song. */
function applyMute() {
	if (songGain) songGain.gain.value = readFlag(MUTE_KEY) ? 0 : 0.8
}

/**
 * Start the song so its beat drop lands on the moment the ice breaks. Runs on every tick of the
 * controller and does nothing until sound is on, the track is decoded, and the drop is within
 * `SONG_DROP_AT` seconds (plus a second's lead, to schedule it on the audio clock rather than
 * start it late). Everything is placed on the audio clock, which is sample-accurate, instead of
 * an `<audio>` element, whose start-up lag varies by a few hundred milliseconds.
 *
 * A visitor who turns sound on after the song should have begun is dropped into it at the right
 * place: the same arithmetic, with an offset into the track.
 */
function maybeStartSong() {
	const s = current()
	const c = ac
	if (songStarted || !songBuffer || !c || c.state !== 'running' || s.mode === 'fixed') return
	const toDrop = (s.revealAt - serverNow()) / 1000
	if (toDrop > SONG_DROP_AT + 1) return
	if (toDrop < -6) {
		// Long past the drop: this visitor missed it, and a song from the middle would only confuse.
		songStarted = true
		return
	}
	// What the speakers will add on top of the audio clock, so the sound meets the picture.
	const latency = c.outputLatency || c.baseLatency || 0
	const startAt = c.currentTime + toDrop - latency - SONG_DROP_AT
	const src = c.createBufferSource()
	src.buffer = songBuffer
	if (!songGain) {
		songGain = c.createGain()
		songGain.connect(c.destination)
		applyMute()
	}
	src.connect(songGain)
	const soonest = c.currentTime + 0.02
	if (startAt >= soonest) {
		src.start(startAt)
	} else {
		const into = soonest - startAt
		if (into >= songBuffer.duration) {
			songStarted = true
			return
		}
		src.start(soonest, into)
	}
	songStarted = true
}

function SoundChip() {
	const [, redraw] = useState(0)
	const ready = soundUnlocked
	const muted = readFlag(MUTE_KEY)
	const click = () => {
		enableSound()
		if (ready) {
			writeFlag(MUTE_KEY, !muted)
			applyMute()
		}
		redraw((n) => n + 1)
	}
	return (
		<button type="button" className="rf-xmas-sound" onClick={click}>
			{!ready ? '🔈 Tap to enable sound' : muted ? '🔇 Sound off' : '🔊 Sound on'}
		</button>
	)
}

/** After the thaw: a switch for the song, if there is one playing. */
function SongToggle() {
	const [muted, setMuted] = useState(() => readFlag(MUTE_KEY))
	if (!songStarted) return null
	return (
		<button
			type="button"
			className="rf-xmas-sound-toggle"
			onClick={() => {
				writeFlag(MUTE_KEY, !muted)
				setMuted(!muted)
				applyMute()
			}}
			title={muted ? 'Turn the music on' : 'Turn the music off'}
			aria-label={muted ? 'Turn the music on' : 'Turn the music off'}
		>
			{muted ? '🔇' : '🔊'}
		</button>
	)
}

// ---- Pixel digits -------------------------------------------------------------------------

const GLYPHS: Record<string, readonly string[]> = {
	'0': ['111', '101', '101', '101', '111'],
	'1': ['010', '110', '010', '010', '111'],
	'2': ['111', '001', '111', '100', '111'],
	'3': ['111', '001', '111', '001', '111'],
	'4': ['101', '101', '111', '001', '001'],
	'5': ['111', '100', '111', '001', '111'],
	'6': ['111', '100', '111', '101', '111'],
	'7': ['111', '001', '001', '010', '010'],
	'8': ['111', '101', '111', '101', '111'],
	'9': ['111', '101', '111', '001', '111'],
	':': ['0', '1', '0', '1', '0'],
}

function PixelText({ text }: { text: string }) {
	return (
		<span className="rf-px" aria-hidden="true">
			{text.split('').map((ch, i) => {
				const rows = GLYPHS[ch] ?? GLYPHS['0'] ?? []
				const width = rows[0]?.length ?? 1
				return (
					<span key={i} className="rf-px-glyph" style={vars({ '--cols': width })}>
						{rows
							.join('')
							.split('')
							.map((cell, j) => (
								<i key={j} className={cell === '1' ? 'on' : undefined} />
							))}
					</span>
				)
			})}
		</span>
	)
}

// ---- The frozen homepage ------------------------------------------------------------------

const STARS = Array.from({ length: 46 }, (_, i) => {
	const x = (i * 211 + 17) % 100
	const y = (i * 137 + 29) % 100
	return `${x}vw ${y}vh 0 ${i % 5 === 0 ? 1 : 0}px ${i % 7 === 0 ? '#ffe9a8' : '#cfe3ff'}`
}).join(',')

/** The crack marks in force for this page: the real ones, or the quick ones for the dev preview. */
const crackMarks = () => (current().mode === 'preview' ? PREVIEW_CRACK_AT : CRACK_AT)

/** Stands in for the homepage until the ice has broken and the frost has covered the site. */
export function XmasHome({ children }: { children: ReactNode }) {
	const phase = useXmasPhase()
	if (phase === 'wait') {
		// A beat while we ask the server the time, so a wrong clock can't flash the wrong page.
		return (
			<main
				className="rf-xmas-wait"
				aria-busy="true"
				style={{ minHeight: '80vh', background: '#0b1326' }}
			/>
		)
	}
	if (phase === 'countdown' || phase === 'cracking' || phase === 'frost') {
		return <CountdownPage phase={phase} />
	}
	return <>{children}</>
}

function CountdownPage({ phase }: { phase: Phase }) {
	const now = useNow(250)
	const [pulse, setPulse] = useState(false)
	const before = useRef<{ stage: number; left: number } | null>(null)

	const left = Math.max(0, Math.ceil((current().revealAt - now) / 1000))
	const h = Math.floor(left / 3600)
	const m = Math.floor((left % 3600) / 60)
	const s = left % 60
	const pad = (n: number) => String(n).padStart(2, '0')

	// How many cracks the ice has by now: one more at each mark.
	const stage = crackMarks().filter((at) => left <= at).length
	const tense = phase === 'countdown' && left <= 10

	// Sound goes with what the visitor watches happen: a crack when a new one opens, a tick in the
	// last ten seconds. Cracks that were already there when the page opened make no sound.
	useEffect(() => {
		const was = before.current
		before.current = { stage, left }
		if (!was || phase !== 'countdown') return
		if (stage > was.stage) sfxCrack(stage)
		else if (left < was.left && left >= 1 && left <= 10) sfxTick()
	}, [stage, left, phase])

	const classes = ['rf-ice-wrap', `h${stage}`]
	if (phase === 'cracking') classes.push('cracking')
	if (phase === 'frost') classes.push('gone')
	if (tense) classes.push('tense')
	if (pulse) classes.push('pulse')

	// Knocking on the ice makes a sound and nothing else: it does not hurry the thaw along.
	const knock = () => {
		enableSound()
		sfxKnock()
		setPulse(true)
		window.setTimeout(() => setPulse(false), 110)
	}

	return (
		<main className="rf-xmas-home">
			<div className="rf-xmas-stars" aria-hidden="true" style={vars({ '--stars': STARS })} />
			<h1 className="rf-xmas-title">Santa&rsquo;s stuck in the ice.</h1>
			<p className="rf-xmas-sub">
				He thaws at midnight Eastern on November 1st. Something might happen when he does.
			</p>
			<div
				role="timer"
				className="rf-xmas-clock"
				aria-label={`${h} hours, ${m} minutes and ${s} seconds left`}
			>
				<PixelText text={`${pad(h)}:${pad(m)}:${pad(s)}`} />
			</div>
			<div className="rf-xmas-units" aria-hidden="true">
				<span>hours</span>
				<span>minutes</span>
				<span>seconds</span>
			</div>
			<div className={classes.join(' ')} data-xmas-cube>
				<button
					type="button"
					className="rf-ice-cube"
					onClick={knock}
					title="Brrr…"
					aria-label="Santa, frozen in a block of ice"
				>
					<img src={SANTA_FROZEN} alt="" draggable={false} />
					<svg
						className="rf-cracks"
						viewBox="0 0 100 100"
						preserveAspectRatio="none"
						aria-hidden="true"
					>
						<path className="c1" pathLength="1" d="M50 50 L44 40 L48 30 L40 20 L42 6" />
						<path className="c2" pathLength="1" d="M50 50 L60 56 L58 66 L70 74 L66 88 L76 100" />
						<path className="c3" pathLength="1" d="M50 50 L36 58 L40 70 L28 78 L30 96" />
						<path className="c4" pathLength="1" d="M58 66 L48 74 L50 88 M44 40 L30 38 L22 28" />
						<path className="c5" pathLength="1" d="M50 50 L56 38 L52 28 L60 18 L58 2" />
						<path className="c6" pathLength="1" d="M50 50 L66 46 L74 52 L88 48 L100 54" />
						<path
							className="c7"
							pathLength="1"
							d="M36 58 L24 54 L14 60 L0 56 M70 74 L84 78 L92 90"
						/>
					</svg>
				</button>
			</div>
			<SoundChip />
		</main>
	)
}

// ---- The ice flash ------------------------------------------------------------------------

function IceReveal({ phase }: { phase: Phase }) {
	const shards = useMemo(
		() =>
			Array.from({ length: 20 }, (_, i) => {
				const angle = (i / 20) * Math.PI * 2 + (i % 3) * 0.2
				const dist = 140 + ((i * 37) % 280)
				return {
					dx: Math.round(Math.cos(angle) * dist),
					dy: Math.round(Math.sin(angle) * dist),
					rot: ((i * 67) % 360) - 180,
					size: 8 + ((i * 5) % 16),
				}
			}),
		[]
	)
	if (phase !== 'frost' && phase !== 'thaw') return null
	const { x, y } = current().origin
	const origin = vars({ '--ox': `${x}px`, '--oy': `${y}px` })
	return (
		<>
			<div className={`rf-frost ${phase}`} style={origin} aria-hidden="true" />
			{phase === 'frost' && (
				<div className="rf-shards" style={origin} aria-hidden="true">
					{shards.map((shard, i) => (
						<i
							key={i}
							style={vars({
								'--dx': `${shard.dx}px`,
								'--dy': `${shard.dy}px`,
								'--rot': `${shard.rot}deg`,
								width: shard.size,
								height: shard.size,
							})}
						/>
					))}
				</div>
			)}
		</>
	)
}

// ---- Snow ---------------------------------------------------------------------------------

/** 8-bit snowflakes: a dot, a plus, and a five-pixel star. */
const FLAKE_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
	[[0, 0]],
	[
		[1, 0],
		[0, 1],
		[1, 1],
		[2, 1],
		[1, 2],
	],
	[
		[2, 0],
		[1, 1],
		[3, 1],
		[0, 2],
		[2, 2],
		[4, 2],
		[1, 3],
		[3, 3],
		[2, 4],
	],
]

interface Flake {
	/** Position before the sway, in canvas pixels. */
	x: number
	y: number
	/** Fall speed, canvas pixels a second. */
	vy: number
	amp: number
	phase: number
	sway: number
	kind: number
	gold: boolean
	/** Where it was last drawn, for the golden-flake click test. */
	rx: number
	ry: number
}

interface SnowControl {
	blizzardUntil: number
}

function Snowfall({
	control,
	say,
}: {
	control: RefObject<SnowControl>
	say: (text: string) => void
}) {
	const ref = useRef<HTMLCanvasElement>(null)

	useEffect(() => {
		const canvas = ref.current
		const ctx = canvas?.getContext('2d')
		if (!canvas || !ctx) return
		const reduced = reducedMotion()
		let W = 1
		let H = 1
		const flakes: Flake[] = []
		const sparks: Array<{ x: number; y: number; vx: number; vy: number; life: number }> = []
		let caught = 0

		const spawn = (anywhere: boolean): Flake => {
			const kind = Math.random() < 0.55 ? 0 : Math.random() < 0.65 ? 1 : 2
			return {
				x: Math.random() * W,
				y: anywhere ? Math.random() * H : -6,
				vy: (kind === 0 ? 14 : kind === 1 ? 20 : 28) + Math.random() * 10,
				amp: 2 + Math.random() * 5,
				phase: Math.random() * 6.28,
				sway: 0.6 + Math.random() * 1.2,
				kind,
				// Rare, and only the big ones, so there is something to look for.
				gold: kind === 2 && Math.random() < 0.12,
				rx: 0,
				ry: 0,
			}
		}

		const target = () => {
			const base = Math.min(130, Math.max(36, (window.innerWidth * window.innerHeight) / 17000))
			const storm = (control.current?.blizzardUntil ?? 0) > Date.now()
			return Math.round((storm ? base * 3 : base) / (reduced ? 3 : 1))
		}

		const resize = () => {
			W = Math.ceil(window.innerWidth / SNOW_SCALE)
			H = Math.ceil(window.innerHeight / SNOW_SCALE)
			canvas.width = W
			canvas.height = H
		}
		resize()
		while (flakes.length < target()) flakes.push(spawn(true))

		const draw = (t: number) => {
			ctx.clearRect(0, 0, W, H)
			for (const f of flakes) {
				f.rx = Math.floor(f.x + Math.sin(t * f.sway + f.phase) * f.amp)
				f.ry = Math.floor(f.y)
				const twinkle = f.gold && Math.floor(t * 6) % 2 === 0
				ctx.fillStyle = f.gold
					? twinkle
						? '#fff3a0'
						: '#ffc928'
					: f.kind === 0
						? '#cfe6ff'
						: '#ffffff'
				for (const [dx, dy] of FLAKE_SHAPES[f.kind] ?? []) ctx.fillRect(f.rx + dx, f.ry + dy, 1, 1)
			}
			ctx.fillStyle = '#ffd84a'
			for (const p of sparks) ctx.fillRect(Math.floor(p.x), Math.floor(p.y), 1, 1)
		}

		let last = performance.now()
		let raf = 0
		const frame = (now: number) => {
			const dt = Math.min(0.05, (now - last) / 1000)
			last = now
			const storm = (control.current?.blizzardUntil ?? 0) > Date.now()
			const speed = storm ? 2.6 : 1
			const wind = storm ? 34 : 0
			const want = target()
			for (let i = flakes.length - 1; i >= 0; i--) {
				const f = flakes[i]
				if (!f) continue
				f.y += f.vy * speed * dt
				f.x += wind * dt
				if (f.y > H + 6 || f.x > W + 8) {
					if (flakes.length > want) flakes.splice(i, 1)
					else flakes[i] = spawn(false)
				}
			}
			while (flakes.length < want) flakes.push(spawn(false))
			for (let i = sparks.length - 1; i >= 0; i--) {
				const p = sparks[i]
				if (!p) continue
				p.x += p.vx * dt
				p.y += p.vy * dt
				p.vy += 40 * dt
				p.life -= dt
				if (p.life <= 0) sparks.splice(i, 1)
			}
			draw(now / 1000)
			raf = requestAnimationFrame(frame)
		}

		// A secret: golden flakes can be clicked. Three of them earns a wish.
		const onClick = (e: MouseEvent) => {
			const cx = e.clientX / SNOW_SCALE
			const cy = e.clientY / SNOW_SCALE
			for (const f of flakes) {
				if (!f.gold || Math.hypot(f.rx + 2 - cx, f.ry + 2 - cy) > 9) continue
				f.gold = false
				caught += 1
				for (let i = 0; i < 14; i++) {
					const a = (i / 14) * Math.PI * 2
					sparks.push({
						x: f.rx + 2,
						y: f.ry + 2,
						vx: Math.cos(a) * 30,
						vy: Math.sin(a) * 30 - 10,
						life: 0.7,
					})
				}
				if (caught >= 3) {
					caught = 0
					say('🌟 Three golden flakes. Santa owes you a wish.')
				} else {
					say(caught === 1 ? '✨ A golden snowflake!' : '✨✨ Two golden snowflakes...')
				}
				break
			}
		}

		if (reduced) draw(0)
		else raf = requestAnimationFrame(frame)
		const onResize = () => {
			resize()
			if (reduced) draw(0)
		}
		window.addEventListener('resize', onResize)
		window.addEventListener('click', onClick, true)
		return () => {
			cancelAnimationFrame(raf)
			window.removeEventListener('resize', onResize)
			window.removeEventListener('click', onClick, true)
		}
	}, [control, say])

	return <canvas ref={ref} className="rf-snow" aria-hidden="true" />
}

// ---- Santa flying over the top ------------------------------------------------------------

function FlyingSanta({ say }: { say: (text: string) => void }) {
	const ref = useRef<HTMLImageElement>(null)
	const [bubble, setBubble] = useState<{ x: number; y: number; key: number } | null>(null)
	const [gifts, setGifts] = useState<Array<{ id: number; x: number; y: number; dx: number }>>([])
	const clicks = useRef(0)

	useEffect(() => {
		const el = ref.current
		if (!el || reducedMotion()) return
		let cancelled = false
		let raf = 0
		let timer = 0
		let dir = 1

		// Driven by requestAnimationFrame, like the snow, rather than by the Web Animations API:
		// it needs nothing from the compositor, so it moves wherever the snow does.
		const fly = () => {
			if (cancelled) return
			const vw = window.innerWidth
			const w = el.offsetWidth
			const from = dir === 1 ? -w - 20 : vw + 20
			const to = dir === 1 ? vw + 20 : -w - 20
			// The sprite faces right, so the trip back is mirrored.
			const flip = dir === 1 ? 1 : -1
			const duration = Math.max(8000, Math.abs(to - from) * 9)
			const start = performance.now()
			el.style.visibility = 'visible'
			const step = (now: number) => {
				if (cancelled) return
				const p = Math.min(1, (now - start) / duration)
				const x = from + (to - from) * p
				// Two lazy bobs on the way across.
				const y = 8 + Math.sin(p * Math.PI * 4) * 9
				el.style.transform = `translate(${x}px, ${y}px) scaleX(${flip})`
				if (p < 1) {
					raf = requestAnimationFrame(step)
					return
				}
				el.style.visibility = 'hidden'
				dir *= -1
				timer = window.setTimeout(fly, 2000 + Math.random() * 5000)
			}
			raf = requestAnimationFrame(step)
		}
		timer = window.setTimeout(fly, 900)
		return () => {
			cancelled = true
			window.clearTimeout(timer)
			cancelAnimationFrame(raf)
		}
	}, [])

	// A secret: click Santa and he drops presents.
	const poke = () => {
		const r = ref.current?.getBoundingClientRect()
		if (!r) return
		clicks.current += 1
		const key = Date.now()
		setBubble({ x: r.left + r.width / 2, y: r.bottom + 4, key })
		window.setTimeout(() => setBubble((b) => (b?.key === key ? null : b)), 1900)
		const drop = Array.from({ length: 5 }, (_, i) => ({
			id: key + i,
			x: r.left + r.width * (0.3 + i * 0.1),
			y: r.bottom - 10,
			dx: (i - 2) * 22,
		}))
		setGifts((g) => [...g, ...drop])
		window.setTimeout(
			() => setGifts((g) => g.filter((x) => !drop.some((d) => d.id === x.id))),
			1900
		)
		if (clicks.current === 7) say('🎅 Okay okay, that is enough presents.')
	}

	return (
		<>
			<img
				ref={ref}
				src={SANTA_FULL}
				alt=""
				className="rf-flying-santa"
				draggable={false}
				onClick={poke}
			/>
			{bubble && (
				<div className="rf-santa-bubble" key={bubble.key} style={{ left: bubble.x, top: bubble.y }}>
					Ho ho ho!
				</div>
			)}
			{gifts.map((g) => (
				<span
					key={g.id}
					className="rf-gift"
					style={vars({ left: g.x, top: g.y, '--dx': `${g.dx}px` })}
				>
					🎁
				</span>
			))}
		</>
	)
}

// ---- The Christmas overlay ----------------------------------------------------------------

const KONAMI = [
	'ArrowUp',
	'ArrowUp',
	'ArrowDown',
	'ArrowDown',
	'ArrowLeft',
	'ArrowRight',
	'ArrowLeft',
	'ArrowRight',
	'b',
	'a',
]

function useKonami(onMatch: () => void) {
	useEffect(() => {
		let at = 0
		const onKey = (e: KeyboardEvent) => {
			const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
			at = key === KONAMI[at] ? at + 1 : key === KONAMI[0] ? 1 : 0
			if (at === KONAMI.length) {
				at = 0
				onMatch()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onMatch])
}

function Season() {
	const [off, setOff] = useState(() => readFlag(OFF_KEY))
	const [toast, setToast] = useState<{ text: string; key: number } | null>(null)
	const control = useRef<SnowControl>({ blizzardUntil: 0 })
	const say = useCallback((text: string) => setToast({ text, key: Date.now() }), [])

	useEffect(() => {
		if (!toast) return
		const t = window.setTimeout(() => setToast(null), 3800)
		return () => window.clearTimeout(t)
	}, [toast])

	// A secret: the Konami code whips up a blizzard.
	useKonami(
		useCallback(() => {
			control.current.blizzardUntil = Date.now() + 8000
			say('❄️ BLIZZARD!')
		}, [say])
	)

	const toggle = () => {
		writeFlag(OFF_KEY, !off)
		setOff(!off)
	}

	return (
		<>
			{!off && <Snowfall control={control} say={say} />}
			{!off && <FlyingSanta say={say} />}
			<SongToggle />
			<button
				type="button"
				className="rf-xmas-toggle"
				onClick={toggle}
				title={off ? 'Turn Christmas mode on' : 'Turn Christmas mode off'}
				aria-label={off ? 'Turn Christmas mode on' : 'Turn Christmas mode off'}
				style={{ opacity: off ? 0.5 : 1 }}
			>
				❄️
			</button>
			{toast && (
				<div className="rf-xmas-toast" key={toast.key} role="status">
					{toast.text}
				</div>
			)}
		</>
	)
}

/** Everything global: the ice flash, then the snow, Santa and the toggle. Mount once, near the Halloween overlay. */
export function ChristmasLayer() {
	const phase = useXmasPhase()
	if (phase === 'off' || phase === 'wait') return null
	return (
		<>
			<style>{CSS}</style>
			<IceReveal phase={phase} />
			{(phase === 'thaw' || phase === 'christmas') && <Season />}
		</>
	)
}

const FROST_PATTERN =
	"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56' shape-rendering='crispEdges'%3E%3Cg fill='%23fff' fill-opacity='.75'%3E%3Crect x='12' y='6' width='2' height='8'/%3E%3Crect x='9' y='9' width='8' height='2'/%3E%3Crect x='40' y='34' width='2' height='8'/%3E%3Crect x='37' y='37' width='8' height='2'/%3E%3Crect x='6' y='40' width='2' height='2'/%3E%3Crect x='46' y='10' width='2' height='2'/%3E%3C/g%3E%3C/svg%3E\")"

const CSS = `
@property --hole { syntax: '<length>'; inherits: false; initial-value: 0px; }

/* ---- the frozen homepage ---- */
.rf-xmas-home { position: relative; overflow: hidden; display: flex; flex-direction: column; align-items: center;
	min-height: 80vh; padding: 48px 20px 40px; text-align: center; color: #eaf6ff;
	background: radial-gradient(ellipse at 50% 28%, #1d2f55 0%, #0e1830 55%, #070b16 100%); }
.rf-xmas-stars { position: absolute; left: 0; top: 0; width: 2px; height: 2px; box-shadow: var(--stars);
	animation: rf-twinkle 3.2s steps(2) infinite; pointer-events: none; }
.rf-xmas-title { position: relative; margin: 0 0 6px; font-family: var(--display); font-size: clamp(30px, 6vw, 54px);
	line-height: 1.1; color: #eaf8ff; text-shadow: 3px 3px 0 #1a4a7a, 0 0 22px #5bb8ff66; }
.rf-xmas-sub { position: relative; margin: 0 0 26px; color: #a9c8e6; max-width: 34rem; }
.rf-xmas-clock { position: relative; }
.rf-px { display: inline-flex; gap: calc(var(--px) * 1.4); --px: clamp(7px, 1.9vw, 14px); }
.rf-px-glyph { display: grid; grid-template-columns: repeat(var(--cols), var(--px)); grid-auto-rows: var(--px); gap: 1px; }
.rf-px-glyph i { background: #0b1c33; }
.rf-px-glyph i.on { background: #e8f8ff; box-shadow: 0 0 8px #7fd0ff, inset -2px -2px 0 #9fd8f5; }
.rf-xmas-units { position: relative; display: flex; gap: clamp(28px, 7vw, 74px); margin: 10px 0 8px;
	font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: #7fa6cc; }

.rf-ice-wrap { position: relative; margin: 18px 0 64px; width: min(82vw, 290px);
	filter: drop-shadow(0 0 26px rgba(110, 195, 255, .5)); }
.rf-ice-wrap.pulse { transform: translate(2px, -1px); }
.rf-ice-wrap.gone { visibility: hidden; }
.rf-ice-cube { position: relative; display: block; width: 100%; padding: 28px 28px 24px; border: 0; cursor: pointer;
	color: inherit; overflow: hidden;
	background: linear-gradient(135deg, rgba(222, 246, 255, .6), rgba(120, 200, 245, .38) 46%, rgba(190, 232, 255, .55));
	box-shadow: inset 0 0 0 4px #e8f9ff, inset 0 0 0 8px #8fd0f2, inset 0 0 46px 8px rgba(255, 255, 255, .5);
	clip-path: polygon(0 14px, 14px 14px, 14px 0, calc(100% - 14px) 0, calc(100% - 14px) 14px, 100% 14px,
		100% calc(100% - 14px), calc(100% - 14px) calc(100% - 14px), calc(100% - 14px) 100%,
		14px 100%, 14px calc(100% - 14px), 0 calc(100% - 14px));
	animation: rf-shiver 4.6s steps(1) infinite; }
.rf-ice-cube img { display: block; width: 100%; height: auto; image-rendering: pixelated;
	filter: saturate(.7) brightness(1.06) hue-rotate(-8deg); }
.rf-ice-cube::before { content: ""; position: absolute; inset: 0; pointer-events: none;
	background: linear-gradient(115deg, transparent 26%, rgba(255, 255, 255, .6) 30%, rgba(255, 255, 255, .12) 37%,
		transparent 41%, transparent 62%, rgba(255, 255, 255, .38) 64%, transparent 69%); }
.rf-ice-cube::after { content: ""; position: absolute; inset: 0; pointer-events: none;
	background: rgba(105, 185, 255, .26); mix-blend-mode: screen; }
.rf-cracks { position: absolute; inset: 8px; width: calc(100% - 16px); height: calc(100% - 16px); pointer-events: none; z-index: 2; }
.rf-cracks path { fill: none; stroke: #f4fdff; stroke-width: 3; stroke-linecap: square; stroke-linejoin: miter;
	vector-effect: non-scaling-stroke; stroke-dasharray: 1; stroke-dashoffset: 1; opacity: 0;
	filter: drop-shadow(2px 2px 0 #1d5d94) drop-shadow(0 0 2px #6fc9ff); }
.rf-cracks path { transition: stroke-dashoffset .7s steps(7), opacity .1s; }
.rf-ice-wrap.h1 .c1,
.rf-ice-wrap.h2 .c1, .rf-ice-wrap.h2 .c2,
.rf-ice-wrap.h3 .c1, .rf-ice-wrap.h3 .c2, .rf-ice-wrap.h3 .c3,
.rf-ice-wrap.h4 .c1, .rf-ice-wrap.h4 .c2, .rf-ice-wrap.h4 .c3, .rf-ice-wrap.h4 .c4 { opacity: 1; stroke-dashoffset: 0; }
.rf-ice-wrap.tense { animation: rf-tremble .22s steps(2) infinite; }
.rf-ice-wrap.cracking { animation: rf-quake .16s steps(2) infinite; }
.rf-ice-wrap.cracking .rf-cracks path { opacity: 1; stroke-dashoffset: 0; transition: none; }
.rf-ice-wrap.cracking .c5, .rf-ice-wrap.cracking .c6, .rf-ice-wrap.cracking .c7 {
	stroke-dashoffset: 1; animation: rf-crack 1.5s steps(10) forwards; }
.rf-ice-wrap.cracking .c6 { animation-delay: .3s; }
.rf-ice-wrap.cracking .c7 { animation-delay: .7s; }
.rf-ice-wrap.cracking .rf-ice-cube { animation: none; filter: brightness(1.25); }
.rf-xmas-sound { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 20; padding: 8px 14px; border-radius: 999px; cursor: pointer;
	border: 1px solid #3b5f8c; background: #0f2140; color: #bcd8f2; font: inherit; font-size: 13px; }
.rf-xmas-sound:hover { border-color: #7fb8ee; color: #fff; }

/* ---- the ice flash ---- */
.rf-frost { position: fixed; inset: 0; z-index: 100050; pointer-events: all;
	background: radial-gradient(circle at var(--ox) var(--oy), #ffffff 0, #effcff 14%, #bfe9fc 42%, #86c9f0 100%);
	clip-path: circle(0px at var(--ox) var(--oy)); }
.rf-frost::before { content: ""; position: absolute; inset: 0; background-image: ${FROST_PATTERN}; background-size: 56px 56px; opacity: .7; }
.rf-frost::after { content: ""; position: absolute; inset: 0; pointer-events: none;
	box-shadow: inset 0 0 160px 50px rgba(255, 255, 255, .95), inset 0 0 40px 10px rgba(150, 215, 255, .8); }
.rf-frost.frost { animation: rf-frost-in .7s cubic-bezier(.2, .75, .25, 1) forwards; }
.rf-frost.thaw { clip-path: none; pointer-events: none;
	-webkit-mask-image: radial-gradient(circle at var(--ox) var(--oy), transparent var(--hole), #000 calc(var(--hole) + 110px));
	mask-image: radial-gradient(circle at var(--ox) var(--oy), transparent var(--hole), #000 calc(var(--hole) + 110px));
	animation: rf-thaw 1.5s ease-in forwards; }
.rf-shards { position: fixed; left: var(--ox); top: var(--oy); z-index: 100060; width: 0; height: 0; pointer-events: none; }
.rf-shards i { position: absolute; left: 0; top: 0; background: linear-gradient(135deg, #fff, #9fdcff);
	box-shadow: 0 0 6px #aee6ff; opacity: 0; animation: rf-shard .95s cubic-bezier(.1, .7, .3, 1) forwards; }

/* ---- the Christmas overlay ---- */
.rf-snow { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 9000; pointer-events: none;
	image-rendering: pixelated; }
.rf-flying-santa { position: fixed; left: 0; top: 6px; z-index: 9001; width: clamp(150px, 16vw, 230px); height: auto;
	image-rendering: pixelated; visibility: hidden; cursor: pointer; will-change: transform;
	filter: drop-shadow(0 6px 0 rgba(0, 0, 0, .25)); }
.rf-santa-bubble { position: fixed; z-index: 9002; transform: translateX(-50%); padding: 6px 12px; pointer-events: none;
	background: #fff; color: #7a1020; font-weight: 700; border: 3px solid #7a1020; box-shadow: 3px 3px 0 #0006;
	animation: rf-pop 1.9s steps(6) forwards; }
.rf-gift { position: fixed; z-index: 9002; font-size: 26px; pointer-events: none; animation: rf-fall 1.8s ease-in forwards; }
.rf-xmas-toggle { position: fixed; right: 12px; bottom: 12px; z-index: 9999; font-size: 20px; line-height: 1;
	padding: 6px 8px; border-radius: 999px; cursor: pointer; }
.rf-xmas-sound-toggle { position: fixed; right: 62px; bottom: 12px; z-index: 9999; font-size: 20px; line-height: 1;
	padding: 6px 8px; border-radius: 999px; cursor: pointer; }
.rf-xmas-toast { position: fixed; left: 50%; bottom: 28px; z-index: 9999; transform: translateX(-50%);
	padding: 10px 16px; max-width: 90vw; background: #10213d; color: #eaf6ff; border: 3px solid #8fd0f2;
	box-shadow: 4px 4px 0 #0008; font-weight: 600; animation: rf-toast 3.8s steps(8) forwards; }

@keyframes rf-twinkle { 50% { opacity: .45; } }
@keyframes rf-shiver { 0%, 92% { transform: none; } 94% { transform: translate(-2px, 0); } 96% { transform: translate(2px, 1px); } 98% { transform: translate(-1px, -1px); } }
@keyframes rf-tremble { 0% { transform: translate(-1px, 0); } 100% { transform: translate(1px, 0); } }
@keyframes rf-quake { 0% { transform: translate(-4px, 1px); } 100% { transform: translate(4px, -2px); } }
@keyframes rf-crack { to { stroke-dashoffset: 0; } }
@keyframes rf-frost-in { to { clip-path: circle(160vmax at var(--ox) var(--oy)); } }
@keyframes rf-thaw { from { --hole: 0px; opacity: 1; } 70% { opacity: 1; } to { --hole: 170vmax; opacity: 0; } }
@keyframes rf-shard { 0% { opacity: 1; transform: translate(0, 0) rotate(0); }
	100% { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(var(--rot)); } }
@keyframes rf-pop { 0% { opacity: 0; transform: translateX(-50%) scale(.6); } 15%, 80% { opacity: 1; transform: translateX(-50%) scale(1); } 100% { opacity: 0; } }
@keyframes rf-fall { 0% { opacity: 1; transform: translate(0, 0) rotate(0); }
	100% { opacity: 0; transform: translate(var(--dx), 70vh) rotate(260deg); } }
@keyframes rf-toast { 0% { opacity: 0; transform: translate(-50%, 14px); } 8%, 88% { opacity: 1; transform: translate(-50%, 0); } 100% { opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
	.rf-xmas-stars, .rf-ice-cube, .rf-ice-wrap.cracking, .rf-ice-wrap.tense { animation: none; }
	.rf-flying-santa { display: none; }
}
@media (prefers-color-scheme: light) {
	.rf-xmas-home { color: #eaf6ff; }
}
`
