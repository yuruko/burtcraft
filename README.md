# burtcraft

Give an AI VTuber a real Minecraft body.

This is the integration that lets [Burnt Melba](https://github.com/yuruko) actually play Minecraft on
stream — not a scripted demo, but a bot that mines, builds a homestead, gets
ambushed, takes requests from chat, and can tell you what it is doing while it
does it. It is packaged here so you can bolt it onto *your* VTuber instead.

The hard part of "AI plays Minecraft" is not the AI. It is that Minecraft has no
API. This repo is the missing plumbing, plus a 4,800-line autonomy brain that
already knows how to survive.

```
   your vtuber's brain  ->  burtcraft  ->  AltoClef  ->  Baritone  ->  the world
   (an llm, yours)          (this repo)   (tasks)       (pathing)
```

---

## What you actually get

| | |
|---|---|
| **A wire protocol** | Newline-delimited JSON over localhost. Documented in [docs/PROTOCOL.md](docs/PROTOCOL.md). |
| **A Node library** | `core/` — ws server, live game state, durable place/settlement memory, and an autonomy loop. No LLM calls, database, HTTP, or dialogue opinions. |
| **A relay** | `bridge/` — translates actions into real AltoClef commands and back. |
| **An in-game mod** | `altoclef/src/main/java/adris/altoclef/external/ExternalControlServer.java` — the only piece that runs inside Minecraft. `mod/` documents it. |
| **Two vendored forks** | `altoclef/` and `baritone/`, patched for Minecraft 26.1.2 and for not swimming across oceans. See [NOTICE](NOTICE). |
| **Five worked examples** | `examples/` — each runs standalone with no game attached. |

**What you do not get:** a personality, a voice, a TTS pipeline, or an LLM.
Those stay yours. This library emits events and answers `getStatus()`; every word
your audience hears is written by your brain, not by this repo. That is a
deliberate boundary — see [Design rules](#design-rules-learned-the-hard-way).

---

## How it fits together

AltoClef has **no network interface of its own**. The only way in is a command
string handed to `AltoClef.getCommandExecutor()`. So the integration is three
processes and two hops:

```
 your vtuber (node)              the bridge                 minecraft (fabric)
 +--------------------+  ws 7431  +----------------+  tcp 7440  +--------------------+
 |  core/             | <=======> | bridge/        | <========> | mod/ExternalControl|
 |  minecraft_tool.js |  actions  | minecraft_bot_ | @commands  | Server.java        |
 |  (ws SERVER)       |  + state  | bridge.js      | + events   | (tcp SERVER)       |
 +--------------------+           +----------------+            +---------+----------+
          ^                                                               |
          |                                              AltoClef.getCommandExecutor()
   you subscribe here                                              -> Baritone -> world
```

Two things about this that are easy to get wrong:

- **The Node side is the ws SERVER, the bridge is the client.** Backwards from
  what most people assume. The bridge reconnects on its own, so you can restart
  your VTuber without restarting Minecraft.
- **Completion is real.** An action finishes when AltoClef's actual
  `onFinish`/`onError` fires, not when a timer expires. If the game is not
  running, actions fail honestly instead of reporting fake success. Your brain
  should be allowed to notice that it failed.

Both ports bind to localhost only, on purpose. The bot must never be reachable
off-box.

---

## Requirements

- **Java 25** — Minecraft 26.1.2 requires it. Java 17 will not build or run this.
- **Minecraft 26.1.2** with **Fabric Loader** and **Fabric API**.
- **Node 18+**.
- A machine that can run Minecraft and your VTuber at once.

> 26.1.2 ships unobfuscated, so there are no Yarn mappings and Loom has no
> `remapJar` task — `jar` is already the shippable artifact. Baritone is
> jar-in-jar'd *inside* the AltoClef jar, so only one jar ever gets deployed.
> Copying a second Baritone jar next to it is a duplicate mod id and Fabric will
> refuse to launch.

---

## Quick start

**1. Build the mod.** Baritone goes first. AltoClef jar-in-jars Baritone's
*unoptimized* Fabric jar straight out of `baritone/fabric/build/libs`, and
`build/` is not in git — so a fresh clone has nothing to link against yet.

```bash
npm run build:mod    # baritone, then altoclef, with a Java 25 check
```

By hand, if you prefer:

```bash
cd baritone    && ./gradlew :compileApiJava :compileJava :fabric:build
cd ../altoclef && ./gradlew build      # -> build/libs/altoclef-26.1.2-beta1.jar
```

The control server is an additive Fabric `client` entrypoint, so a normal
AltoClef build includes it — no extra step.

> Building AltoClef on its own fails with `Could not find
> :baritone-unoptimized-fabric:1.18.0`. The Baritone step has to be
> `:fabric:build`, not `remapJar` — remapJar writes `baritone-fabric-<ver>.jar`,
> while the *unoptimized* jar AltoClef embeds is written by the ProGuard task's
> determinize step, which `build` pulls in via `finalizedBy(createDist)`.

**2. Install it.** Drop that jar plus Fabric API into your Fabric 26.1.2
profile's `mods/` folder. Use a dedicated game directory if your main
`.minecraft/mods` holds mods for other versions — Fabric will refuse to start
otherwise.

**3. Launch Minecraft** and join a world, singleplayer or a server.

**4. Start the bridge.**

```bash
npm install
npm run bridge
```

**5. Drive it.**

```bash
node examples/01_hello_bot.mjs
```

Every example runs standalone with no game attached, so you can read the output
and learn the API before any of the above works.

### Toaster settlements

Burtcraft includes a reusable settlement hierarchy (`Settlement`, `Homestead`,
`Outpost`) and Burnt's concrete `ToasterHomestead` / `ToasterOutpost` geometry.
A toaster is an idempotently repaired rectangular smooth-stone prism with a
clear interior, smooth floor/walls/ceiling, a three-wide doorless walk-through,
two long roof slots, side torches, and deterministic middle-gallery appliance
positions. The main homestead expands before each furnace; supported outposts
remain strictly smaller.

```js
await mc.executeAction('set_home', { target: 'main toaster' });
const project = mc.getStatus().homeProject; // durable %/phase/components
await mc.executeAction('build_settlement', {
  role: 'homestead', ...project.dimensions,
  ...mc.getStatus().settlements[0].anchor
});
await mc.executeAction('set_outpost', { target: 'east toaster', level: 2 });
await mc.executeAction('build_outpost', { target: 'east toaster' });
```

Construction progress is surveyed from real world blocks and persisted by the
Node controller, so restarting either process resumes the same project instead
of trusting inventory or an elapsed timer.

---

## Wiring it into your VTuber

There are exactly four seams. You do not need to read the 4,800-line file.

```js
import { MinecraftTool } from 'burtcraft/core';

const mc = new MinecraftTool({ names: ['ada', 'ada bot'] });
await mc.initialize();
mc.enable();
```

### 1. Feed your brain — `on('gameEvent')`

The main firehose. Something happened in the world; turn it into a prompt.

```js
mc.on('gameEvent', async (event, data) => {
  // event: 'creeper_spotted' | 'nightfall' | 'died' | 'diamonds_found' | ...
  const line = await askYourBrain(`while playing minecraft: ${event}. react in one line.`);
  speak(line);
});
```

Also available: `actionComplete`, `actionFailed`, `botTaskPhase` (the live "what
am I doing" readout), `sessionEnded`, `faultDetected`, and ~16 more. Full list in
[docs/INTEGRATING.md](docs/INTEGRATING.md).

### 2. Give your brain situational awareness — `getStatus()`

Returns **structured data, not prose**, so you can write the wording yourself.

```js
const status = mc.getStatus();
// -> { connected, gameConnected, gameState: {health, hunger, position, ...},
//      activeGoal, currentTask, memory, favorites, home, knownPlayers, ... }
```

`examples/03_context_block.mjs` turns that into a compact block for a system
prompt. Make it degrade honestly: when `gameConnected` is false, the block must
say so, or your character will confidently narrate a game that is not running.

### 3. Let chat drive — `interpretChatCommand()` + `recordViewerSuggestion()`

```js
const parsed = mc.interpretChatCommand('go mine some diamonds');
// -> { action: 'mine', target: 'diamond_ore' }   (or null if it is not a command)

if (parsed) await mc.executeAction(parsed.action, parsed.params, { source: 'viewer' });
else mc.recordViewerSuggestion(user, text);       // surfaces in getStatus() for your brain
```

On a public server, filter first with `shouldSurfaceChat(sender, text)` — it
knows the difference between someone talking *to* her, ambient chatter (sampled,
so she does not reply to every line), and command noise.

### 4. Act — `executeAction()`

```js
await mc.executeAction('mine', { item: 'diamond', amount: 3 }, {
  source: 'llm',            // who wants this: 'llm' | 'viewer' | 'autonomy'
  waitForCompletion: true
});
```

Give the LLM the tool schema in `examples/04_llm_tool.mjs` (Anthropic and OpenAI
shapes, same 43 actions) and this becomes a normal tool call.

---

## Design rules, learned the hard way

These are the parts that took the longest to get right. Ignore them and your bot
will look robotic in a way that is hard to diagnose.

### Never speak a pre-written string

The library produces **internal cues** — short lines like `"tools first. a
homestead without a pickaxe is a campsite"`. These are *prompts for your brain*,
never output. Hand the cue to your LLM and let it write the line fresh.

This one matters more than it sounds. An earlier version picked reaction lines
from a pool, and the same sentence reached the audience over and over; bigger
pools and anti-repeat pickers were tried and did not fix it, because the problem
is not repetition, it is that the words were not hers. The pools are gone. If you
find yourself adding one, that is the smell.

### Autonomy and your LLM are peers, not master and servant

Both want to drive one bot. If you do not arbitrate, they will fight — your LLM
issues a goal, the idle loop overrides it two seconds later, and the character
looks like it has no follow-through. Tag every action with `source`, and give
LLM-issued goals a grace window before autonomy is allowed to take over. The
library ships this arbitration; do not defeat it by calling `executeAction`
untagged.

Explicit decisions are interruptible. Calls sourced as `agent`, `operator`,
`mode-switch`, or `gamer` cancel the current AltoClef task, wait for the game to
confirm the stop, and only then dispatch the replacement. This includes the
gamer button: clicking it during `craft bread` starts one stop-to-speedrun
transition instead of returning "busy". Autonomous picks still wait their turn.

Finite tasks also have progress watchdogs. A craft with no movement or inventory
change is stopped after 20 seconds (45 seconds by default for other work, 90 for
speedrun), and dead persistent exploration is restarted rather than displaying
an activity label forever.

### Fail honestly

If Minecraft is not running, actions fail. Do not paper over it — let your
character notice and say so. A VTuber narrating gameplay that is not happening is
the single most immersion-breaking bug in this whole stack, and it is very easy
to introduce by defaulting a missing value to something cheerful.

### Keep prose out of the library

`getStatus()` returns data. Every string your audience hears should be generated
at the edge, by your character, in your voice. That boundary is why this repo is
reusable at all.

---

## Actions

`enable` `disable` `status` `autonomous` `get` `move` `mine` `collect` `craft`
`follow` `stop` `idle` `attack` `defend` `speedrun` `gamer` `gamer_stop`
`explore` `hunt` `eat` `equip` `deposit` `stash` `give` `locate` `inventory`
`coords` `chat` `cover_lava` `favorite` `unfavorite` `favorites` `set_home`
`go_home` `set_outpost` `outposts` `go_outpost` `build_outpost`
`build_settlement` `install_appliance` `place` `look` `boat`

Selected mappings to the underlying commands:

| action | becomes | notes |
|---|---|---|
| `mine` / `collect` | `@get <resource> <n>` | ore names normalize, `diamond_ore` -> `diamond` |
| `craft` | `@get <item>` | AltoClef's TaskCatalogue resolves the recipe |
| `move {x,y,z}` | `@goto x y z` | or a remembered place name |
| `follow` | `@follow <player>` | defaults to `$MINECRAFT_OWNER` |
| `defend` / `attack <mob>` | `@hero` | clears nearby hostiles |
| `speedrun` / `gamer` | `@gamer` | `gamer` is the narrated, committed version |
| `place` | `@place <block>` | added by this fork |
| `explore` | Baritone `#explore` | no native AltoClef task |
| `status`, `favorites`, `set_home`, … | *(never reach the game)* | answered from memory |

---

## Configuration

| Env var | Default | What |
|---|---|---|
| `MINECRAFT_BRIDGE_PORT` | `7431` | ws port your VTuber listens on |
| `BOT_NAMES` | *(none)* | comma-separated names she answers to in chat |
| `MINECRAFT_OWNER` | *(none)* | in-game username for a bare "follow me" |
| `ALTOCLEF_CONTROL_PORT` | `7440` | in-game tcp port |
| `BURTCRAFT_INTENT_HUD` | on | on-screen "what I'm doing and why" line |
| `BURTCRAFT_AUTO_THIRD_PERSON` | on | pull the camera out while walking head-down |
| `BURTCRAFT_KEEP_RENDERING` | on | stop the game throttling to 10fps while unfocused |

Press **F1** in game to take manual control: the bot stops, releases every forced
key, and ignores external commands until you press it again. Chat still flows, so
your character can talk while you play.

---

## Repo layout

```
core/       the node library (persona-free)
bridge/     the relay process
mod/        notes on the in-game control server (source lives in altoclef/)
examples/   five runnable examples
tests/      settlement + reliability tests (npm run check)
scripts/    build-mod.mjs - builds baritone then altoclef, in that order
docs/       PROTOCOL.md, INTEGRATING.md, BUILDING.md
altoclef/   vendored fork (MIT)     - see NOTICE
baritone/   vendored fork (LGPL-3)  - see NOTICE
```

**Where to go next:** [docs/INTEGRATING.md](docs/INTEGRATING.md) is the complete
seam list — every event, every method, and the three rules that matter.
[docs/BUILDING.md](docs/BUILDING.md) covers Java 25 and the Fabric install
gotchas. [docs/PROTOCOL.md](docs/PROTOCOL.md) is only needed if you are
replacing one of the three processes.

## Tuning knobs worth knowing

- `OBSESSION_BIAS` in `core/minecraft_tool.js` — how often a character-specific
  drive outranks the normal idle menu. The shipped drive is Burnt's (bread and
  ovens). Set it to `0` to disable, or replace `_obsessionBehavior()` with your
  own character's fixation. This is the one structural piece of persona left in
  the core, and it is isolated behind two call sites.
- `avoidWaterWhileDry` (Baritone setting) — on by default in this fork. Vanilla
  prices swimming low enough that crossing an ocean looks cheaper than walking
  around it, which is how a bot ends up swimming for half an hour.

---

## License

The integration layer (`core/`, `bridge/`, `mod/`, `examples/`, `docs/`) is
**MIT** — see [LICENSE](LICENSE).

`altoclef/` is **MIT** (© Adris Jautakas and contributors). `baritone/` is
**LGPL-3.0** (© Leijurv and contributors) and stays LGPL-3.0; the root MIT
license does not apply to it. Both are modified — every change is listed in
[NOTICE](NOTICE), and in-source changes are marked `BURNT:`.

Enormous thanks to the AltoClef and Baritone projects. This repo is a thin layer
on top of many years of someone else's pathfinding work.
