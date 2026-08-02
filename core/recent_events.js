// node/tools/recent_events.js
// a tiny rolling log of notable game events so burnt can conceptualize what just
// happened (the last few minutes), not just the current snapshot. shared by the
// minecraft + tetris tools; surfaced as a "recently:" line in the mode context.

export class RecentEvents {
    constructor(cap = 60) {
        this.cap = cap;
        this.events = [];
        this._lastLabel = null;
        this._lastAt = 0;
    }

    // record a short past-tense label. dedupes an identical label within dedupeMs
    // so a burst (repeated damage, rapid line clears of the same size) doesn't flood.
    record(label, { dedupeMs = 2500 } = {}) {
        if (!label) return;
        const now = Date.now();
        if (label === this._lastLabel && now - this._lastAt < dedupeMs) {
            this._lastAt = now;
            return;
        }
        this.events.push({ label, at: now });
        if (this.events.length > this.cap) this.events.shift();
        this._lastLabel = label;
        this._lastAt = now;
    }

    recent(windowMs = 180000) {
        const cutoff = Date.now() - windowMs;
        return this.events.filter((e) => e.at >= cutoff);
    }

    // newest-first, "label (Xs/Xm ago)", capped. '' when nothing is recent.
    summary(windowMs = 180000, max = 8) {
        const now = Date.now();
        const items = this.recent(windowMs).slice(-max).reverse();
        if (!items.length) return '';
        return items.map((e) => {
            const ago = now - e.at;
            const t = ago < 15000 ? 'just now'
                : ago < 90000 ? `${Math.round(ago / 1000)}s ago`
                    : `${Math.round(ago / 60000)}m ago`;
            return `${e.label} (${t})`;
        }).join(', ');
    }

    clear() { this.events = []; this._lastLabel = null; this._lastAt = 0; }
}
