// core/notice_board.js
// what she has noticed and not yet said anything about.
//
// THE PROBLEM THIS EXISTS FOR. every perception in the minecraft path used to
// race independently for one global speech gap: whichever fired first took the
// slot, and everything else in that window was dropped on the floor and never
// looked at again. so a weather change could eat the turn a creeper at her back
// needed, and the loser did not come back when the winner turned out to be
// nothing. there was no point at which anything compared two noticings and
// asked which was actually worth her mouth.
//
// so: perceptions become CANDIDATES here instead of racing. they decay, they
// dedupe by kind, and when the gate opens the top few are handed over together
// for her to pick from - or ignore. losing is no longer fatal; a noticing that
// is still true can win the next opening, and one that has gone stale expires
// on its own.
//
// ⚠ A NOTICING IS A CUE, NEVER A LINE. `line` describes the situation in the
// first person so her brain can react to it; it is not words to say. the
// no-canned-responses rule applies here exactly as it does everywhere else.

// how long a noticing stays worth raising if nothing takes it. beyond this the
// moment has passed and saying it would be answering a question nobody is still
// asking.
const DEFAULT_TTL_MS = 90 * 1000;
// salience halves about every 45s, so a fresh mild noticing can overtake a
// strong stale one. this is what stops the board becoming a backlog she works
// through late.
const HALF_LIFE_MS = 45 * 1000;
// small on purpose: this is a shortlist, not a journal. recent_events.js is
// where history lives.
const MAX_NOTICES = 12;

export class NoticeBoard {
    constructor({ max = MAX_NOTICES, ttlMs = DEFAULT_TTL_MS, halfLifeMs = HALF_LIFE_MS } = {}) {
        this.max = max;
        this.ttlMs = ttlMs;
        this.halfLifeMs = halfLifeMs;
        this.notices = new Map();   // kind -> notice. insertion-ordered, which breaks ties stably.
    }

    // record something worth possibly saying.
    //
    // ⚠ KIND IS THE DEDUPE KEY and it must be specific enough that two genuinely
    // different situations do not collide, and general enough that the SAME
    // situation re-observed every 2 seconds does not stack up twelve deep and
    // crowd the board out. "hostile_behind" is right; "hostile_behind_zombie_at_4.2m"
    // is a memory leak with extra steps.
    note(kind, line, salience = 0.5, { tags = [], ttlMs = null, at = Date.now() } = {}) {
        if (!kind || !line) return null;
        const existing = this.notices.get(kind);
        const notice = {
            kind,
            line,
            // a situation that persists is not more interesting for having
            // persisted, so a refresh keeps the HIGHER salience rather than
            // summing - otherwise standing next to a cow for a minute would
            // eventually out-shout a creeper.
            salience: Math.max(0, Math.min(1, existing ? Math.max(existing.salience, salience) : salience)),
            at,
            // ⚠ FIRST-SEEN is kept separately from `at`. the decay has to run
            // from when the situation STARTED, not from the last time telemetry
            // re-noticed it - otherwise a standing condition refreshes its own
            // urgency every 2 seconds and never expires.
            since: existing ? existing.since : at,
            tags: tags.slice(0, 6),
            ttlMs: ttlMs == null ? this.ttlMs : ttlMs
        };
        // re-inserting moves it to the end of the Map's order; delete first so a
        // refreshed notice does not keep an accidental tie-break advantage over
        // an older one that has not moved.
        this.notices.delete(kind);
        this.notices.set(kind, notice);
        this._evict();
        return notice;
    }

    // something stopped being true. the creeper wandered off, she got out of the
    // water, the mob she was cornered by is dead.
    // ⚠ THIS IS THE HALF EVERY BUFFER LIKE THIS FORGETS: without it she reacts
    // to a danger that resolved itself thirty seconds ago, which reads worse
    // than never having noticed it.
    clear(kind) { return this.notices.delete(kind); }

    has(kind) { return this.notices.has(kind); }

    // salience as it stands NOW: the recorded weight, decayed from when the
    // situation began.
    weight(notice, now = Date.now()) {
        const age = Math.max(0, now - notice.since);
        return notice.salience * Math.pow(0.5, age / this.halfLifeMs);
    }

    _expire(now) {
        for (const [kind, n] of this.notices) {
            if (now - n.at >= n.ttlMs) this.notices.delete(kind);
        }
    }

    // over cap, drop the least interesting - never the oldest. a FIFO here would
    // evict the creeper that has been at her back for a minute in favour of the
    // twelfth cow to wander past.
    _evict() {
        if (this.notices.size <= this.max) return;
        const now = Date.now();
        const ranked = [...this.notices.values()].sort((a, b) => this.weight(a, now) - this.weight(b, now));
        for (const n of ranked) {
            if (this.notices.size <= this.max) break;
            this.notices.delete(n.kind);
        }
    }

    // the shortlist, strongest first. expires stale ones on the way past, so a
    // read is also the cleanup - there is no separate tick to forget to run.
    top(limit = 3, { now = Date.now(), minWeight = 0 } = {}) {
        this._expire(now);
        return [...this.notices.values()]
            .map((n) => ({ notice: n, w: this.weight(n, now) }))
            .filter((x) => x.w >= minWeight)
            .sort((a, b) => b.w - a.w)
            .slice(0, Math.max(0, limit))
            .map((x) => x.notice);
    }

    // she has been handed these; do not offer them again. taking is SEPARATE
    // from reading on purpose - the caller reads to decide whether the gate is
    // worth opening at all, and only spends them once it has actually committed.
    take(notices) {
        for (const n of notices || []) this.notices.delete(n.kind);
        return notices || [];
    }

    size() { return this.notices.size; }
    clearAll() { this.notices.clear(); }
}

export default NoticeBoard;
