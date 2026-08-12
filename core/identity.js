// core/minecraft_identity.js
// WHO OWNS HER, AND WHOSE SERVER SHE IS STANDING ON.
//
// two facts the minecraft stack had no way to hold:
//
//   1. the person who talks to her as "the owner" everywhere else in burnt is
//      "owner_ingame" in game. the daemon has known they are the same human since
//      forever (daemon/metacognition.js, daemon/planner.js both test the pair
//      as string literals), but nothing in the minecraft path did - so "follow
//      the owner" resolved to a player who does not exist, and his lines only ever
//      surfaced because he remembered to type her name.
//   2. some servers are just servers, and one of them was built for her. the
//      companion reports the real `ServerData.ip` every poll, but the only
//      thing the prompt ever did with it was print it in brackets.
//
// ⚠ EVERYTHING HERE IS CONFIG, WITH NO HARDCODED FALLBACK. an unset key means
// "not configured", never a guessed default - so a deploy that sets nothing
// behaves exactly as the code did before this module existed, and no name is
// baked into the source. `MINECRAFT_OWNER` was already env-only and already
// consumed in six places (it was simply never set); these keys join it rather
// than inventing a second mechanism beside it.
//
// ⚠ READ AT CALL TIME, NEVER AT IMPORT. binding these to module-level consts
// would freeze whatever `process.env` held before dotenv ran, which is the
// same trap the improv-singing octave constants fell into as default args.

// `the owner` -> `owner_ingame`. comma or space separated, so one key covers a person
// with several handles.
function parseList(raw) {
    return String(raw || '')
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

// her owner's real in-game username, or null when nobody is configured.
export function ownerName() {
    const name = String(process.env.MINECRAFT_OWNER || '').trim();
    return name || null;
}

// the other names that mean the same human. the owner's own username is always
// one of them, so callers never have to special-case it.
export function ownerAliases() {
    const owner = ownerName();
    const aliases = parseList(process.env.MINECRAFT_OWNER_ALIASES);
    const key = owner ? owner.toLowerCase() : null;
    return key && !aliases.includes(key) ? [key, ...aliases] : aliases;
}

// is this name the owner, under any of the names he goes by?
// ⚠ answers false when no owner is configured. "unset" is not "everyone".
export function isOwner(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key || !ownerName()) return false;
    return ownerAliases().includes(key);
}

// THE ONE TRANSLATION. any name she was handed -> the name the game will
// actually accept. an alias becomes the owner's real username; everything else
// (including a name we know nothing about) comes back untouched, because this
// sits in front of real player targets and must never invent a player.
export function resolvePlayerName(name) {
    const raw = String(name || '').trim();
    if (!raw) return raw;
    const owner = ownerName();
    return owner && isOwner(raw) ? owner : raw;
}

// the server that was made for her, if one is configured.
// `host` is matched against the companion's reported ServerData.ip.
export function homeServerConfig() {
    const host = String(process.env.MINECRAFT_HOME_SERVER || '').trim();
    if (!host) return null;
    const label = String(process.env.MINECRAFT_HOME_SERVER_NAME || '').trim();
    return { host, name: label || null, owner: ownerName() };
}

// is the server the client is ACTUALLY on (companion truth, never config
// intent) the one that belongs to her?
//
// ⚠ compared host-only and case-insensitively: `ServerData.ip` carries whatever
// the player typed into the server list, which may include the default port and
// differs in case from the configured value. a port suffix that is not :25565
// is a different endpoint and is left to fail the match.
export function isHomeServer(server) {
    const cfg = homeServerConfig();
    if (!cfg || !server) return false;
    const strip = (s) => String(s).trim().toLowerCase().replace(/:25565$/, '');
    return strip(server) === strip(cfg.host);
}

// the home server as it should reach her prompt, or null when she is somewhere
// else (or nothing is configured). the caller passes the LIVE server so this
// can never claim she is home while she is on someone else's box.
export function homeServerFor(server) {
    if (!isHomeServer(server)) return null;
    const cfg = homeServerConfig();
    return { host: cfg.host, name: cfg.name, owner: cfg.owner };
}

export default {
    ownerName, ownerAliases, isOwner, resolvePlayerName,
    homeServerConfig, isHomeServer, homeServerFor
};
