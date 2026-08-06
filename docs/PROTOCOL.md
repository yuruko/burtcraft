# Wire protocol

Two hops, both localhost-only, both newline-delimited JSON (one object per
line). You only need this document if you are replacing one of the three
processes — the Node library speaks it for you.

```
 your vtuber            the bridge             minecraft
 (ws SERVER :7431) <--> (ws + tcp client) <--> (tcp SERVER :7440)
        hop 1                                    hop 2
```

The direction of hop 1 surprises people: **your VTuber is the server**, the
bridge is the client that dials in. This is so you can restart your VTuber
without restarting Minecraft. The bridge reconnects on its own.

---

## Hop 1 — VTuber (ws server, :7431) <-> bridge

Port from `MINECRAFT_BRIDGE_PORT`, default `7431`. Bound to `127.0.0.1`.

### Bridge -> VTuber

| type | Shape | Meaning |
|---|---|---|
| `handshake` | `{type, source, version, capabilities}` | Sent on connect. |
| `heartbeat` | `{type, timestamp, gameState}` | Liveness ping, carrying a state snapshot; answer with `heartbeat_ack`. |
| `bridge_status` | `{type, gameConnected, companionSocketConnected, ...}` | Whether the bridge's own link to the game is up. This is how you know the difference between "bridge running" and "game running". |
| `state` | `{type, gameState:{...}, observedAt}` | Live game state, roughly every 2s. `observedAt` is what the staleness checks read. |
| `event` | `{type, event, data}` | Something happened (see [events](#game-events)). |
| `response` | `{type, action_id, status, error?, result?}` | Outcome for the action with that `action_id`. **Not always terminal** — see below. |
| `queue_status` | `{type, ...}` | The bridge's own action queue depth. |
| `log` | `{type, level, message}` | Bridge-side log line, for your console. |

`status` is one of `executing`, `success`, `error`. **`executing` is a
non-terminal acknowledgement** — it means "accepted, still running", and a
second `response` with the same `action_id` follows. Treating it as completion
is the classic integration bug: the action looks instant and every later
`success` looks unsolicited.

### VTuber -> bridge

| type | Shape | Meaning |
|---|---|---|
| `action` | `{type, action, params, id, priority}` | Do a thing. `id` comes back as the `action_id` on the response. |
| `heartbeat` | `{type, timestamp}` | You may ping the bridge; it answers `heartbeat_ack`. |
| `heartbeat_ack` | `{type, timestamp}` | Reply to the bridge's `heartbeat`. |
| `query` | `{type, ...}` | Ask the bridge for its current view. |
| `config` | `{type, ...}` | Push a setting (e.g. autonomous on/off) to the bridge. |

---

## Hop 2 — bridge <-> in-game companion (tcp server, :7440)

Port from `-Daltoclef.control.port`, else `$ALTOCLEF_CONTROL_PORT`, else `7440`.
Bound to localhost on purpose — the bot must never be reachable off-box.

### Bridge -> companion

```jsonc
{"type":"command","id":"<id>","command":"get diamond 3"}  // no leading '@'
{"type":"chat","id":"<id>","text":"#explore"}             // raw line (baritone/chat)
{"type":"ping"}
```

### Companion -> bridge

```jsonc
{"type":"hello","username":"Steve"}
{"type":"ack","id":"<id>"}
{"type":"finished","id":"<id>"}              // from altoclef's onFinish
{"type":"error","id":"<id>","error":"..."}   // from altoclef's onError
{"type":"state","gameState":{...}}           // ~every 2s
{"type":"event","event":"task_finished"|"chat",...}
{"type":"pong"}
```

**Completion is real.** `finished` / `error` are driven by AltoClef's actual
`TaskFinishedEvent`, not a timer. An earlier version of the bridge faked
execution with `setTimeout` plus random success and never touched Minecraft at
all — if the companion is not connected, actions now fail honestly instead.

---

## `gameState`

Sent about every 2 seconds. Fields are best-effort; **always guard with `?.` or
defaults** rather than assuming a key is present, because most of them are
skipped when the value cannot be read this tick.

| Field | Notes |
|---|---|
| `health`, `maxHealth`, `hunger` | rounded |
| `position` | `{x, y, z}` block coords |
| `dimension` | e.g. `minecraft:overworld` |
| `onGround`, `inWater`, `inLava`, `underwater` | |
| `air`, `maxAir` | drowning headroom |
| `xpLevel` | |
| `selectedItem`, `offhandItem` | |
| `mainHandDurability`, `mainHandMaxDurability` | absent when the item is not damageable |
| `eating`, `needsToEat`, `hasFood` | from AltoClef's FoodChain |
| `multiplayer`, `server`, `nearbyPlayerNames` | **ground truth** — the companion reports what it actually joined, never what your config intended |
| `inventory`, `inventoryTypes`, `inventoryFree` | what she is carrying, and how much room is left |
| `armor` | equipped pieces |
| `timeOfDay`, `weather` | `day`/`night`, `clear`/`rain`/`thunder` |
| `rainingHere`, `skyVisible` | roof- and biome-aware: standing **in** the rain differs from rain existing somewhere |
| `biome` | |
| `nearbyHostiles`, `nearbyHostileTypes`, `nearbyPlayers` | counts and kinds, not a full entity dump |
| `nearby` | the resource-affordance scan: nearest ore, water, wheat, bed, chest, furnace, smoker, crafting table |
| `overWater`, `clearEdge` | standing over water; how much clear ground is around her |
| `homeSite` | the survey of a candidate or established home site |
| `botTask` | high-level goal + phase, e.g. `beating the game.: getting blaze rods` |
| `botAction` | deepest micro-action |
| `botTaskPath`, `botTaskDepth` | the whole task chain, outermost first — this is what a "why is she doing that" readout is built from |
| `settlementBuild` | exact toaster survey: kind/role/anchor/dimensions, phase, percent, shell/interior checks, two-slot check, walk-through check, side-torch counts, and remaining stone |

`botTask` is what lets a character say what it is genuinely doing right now. It
comes from `getTaskRunner().getCurrentTaskChain()`; older mod builds without the
`CommandExecutor.getMod()` accessor degrade gracefully to no phase.

---

## Game events

Delivered as `{type:'event', event, data}` and re-emitted by the Node library as
`gameEvent(event, data)`. This is the main feed for a VTuber brain.

The full set the companion emits: `chat`, `creeper_spotted`, `damage_taken`,
`death`, `diamond_found`, `dimension_changed`, `hostiles_nearby`,
`inventory_change`, `low_hunger`, `manual_control`, `nightfall`,
`protection_denied`, `respawn`, `task_finished`, `weather_changed`.

Note `death` and `diamond_found` are singular — the human-readable *labels* read
"died" and "diamonds found", but a handler must match the event name.

`protection_denied` is worth special handling on public servers: it fires when
the server rejects an interaction ("you are not allowed to interact with this
block"). Two denials inside a minute during a goal means the bot is standing in
someone's claim, and the right response is to remember the area and leave, not
to retry.

## Cancellation and replacement

The controller treats `stop` as a synchronization barrier. A replacement goal
is not sent after the bridge's `executing` acknowledgement; it waits for the
terminal stop response proving that AltoClef released the old task tree. Agent,
operator, mode-switch, and gamer sources may use this path to replace current
work. Duplicate gamer starts share the same transition.

If that terminal stop response is lost, the controller closes the relay socket.
Relay and companion disconnect fail-safes then issue their own stop before
reconnecting, preventing an old task from continuing unsupervised.

---

## Adding an action

1. **Node side** — add it to the action enum and, if it needs no game round
   trip, answer it locally from `getStatus()` / memory.
2. **Bridge** — map it to an AltoClef command string in the translation table.
3. **Mod side** — only if AltoClef has no command for it; add a `Command`
   subclass and register it. `PlaceCommand.java` in the fork is a small worked
   example.

Actions that never reach the game (answered from memory) include `status`,
`enable`, `disable`, `autonomous`, `favorite`, `unfavorite`, `favorites`,
`set_home`, `set_outpost`, `outposts`, `gamer`, `gamer_stop`.

`inventory` and `coords` look like they belong on that list and do not — both
are real companion commands and need a live game.

### Settlement actions

| Action | Parameters | Companion command |
|---|---|---|
| `build_settlement` | `role` (`homestead`/`outpost`); needs a settlement already saved | `@toaster_build ...` |
| `install_appliance` | `target` (see allowlist below), integer `x,y,z` | `@place_at ...` |
| `set_outpost` | local `target` name and optional `level` | persisted only |
| `build_outpost` | saved outpost name | resolves its persisted geometry, then builds |

`build_settlement` takes no dimensions from you. The floorplan is the only legal
shape, so the bridge **resolves** width/depth/height from `role` rather than
validating what it was handed — a gate that can disagree with its own caller
about a constant is a second source of truth, not a check. `x,y,z` are likewise
overwritten from the saved settlement, so call `set_home` / `set_outpost` first;
without one you get `no toaster blueprint is saved on this world yet`.

`level` on an outpost is a **label**, not a size. Every outpost is 12x7x6.

`install_appliance` allowlist: `furnace`, `blast_furnace`, `smoker`, `campfire`,
`soul_campfire`, `chest`, `crafting_table`.

The bridge validates roles and appliance allowlists and never interpolates
arbitrary command text. Reissuing a build is safe because the companion changes
only blocks that disagree with the settlement schematic.
