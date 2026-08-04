#!/usr/bin/env node
// builds the one deployable jar, in the order that actually works.
//
// altoclef jar-in-jars baritone's *unoptimized* fabric artifact straight out of
// baritone/fabric/build/libs, and build/ is not in git - so on a fresh clone
// building altoclef on its own dies with:
//
//     Could not find :baritone-unoptimized-fabric:<version>
//
// the baritone step has to be :fabric:build, not :fabric:remapJar. remapJar
// writes baritone-fabric-<ver>.jar; the unoptimized jar altoclef embeds is
// written by the proguard task's determinize step, which `build` pulls in
// through finalizedBy(createDist).
//
// usage: npm run build:mod  [-- --rerun-tasks]

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const gradlew = isWindows ? 'gradlew.bat' : './gradlew';
const extraArgs = process.argv.slice(2);

function readProps(file) {
    const out = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim().startsWith('#')) continue;
        const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

// minecraft 26.1.2 asks for java-runtime-epsilon (major 25), and loom needs the
// gradle jvm itself to be modern - a stale JAVA_HOME fails before gradle can
// even select the project toolchain, with an error that blames the wrong thing.
function javaMajor(home) {
    const bin = join(home, 'bin', isWindows ? 'java.exe' : 'java');
    if (!existsSync(bin)) return null;
    const probe = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    const m = `${probe.stderr || ''}${probe.stdout || ''}`.match(/version "(\d+)/);
    return m ? Number(m[1]) : null;
}

function findJava25() {
    const candidates = [];
    if (process.env.BURTCRAFT_JAVA_HOME) candidates.push(process.env.BURTCRAFT_JAVA_HOME);
    if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);

    const roots = isWindows
        ? ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium',
           'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Zulu',
           join(os.homedir(), '.gradle', 'jdks')]
        : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines',
           join(os.homedir(), '.gradle', 'jdks')];

    for (const dir of roots) {
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            try {
                if (!statSync(p).isDirectory()) continue;
            } catch { continue; }
            candidates.push(p);
            candidates.push(join(p, 'Contents', 'Home')); // macos bundle layout
        }
    }
    return candidates.find(c => javaMajor(c) === 25) || null;
}

function gradle(project, args, env) {
    console.log(`\n> ${project}: ${gradlew} ${args.join(' ')}\n`);
    // the wrapper is invoked by absolute path, quoted: a .bat needs a shell on
    // windows, and cmd does not necessarily resolve a bare name from the cwd
    // (NoDefaultCurrentDirectoryInExePath), so `gradlew.bat` alone can vanish.
    const wrapper = join(root, project, isWindows ? 'gradlew.bat' : 'gradlew');
    const run = spawnSync(isWindows ? `"${wrapper}"` : wrapper, args, {
        cwd: join(root, project),
        stdio: 'inherit',
        env,
        shell: isWindows
    });
    if (run.status !== 0) {
        console.error(`\n${project} build failed (exit ${run.status}).`);
        process.exit(1);
    }
}

const altoclefProps = readProps(join(root, 'altoclef', 'gradle.properties'));
const baritoneProps = readProps(join(root, 'baritone', 'gradle.properties'));
const baritoneVersion = altoclefProps.baritone_version;
const altoclefJar = `${altoclefProps.archives_base_name}-${altoclefProps.mod_version}.jar`;
const baritoneJar = `baritone-unoptimized-fabric-${baritoneVersion}.jar`;

if (baritoneVersion !== baritoneProps.mod_version) {
    console.error(`version mismatch: altoclef wants baritone ${baritoneVersion}, but ` +
                  `baritone/gradle.properties builds ${baritoneProps.mod_version}. ` +
                  `keep the two gradle.properties in sync.`);
    process.exit(1);
}

const javaHome = findJava25();
if (!javaHome) {
    console.error('java 25 was not found. minecraft 26.1.2 requires it - java 17 will ' +
                  'neither build nor run this.\n' +
                  'install one from https://adoptium.net/temurin/releases/?version=25 ' +
                  'or point BURTCRAFT_JAVA_HOME at it.');
    process.exit(1);
}
console.log(`using java 25 at ${javaHome}`);

const env = {
    ...process.env,
    JAVA_HOME: javaHome,
    PATH: join(javaHome, 'bin') + (isWindows ? ';' : ':') + process.env.PATH
};

// step 1 - baritone. --no-watch-fs sidesteps gradle's windows file-watcher
// failure on some workspaces; --no-daemon keeps a stale daemon from serving
// cross-project outputs that are quietly out of date.
gradle('baritone', [':compileApiJava', ':compileJava', ':fabric:build',
                    '--no-daemon', '--no-watch-fs', ...extraArgs], env);

const baritoneBuilt = join(root, 'baritone', 'fabric', 'build', 'libs', baritoneJar);
if (!existsSync(baritoneBuilt)) {
    console.error(`baritone built but ${baritoneJar} is missing.\n` +
                  `altoclef links against exactly that file - check that the ` +
                  `proguard/createDist step ran.`);
    process.exit(1);
}

// step 2 - altoclef. 26.1.2 ships unobfuscated, so loom has no remapJar at all:
// `jar` is already the shippable artifact and `build` runs it plus the checks.
gradle('altoclef', ['build', '--no-daemon', '--no-watch-fs', ...extraArgs], env);

const artifact = join(root, 'altoclef', 'build', 'libs', altoclefJar);
if (!existsSync(artifact)) {
    console.error(`altoclef build succeeded but ${altoclefJar} was not produced.`);
    process.exit(1);
}

console.log(`\nbuilt ${artifact}`);
console.log(`baritone ${baritoneVersion} is nested inside it - do not deploy a second baritone jar.`);
console.log('copy it, plus fabric api, into your 26.1.2 profile\'s mods/ folder.');
