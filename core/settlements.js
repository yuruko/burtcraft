// Portable settlement geometry/state for Burtcraft.  This module deliberately
// has no Burnt runtime dependencies so the same model can ship in the standalone
// open-source core (tmp/burtcraft-repo/core).

const clean = (value, max = 64) => String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const point = (value) => {
    if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) return null;
    return { x: Math.round(value.x), y: Math.round(value.y), z: Math.round(value.z) };
};

const dimension = (value) => clean(value || 'overworld', 64);

export class Settlement {
    constructor({
        id = null, name, anchor, dimension: dim = 'overworld', world = null,
        width, depth, height, material = 'smooth_stone', progress = null,
        appliances = [], createdAt = Date.now(), updatedAt = Date.now()
    } = {}) {
        const p = point(anchor);
        if (!p) throw new Error('settlement needs a finite anchor');
        for (const [label, value] of Object.entries({ width, depth, height })) {
            if (!Number.isInteger(value) || value < 5 || value > 64) {
                throw new Error(`settlement ${label} must be an integer from 5 to 64`);
            }
        }
        this.id = clean(id || `settlement_${createdAt}_${Math.random().toString(36).slice(2, 8)}`, 96);
        this.name = clean(name || 'settlement', 48) || 'settlement';
        this.anchor = p;
        this.dimension = dimension(dim);
        this.world = world ? clean(world, 80) : null;
        this.width = width;
        this.depth = depth;
        this.height = height;
        this.material = clean(material || 'smooth_stone', 48);
        this.progress = progress && typeof progress === 'object' ? { ...progress } : null;
        this.appliances = Array.isArray(appliances) ? appliances.slice(-64) : [];
        this.createdAt = Number(createdAt) || Date.now();
        this.updatedAt = Number(updatedAt) || this.createdAt;
    }

    get kind() { return 'settlement'; }
    get role() { return 'settlement'; }
    get volume() { return this.width * this.depth * this.height; }
    get footprint() { return this.width * this.depth; }

    contains(position, margin = 0) {
        const p = point(position);
        if (!p) return false;
        const minX = this.anchor.x - Math.floor(this.width / 2) - margin;
        const minZ = this.anchor.z - Math.floor(this.depth / 2) - margin;
        const floorY = this.anchor.y - 1 - margin;
        return p.x >= minX && p.x < minX + this.width + margin * 2 &&
            p.z >= minZ && p.z < minZ + this.depth + margin * 2 &&
            p.y >= floorY && p.y < floorY + this.height + margin * 2;
    }

    distanceTo(position) {
        const p = point(position);
        return p ? Math.hypot(p.x - this.anchor.x, p.z - this.anchor.z) : Infinity;
    }

    appliancePosition(index = this.appliances.length) {
        const usableWidth = Math.max(3, this.width - 6);
        const columns = Math.max(1, Math.floor(usableWidth / 2));
        const row = Math.floor(index / columns);
        const column = index % columns;
        const minX = this.anchor.x - Math.floor(this.width / 2);
        const minZ = this.anchor.z - Math.floor(this.depth / 2);
        return {
            x: minX + 3 + column * 2,
            y: this.anchor.y,
            z: Math.min(minZ + this.depth - 3, minZ + 3 + row * 2)
        };
    }

    withProgress(progress) {
        this.progress = progress && typeof progress === 'object' ? { ...progress } : null;
        this.updatedAt = Date.now();
        return this;
    }

    toJSON() {
        return {
            id: this.id, kind: this.kind, role: this.role, name: this.name,
            anchor: { ...this.anchor }, dimension: this.dimension, world: this.world,
            width: this.width, depth: this.depth, height: this.height,
            material: this.material, progress: this.progress ? { ...this.progress } : null,
            appliances: this.appliances.slice(), createdAt: this.createdAt, updatedAt: this.updatedAt
        };
    }
}

export class Homestead extends Settlement {
    get role() { return 'homestead'; }
}

export class Outpost extends Settlement {
    get role() { return 'outpost'; }
}

export const TOASTER_HOMESTEAD_BASE = Object.freeze({ width: 19, depth: 13, height: 9 });
export const TOASTER_OUTPOST_BASE = Object.freeze({ width: 13, depth: 9, height: 7 });

// The homestead expands BEFORE furnace N is installed. Width grows every time;
// depth and height grow more slowly, preserving the broad toaster silhouette.
export function toasterHomesteadDimensions(furnaceTarget = 1) {
    const n = Math.max(1, Math.min(24, Math.floor(Number(furnaceTarget) || 1)));
    return {
        width: TOASTER_HOMESTEAD_BASE.width + n,
        depth: TOASTER_HOMESTEAD_BASE.depth + Math.floor((n - 1) / 3),
        height: TOASTER_HOMESTEAD_BASE.height + Math.floor((n - 1) / 6)
    };
}

export function toasterOutpostDimensions(level = 1) {
    const n = Math.max(1, Math.min(4, Math.floor(Number(level) || 1)));
    return {
        width: TOASTER_OUTPOST_BASE.width + (n - 1) * 2,
        depth: TOASTER_OUTPOST_BASE.depth + (n - 1),
        height: TOASTER_OUTPOST_BASE.height + Math.floor((n - 1) / 2)
    };
}

export class ToasterHomestead extends Homestead {
    constructor(options = {}) {
        const furnaceTarget = Math.max(1, Math.floor(Number(options.furnaceTarget) || 1));
        super({ ...toasterHomesteadDimensions(furnaceTarget), ...options });
        this.furnaceTarget = furnaceTarget;
    }
    get kind() { return 'toaster_homestead'; }
    blueprint() { return toasterBlueprint(this); }
    toJSON() { return { ...super.toJSON(), furnaceTarget: this.furnaceTarget }; }
}

export class ToasterOutpost extends Outpost {
    constructor(options = {}) {
        const level = Math.max(1, Math.floor(Number(options.level) || 1));
        super({ ...toasterOutpostDimensions(level), ...options });
        this.level = level;
    }
    get kind() { return 'toaster_outpost'; }
    blueprint() { return toasterBlueprint(this); }
    toJSON() { return { ...super.toJSON(), level: this.level }; }
}

export function toasterBlueprint(settlement) {
    if (!settlement || !String(settlement.kind || '').startsWith('toaster_')) {
        throw new Error('toaster blueprint needs a toaster settlement');
    }
    const minX = settlement.anchor.x - Math.floor(settlement.width / 2);
    const minZ = settlement.anchor.z - Math.floor(settlement.depth / 2);
    const maxX = minX + settlement.width - 1;
    const maxZ = minZ + settlement.depth - 1;
    const floorY = settlement.anchor.y - 1;
    const roofY = floorY + settlement.height - 1;
    const centreX = minX + Math.floor(settlement.width / 2);
    const centreZ = minZ + Math.floor(settlement.depth / 2);
    const slotZ = [Math.max(minZ + 2, centreZ - 2), Math.min(maxZ - 2, centreZ + 2)];
    const slots = slotZ.map((z) => ({ from: { x: minX + 3, y: roofY, z }, to: { x: maxX - 3, y: roofY, z } }));
    const walkthrough = [];
    for (let x = centreX - 1; x <= centreX + 1; x += 1) {
        for (let y = floorY + 1; y <= floorY + 2; y += 1) walkthrough.push({ x, y, z: minZ });
    }
    const torches = [];
    const torchY = Math.min(roofY - 2, floorY + 3);
    for (let z = minZ + 2; z <= maxZ - 2; z += 4) {
        torches.push({ x: minX - 1, y: torchY, z, facing: 'west' });
        torches.push({ x: maxX + 1, y: torchY, z, facing: 'east' });
    }
    return {
        shape: 'rectangular_prism', material: 'smooth_stone', doorRequired: false,
        bounds: { minX, maxX, minZ, maxZ, floorY, roofY },
        toastSlotCount: 2, toastSlots: slots, walkthrough, sideTorches: torches
    };
}

export function settlementFromJSON(raw) {
    if (!raw || typeof raw !== 'object') return null;
    try {
        if (raw.kind === 'toaster_homestead') return new ToasterHomestead(raw);
        if (raw.kind === 'toaster_outpost') return new ToasterOutpost(raw);
        if (raw.role === 'homestead') return new Homestead(raw);
        if (raw.role === 'outpost') return new Outpost(raw);
        return new Settlement(raw);
    } catch {
        return null;
    }
}

export function mainIsBiggest(main, settlements = []) {
    if (!main) return false;
    return settlements.every((candidate) => !candidate || candidate.id === main.id ||
        (main.width > candidate.width && main.depth > candidate.depth && main.height > candidate.height));
}

export function fitOutpostBelowHomestead(outpost, homestead) {
    if (!outpost || !homestead) return outpost;
    outpost.width = Math.min(outpost.width, Math.max(5, homestead.width - 2));
    outpost.depth = Math.min(outpost.depth, Math.max(5, homestead.depth - 2));
    outpost.height = Math.min(outpost.height, Math.max(5, homestead.height - 2));
    return outpost;
}
