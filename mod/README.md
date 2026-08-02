# The in-game companion

This directory is documentation only. The source of truth is one file:

```
altoclef/src/main/java/adris/altoclef/external/ExternalControlServer.java
```

It is deliberately **not** duplicated here — two copies would drift, and the one
that compiles is the one in the fork.

---

## What it does

AltoClef has no network interface. Every command is a chat string handed to
`AltoClef.getCommandExecutor()`. This companion opens a small localhost TCP
server (default `7440`, newline-delimited JSON) so an outside process can drive
the bot and read its state.

It is registered as an **additive Fabric `client` entrypoint** in
`fabric.mod.json` and modifies no existing AltoClef class:

```jsonc
"entrypoints": {
  "main":   ["adris.altoclef.AltoClef"],
  "client": ["adris.altoclef.external.ExternalControlServer"]
}
```

That is the whole install. A normal AltoClef build includes it — there is no
separate mod to load and no patch step.

It also owns three things that only make sense inside the game:

- **The intent HUD** — a top-left "what I'm doing, and why" line. The *why* only
  exists outside the game (whose idea the goal was, which survival need
  triggered it), so the Node side composes the text and pushes it down with the
  `hud` verb; this side only draws what it is given. Stale intents expire after
  90s so the overlay never claims she is still doing something she abandoned.
  This is **not** AltoClef's `showTaskChains` dump, which stays off — that is a
  raw task-tree spew and unreadable on stream.
- **F1 manual control** — stops the current task, releases every forced key, and
  blocks external commands until pressed again. Plain chat still flows, so your
  character can talk while a human plays. Vanilla's hardcoded F1-hides-GUI is
  compensated for.
- **Camera and render behaviour** — optional auto third-person while walking
  head-down, and keeping the game rendering when unfocused instead of throttling
  to 10fps.

---

## Threading

Everything that touches the game is marshalled onto the client thread via
`Minecraft.execute()`. That is the only thread on which it is safe to run
commands or read world state. If you extend this file, keep that discipline —
reading a `LocalPlayer` field from the socket thread will work in testing and
crash on stream.

---

## Environment

| Variable | Default | Effect |
|---|---|---|
| `-Daltoclef.control.port` / `ALTOCLEF_CONTROL_PORT` | `7440` | listen port |
| `BURTCRAFT_INTENT_HUD` | on | set `0` to disable the HUD |
| `BURTCRAFT_AUTO_THIRD_PERSON` | on | set `0` to disable |
| `BURTCRAFT_KEEP_RENDERING` | on | set `0` to allow FPS throttling |

The socket binds to localhost only, on purpose. The bot must never be reachable
off-box.

---

## Porting to another Minecraft version

The companion is mostly version-agnostic JSON plumbing. What breaks between
versions is the handful of Minecraft API calls it makes:

1. **State reads** in `pollState` — `getFoodData()`, `level().dimension()`,
   `getAirSupply()` and friends get renamed or moved between versions.
2. **HUD rendering** — this moves often. 26.1.2 removed `HudRenderCallback`; it
   is `HudElementRegistry` now.
3. **Key binding registration** for the F1 toggle.
4. **`CommandExecutor.getMod()`** — a small accessor added by this fork so the
   companion can read the live task chain. Without it you lose the `botTask`
   readout, and the Node side degrades gracefully to no phase.

The wire protocol itself does not change. See [../docs/PROTOCOL.md](../docs/PROTOCOL.md).
