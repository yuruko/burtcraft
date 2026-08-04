# Building and installing

Most of the friction here is Minecraft 26.1.2 and Java 25, not this project.

---

## Prerequisites

**Java 25 is required.** Minecraft 26.1.2's version JSON asks for
`java-runtime-epsilon` (major 25). Java 17 will neither build nor run it.

```bash
java -version    # must report 25
```

Get it from [Adoptium](https://adoptium.net/temurin/releases/?version=25).

> 26.1.2 ships **unobfuscated** (official Mojang names). There are no Yarn
> mappings anywhere in the build, and Loom has no `remapJar` task — `jar` is
> already the shippable artifact. If you are used to older Fabric projects, this
> is the part that looks wrong but is not.

---

## Build

Baritone is **jar-in-jar'd inside the AltoClef jar**, so only one jar ever gets
deployed — but it has to exist before AltoClef compiles. AltoClef resolves
Baritone's *unoptimized* Fabric jar from `baritone/fabric/build/libs`, and
`build/` is not in git, so that directory is empty in a fresh clone.

```bash
npm run build:mod        # both projects, in order, with a Java 25 check
```

By hand:

```bash
cd baritone    && ./gradlew :compileApiJava :compileJava :fabric:build
cd ../altoclef && ./gradlew build          # -> build/libs/altoclef-26.1.2-beta1.jar
```

On Windows use `.\gradlew.bat` (PowerShell needs the `.\` prefix).

The Baritone step must be `:fabric:build`, **not** `:fabric:remapJar`. remapJar
writes `baritone-fabric-<ver>.jar`; the artifact AltoClef actually embeds is
`baritone-unoptimized-fabric-<ver>.jar`, written by the ProGuard task's
determinize step that `build` pulls in through `finalizedBy(createDist)`.

There is no `-Paltoclef.development` flag in this fork. Baritone is always the
vendored local one, so the sequence above is the only build path.

After editing Baritone sources, rebuild Baritone before AltoClef — otherwise the
change is silently missing from the deployed jar. Gradle has occasionally
treated those cross-project outputs as up to date after a source edit; add
`--rerun-tasks` (`npm run build:mod -- --rerun-tasks`) when you suspect that.

---

## Install

1. Install **Fabric Loader for 26.1.2** ([fabricmc.net/use/installer](https://fabricmc.net/use/installer)).
2. Give that profile **its own game directory** if your main `.minecraft/mods`
   holds mods for other Minecraft versions. This is the single most common
   failure: Fabric refuses to launch when it finds mods built for a different
   version, and the launcher's default is the shared folder.
3. Copy into that game dir's `mods/`:
   - `altoclef-26.1.2-beta1.jar`
   - **Fabric API** for 26.1.2

That is both jars. **Do not also copy a Baritone jar** — it is nested inside
AltoClef, and a second copy is a duplicate mod id that makes Fabric refuse to
start.

---

## Run

```bash
npm install
npm run bridge      # the relay
node examples/01_hello_bot.mjs
```

Order does not matter much: the bridge reconnects to both ends on its own.

---

## Troubleshooting

**`Could not find :baritone-unoptimized-fabric:1.18.0`**
AltoClef was built before Baritone. `baritone/fabric/build/libs` is empty in a
fresh clone because `build/` is gitignored — that directory looking empty is
expected, not a bad checkout. Run the Baritone step above (or `npm run
build:mod`) first. If Baritone did build but the jar is still missing, you ran
`remapJar` rather than `:fabric:build`.

**`error: release version 25 not supported`**
Gradle picked up an older JDK. Install Java 25 or point Gradle at it explicitly
(`org.gradle.java.home`, or `BURTCRAFT_JAVA_HOME` if you use the fork's build
scripts).

**`:fabric:proguard` fails reading `jmods/java.base.jmod`**
Temurin's JDK 25 image ships no `jmods/` directory and ProGuard can only read
platform classes from `.jmod` files. The fork's `buildSrc` ProguardTask detects
this and skips the pass with a warning. The unoptimized jar — the one actually
shipped — is written before that step, so the build still succeeds. Only the
`-api`/`-standalone` jars go unbuilt and nothing here uses them.

**Fabric refuses to launch / "incompatible mods"**
Almost always the shared `.minecraft/mods` folder. Give the 26.1.2 profile its
own game directory.

**Duplicate mod id `baritone`**
You copied a standalone Baritone jar next to AltoClef. Delete it.

**Gradle daemon acting up**

```bash
./gradlew --stop && ./gradlew build
```

**The bot connects but does nothing**
Check the two links separately. `getStatus().connected` is the bridge;
`gameConnected` is the game. If the bridge is up and the game is not, actions
fail honestly rather than queueing — that is intended.

**Pathfinding overlays or the task-chain dump appear on stream**
Both default to off in this fork. A regenerated settings file used to bring them
back; the defaults now keep them hidden. See [../NOTICE](../NOTICE).
