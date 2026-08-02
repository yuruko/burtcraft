// Minecraft-specific subjective state for Burnt.
//
// These are not aliases for her global conversational mood. They describe how
// the current run feels to her and are deliberately derived from both objective
// telemetry and recent outcomes:
//   confidence - "can I handle the next thing?"
//   fear       - immediate perceived danger
//   security   - how prepared/protected I feel
//   fun        - engagement/novelty, not raw safety
//
// Values remain in [0, 100]. Telemetry pulls them gradually toward a grounded
// appraisal while events add short-lived emotional momentum. That combination
// lets a death matter without leaving her permanently terrified after respawn.

const DEFAULT_STATE = Object.freeze({
    confidence: 48,
    fear: 18,
    security: 42,
    fun: 58
});

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function carryingText(gameState = {}) {
    const names = [];
    const add = (value) => {
        if (!value) return;
        names.push(String(typeof value === 'string' ? value : (value.item || value.name || '')).toLowerCase());
    };
    if (Array.isArray(gameState.inventory)) gameState.inventory.forEach(add);
    if (Array.isArray(gameState.armor)) gameState.armor.forEach(add);
    add(gameState.selectedItem);
    add(gameState.offhandItem);
    return names.join(' ');
}

function equipmentScore(gameState = {}) {
    const hay = carryingText(gameState);
    let score = 0;
    if (/_pickaxe/.test(hay)) score += 0.18;
    if (/_sword|_axe/.test(hay)) score += 0.16;
    if (/shield/.test(hay)) score += 0.14;
    if (/torch/.test(hay)) score += 0.08;
    if (/(bread|apple|carrot|potato|beef|porkchop|mutton|chicken|cod|salmon|stew|berries|cooked_|golden_apple)/.test(hay)) score += 0.12;
    const armorPieces = Array.isArray(gameState.armor)
        ? gameState.armor.filter((item) => item && !/empty|air/.test(String(item).toLowerCase())).length
        : 0;
    score += Math.min(0.32, armorPieces * 0.08);
    if (/(diamond|netherite)_(helmet|chestplate|leggings|boots|sword|pickaxe)/.test(hay)) score += 0.1;
    return clamp(score, 0, 1);
}

export function appraiseMinecraftState(gameState = {}) {
    const maxHealth = Math.max(1, finite(gameState.maxHealth, 20));
    const health = clamp(finite(gameState.health, maxHealth), 0, maxHealth) / maxHealth;
    const hunger = clamp(finite(gameState.hunger, 20), 0, 20) / 20;
    const hostiles = clamp(finite(gameState.nearbyHostiles, 0), 0, 12);
    const gear = equipmentScore(gameState);
    const isNight = String(gameState.timeOfDay || '').toLowerCase() === 'night';
    const dimension = String(gameState.dimension || '').toLowerCase();
    const dangerousDimension = /nether|the_end|the end/.test(dimension);
    const maxAir = Math.max(1, finite(gameState.maxAir, 300));
    const air = clamp(finite(gameState.air, maxAir), 0, maxAir) / maxAir;
    const immediateHazard = gameState.inLava ? 1 : (gameState.underwater && air < 0.35 ? 0.65 : 0);
    const nearby = gameState.nearby && typeof gameState.nearby === 'object' ? gameState.nearby : {};
    const rareOreNearby = /diamond|emerald|ancient_debris/.test(String(nearby.nearestOre || ''));

    const confidence = clamp(
        25 + health * 27 + gear * 31 + Math.min(8, finite(gameState.xpLevel, 0) * 0.35)
        - hostiles * 2.8 - immediateHazard * 28 - (dangerousDimension ? 4 : 0)
    );
    const fear = clamp(
        6 + (1 - health) * 42 + (1 - hunger) * 10 + hostiles * 6
        + (isNight ? (gear < 0.45 ? 14 : 5) : 0)
        + (dangerousDimension ? 8 : 0) + immediateHazard * 46
    );
    const security = clamp(
        18 + health * 25 + hunger * 12 + gear * 34
        + (nearby.bed !== undefined ? 5 : 0)
        + (finite(gameState.nearbyPlayers, 0) > 0 ? 4 : 0)
        - hostiles * 5 - (isNight ? 7 : 0)
        - (dangerousDimension ? 7 : 0) - immediateHazard * 42
    );
    const fun = clamp(
        52 + (rareOreNearby ? 9 : 0) + (dangerousDimension ? 5 : 0)
        - (health < 0.35 ? 15 : 0) - (hunger < 0.25 ? 9 : 0)
        - immediateHazard * 10
    );

    return { confidence, fear, security, fun };
}

function labelFor(state) {
    if (state.fear >= 76) return 'panicked';
    if (state.security <= 25) return 'exposed';
    if (state.fun <= 28) return 'bored';
    if (state.confidence >= 72 && state.security >= 58) return 'bold';
    if (state.fun >= 76 && state.fear < 55) return 'having a blast';
    if (state.fear >= 55) return 'nervous';
    if (state.security >= 68) return 'secure';
    if (state.confidence >= 62) return 'confident';
    return 'steady';
}

export class MinecraftAffect {
    constructor(initial = {}, now = Date.now()) {
        this.values = {
            confidence: clamp(finite(initial.confidence, DEFAULT_STATE.confidence)),
            fear: clamp(finite(initial.fear, DEFAULT_STATE.fear)),
            security: clamp(finite(initial.security, DEFAULT_STATE.security)),
            fun: clamp(finite(initial.fun, DEFAULT_STATE.fun))
        };
        this.lastUpdatedAt = now;
        this.lastReason = 'starting the session';
        this.hasObservation = false;
    }

    observe(gameState = {}, now = Date.now()) {
        const target = appraiseMinecraftState(gameState);
        const elapsedSeconds = clamp((now - this.lastUpdatedAt) / 1000, 0, 30);
        // React substantially to the first trustworthy snapshot, then settle
        // toward the live situation over roughly half a minute.
        const alpha = this.hasObservation
            ? 1 - Math.exp(-elapsedSeconds / 28)
            : 0.45;
        for (const key of Object.keys(this.values)) {
            this.values[key] = clamp(this.values[key] + (target[key] - this.values[key]) * alpha);
        }
        this.hasObservation = true;
        this.lastUpdatedAt = now;
        return this.snapshot();
    }

    applyEvent(event, data = {}, gameState = {}, now = Date.now()) {
        this.observe(gameState, now);
        const amount = clamp(finite(data.amount, 1), 1, 20);
        const count = clamp(finite(data.count, gameState.nearbyHostiles || 1), 1, 12);
        const deltas = {
            damage_taken: { confidence: -(4 + amount * 1.4), fear: 8 + amount * 2.1, security: -(6 + amount * 1.5), fun: -Math.min(8, amount) },
            death: { confidence: -24, fear: 28, security: -34, fun: -18 },
            respawn: { confidence: 4, fear: -14, security: 9, fun: 7 },
            creeper_spotted: { confidence: -3, fear: 19, security: -14, fun: 2 },
            hostiles_nearby: { confidence: -Math.min(8, count), fear: 5 + count * 2.2, security: -(4 + count * 1.7), fun: count >= 4 ? -4 : 1 },
            low_hunger: { confidence: -4, fear: 6, security: -13, fun: -7 },
            nightfall: { confidence: -2, fear: 8, security: -8, fun: 2 },
            dimension_changed: { confidence: 2, fear: 8, security: -8, fun: 10 },
            diamond_found: { confidence: 13, fear: -4, security: 3, fun: 22 },
            rare_find: { confidence: 8, fear: -2, security: 2, fun: 14 },
            achievement: { confidence: 12, fear: -3, security: 3, fun: 14 },
            entity_killed: { confidence: 10, fear: -9, security: 8, fun: 8 },
            task_finished: { confidence: 5, fear: -2, security: 2, fun: 4 },
            world_joined: { confidence: 2, fear: -4, security: 5, fun: 8 },
            session_lost: { confidence: -5, fear: 5, security: -18, fun: -10 },
            stalled: { confidence: -9, fear: 4, security: -4, fun: -11 },
            looping: { confidence: -8, fear: 3, security: -3, fun: -18 },
            // held in one spot by mobs while being hit: worse than a plain loop,
            // because it is not boredom - it is losing and knowing it.
            pinned: { confidence: -12, fear: 14, security: -20, fun: -16 },
            bored: { confidence: 0, fear: -2, security: 0, fun: -13 }
        }[event];
        if (deltas) this.bump(deltas, String(event).replace(/_/g, ' '), now);
        return this.snapshot();
    }

    applyOutcome(success, action, gameState = {}, now = Date.now()) {
        this.observe(gameState, now);
        const risky = new Set(['attack', 'defend', 'hunt', 'locate', 'speedrun']);
        const playful = new Set(['explore', 'locate', 'speedrun', 'build', 'hunt']);
        if (success) {
            this.bump({
                confidence: risky.has(action) ? 11 : 7,
                fear: risky.has(action) ? -7 : -3,
                security: ['eat', 'equip', 'craft', 'get', 'collect'].includes(action) ? 7 : 3,
                fun: playful.has(action) ? 10 : 5
            }, `${action || 'goal'} succeeded`, now);
        } else {
            this.bump({ confidence: -9, fear: 5, security: -4, fun: -8 }, `${action || 'goal'} failed`, now);
        }
        return this.snapshot();
    }

    bump(deltas = {}, reason = '', now = Date.now()) {
        for (const key of Object.keys(this.values)) {
            if (Number.isFinite(Number(deltas[key]))) {
                this.values[key] = clamp(this.values[key] + Number(deltas[key]));
            }
        }
        if (reason) this.lastReason = reason;
        this.lastUpdatedAt = now;
        return this.snapshot();
    }

    snapshot() {
        const state = {
            confidence: Math.round(this.values.confidence),
            fear: Math.round(this.values.fear),
            security: Math.round(this.values.security),
            fun: Math.round(this.values.fun)
        };
        state.riskTolerance = Math.round(clamp(
            state.confidence * 0.42 + state.security * 0.28 + state.fun * 0.22 - state.fear * 0.32 + 20
        ));
        state.label = labelFor(state);
        state.lastReason = this.lastReason;
        return state;
    }
}

export default MinecraftAffect;
