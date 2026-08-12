import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MinecraftMemory, ToasterHomestead, ToasterOutpost,
  MinecraftTool, toasterHomesteadDimensions, toasterOutpostDimensions,
  mainIsBiggest, toasterBlueprint
} from '../core/index.js';
import MinecraftBotBridge from '../bridge/minecraft_bot_bridge.js';

// THE FLOORPLAN IS FIXED. the shell used to grow a block of width per furnace
// (up to 43x20x12), which meant the bot re-laid its own house 24 times and never
// finished one. that is why these dimensions must never be a function of how
// many appliances are wanted.
//
// ⚠ THE ARGUMENT'S MEANING CHANGED. it used to be a furnace target the function
// was required to IGNORE; it is now a PLAN VERSION the function is required to
// OBEY. so the old loop - passing 1..24 and demanding one constant - silently
// became "give me plan version 24", which clamps to the newest plan and
// correctly returns a different footprint. the invariant is unchanged and in
// fact stronger: within a version the plan is a constant, and no appliance count
// can reach it, because the parameter is no longer an appliance count at all.
const HOMESTEAD_V1 = { width: 14, depth: 9, height: 8 };   // the flat ascii map
const HOMESTEAD_V2 = { width: 13, depth: 21, height: 11 }; // the layered toaster
const OUTPOST = { width: 12, depth: 7, height: 6 };

assert.deepEqual(toasterHomesteadDimensions(1), HOMESTEAD_V1, 'plan v1 is the 14x9x8 ascii map');
assert.deepEqual(toasterHomesteadDimensions(2), HOMESTEAD_V2, 'plan v2 is the layered toaster');
assert.deepEqual(toasterHomesteadDimensions(1), toasterHomesteadDimensions(1), 'v1 is stable across calls');
assert.deepEqual(toasterHomesteadDimensions(2), toasterHomesteadDimensions(2), 'v2 is stable across calls');
// a junk or out-of-range version CLAMPS to a plan that was actually drawn rather
// than scaling into one that never was. this is what makes a stale record on
// disk safe to rehydrate.
for (const junk of [0, -3, 99, 24, NaN, null, undefined, 'two']) {
  const dims = toasterHomesteadDimensions(junk);
  assert.ok([HOMESTEAD_V1, HOMESTEAD_V2].some((p) =>
    p.width === dims.width && p.depth === dims.depth && p.height === dims.height),
  `version ${String(junk)} clamps to a real plan instead of inventing a footprint`);
}
// only one outpost plan is drawn, so its version is carried and never branched
// on - every input is the same house.
for (const level of [1, 2, 3, 4, 99]) {
  assert.deepEqual(toasterOutpostDimensions(level), OUTPOST,
    'the outpost plan is fixed - it must not grow with the level');
}
// the flat plans are wider than deep; the LAYERED plan stands the toaster on its
// end, so it is deliberately excluded from the old rectangle rule rather than
// quietly failing it.
for (const dimensions of [HOMESTEAD_V1, OUTPOST]) {
  assert.ok(dimensions.width > dimensions.depth && dimensions.depth > dimensions.height,
    'the flat toaster stays rectangular');
}
assert.ok(HOMESTEAD_V2.depth > HOMESTEAD_V2.width && HOMESTEAD_V2.height > HOMESTEAD_V1.height,
  'the layered toaster is the tall one - its long axis is depth, not width');
// what the rest of this file builds against.
const HOMESTEAD = HOMESTEAD_V1;

const main = new ToasterHomestead({ name: 'main toaster', anchor: { x: 0, y: 64, z: 0 }, furnaceTarget: 1 });
const outposts = [1, 2, 3, 4].map((level) => new ToasterOutpost({
  name: `outpost ${level}`, anchor: { x: level * 200, y: 64, z: 0 },
  level, ...toasterOutpostDimensions(level)
}));
assert.equal(mainIsBiggest(main, outposts), true, 'main is strictly larger than every supported outpost');
const blueprint = toasterBlueprint(main);
assert.equal(blueprint.shape, 'rectangular_prism');
assert.equal(blueprint.material, 'stone');
assert.equal(blueprint.doorRequired, false);
assert.equal(blueprint.toastSlots.length, 2);
assert.ok(blueprint.walkthrough.length > 0, 'the shell has a walk-through gap');
// torches light the INSIDE of the walls, so each one faces off the wall that
// holds it - all four are legal. PlaceBlockTask compares the whole blockstate,
// so a torch with the wrong facing is a slot that can never be satisfied.
// ⚠ 'up' IS A REAL FACING, and omitting it failed a plan that was correct. the
// layered plan stands 104 of its 106 torches ON TOP of the furnace banks - those
// are floor torches (`torch`, facing up), not wall torches (`wall_torch`, facing
// off the wall that holds them). the invariant worth protecting is not "every
// torch is on a wall"; it is that every torch asks for a facing its own block can
// actually take, because PlaceBlockTask compares the whole blockstate and a torch
// asking for an impossible one is a cell the builder works forever.
const WALL_FACINGS = ['north', 'south', 'east', 'west'];
const ALL_FACINGS = [...WALL_FACINGS, 'up'];
assert.ok(blueprint.sideTorches.length > 0, 'the shell is lit');
assert.ok(blueprint.sideTorches.every((torch) => ALL_FACINGS.includes(torch.facing)),
  'every torch has a real facing');
// the two kinds are not interchangeable, so assert both are accounted for rather
// than loosening the check to "any string will do".
const floorTorches = blueprint.sideTorches.filter((t) => t.facing === 'up');
const wallTorches = blueprint.sideTorches.filter((t) => WALL_FACINGS.includes(t.facing));
assert.equal(floorTorches.length + wallTorches.length, blueprint.sideTorches.length,
  'every torch is either a floor torch or a wall torch, never neither');
assert.ok(wallTorches.length > 0, 'the shell has wall torches');
// every appliance slot is a column of three; the plan places them bottom course
// first, because a block in mid-air has no face to click on.
assert.equal(blueprint.stackHeight, 3);
assert.ok(blueprint.applianceSlots.length > 0, 'the gallery has slots');
assert.ok(blueprint.beds.length > 0, 'the homestead has a bed nook');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burtcraft-settlements-'));
try {
  const memoryPath = path.join(tempDir, 'memory.json');
  const memory = new MinecraftMemory(memoryPath, { registerExitHook: false });
  memory.upsertSettlement(main, { main: true });
  memory.upsertSettlement(outposts[0]);
  memory.updateSettlementProgress(main.id, {
    phase: 'building_smooth_walls', percent: 47, complete: false,
    floor: true, walls: false, roof: false, clear: true,
    toastSlots: false, toastSlotCount: 2, walkthrough: true, lit: false
  });
  memory.flush();
  const restored = new MinecraftMemory(memoryPath, { registerExitHook: false });
  assert.equal(restored.getMainSettlement().kind, 'toaster_homestead');
  assert.equal(restored.getMainSettlement().progress.percent, 47);
  assert.equal(restored.listOutposts().length, 1);

  const controllerMemoryPath = path.join(tempDir, 'controller-memory.json');
  const controllerMemory = new MinecraftMemory(controllerMemoryPath, { registerExitHook: false });
  const controller = new MinecraftTool({ memory: controllerMemory, registerMemoryExitHook: false });
  controller.gameState.position = { x: 40, y: 70, z: -20 };
  controller.gameState.dimension = 'minecraft:overworld';
  controller.gameState.inventory = ['1 minecraft:stone_pickaxe', '1 minecraft:furnace', '64 minecraft:torch'];
  controller.gameState.nearby = {};
  controllerMemory.setHome('main toaster', controller.gameState.position, controller.gameState.dimension, null, 'singleplayer');
  const beforeSurvey = controller._homesteadBehavior();
  assert.equal(beforeSurvey.action, 'build_settlement', 'inventory torches do not satisfy the shell');
  // ⚠ THE SURVEY MUST DESCRIBE THE HOUSE THE BOT ACTUALLY CLAIMED. the tool
  // matches an incoming survey to a live settlement on kind + anchor + FOOTPRINT,
  // so a survey quoting a different plan's dimensions matches nothing and reads
  // as 0% - which is correct behaviour and exactly what should happen if the game
  // ever reports a house that is not the one on record. hardcoding v1's 14x9x8
  // here silently tested that mismatch instead of the completion path the
  // assertion below is about, so the dimensions are taken from the settlement.
  const claimed = controllerMemory.getMainSettlement();
  const survey = {
    kind: 'toaster_homestead', role: 'homestead', x: 40, y: 70, z: -20,
    width: claimed.width, depth: claimed.depth, height: claimed.height,
    phase: 'complete', percent: 100,
    complete: true, clear: true, floor: true, walls: true, roof: true,
    toastSlots: true, toastSlotCount: 2, walkthrough: true, lit: true,
    smoothStoneRemaining: 0, clearRemaining: 0, torches: 8, torchesRequired: 8
  };
  controller._applyState({ settlementBuild: survey }, Date.now());
  const project = controller.getStatus().homeProject;
  assert.equal(project.shellPercent, 100, 'a complete survey finishes the shell');
  assert.ok(project.percent < 100, 'the shell is not the whole project - the gallery is still empty');
  // the gallery installs bottom course first - a block placed in mid-air has no
  // face to click on, and the one below it is that face - so the ORDER is
  // load-bearing rather than cosmetic.
  //
  // ⚠ but WHICH fixture comes first belongs to the plan, not to this test. v1
  // rotates chest -> furnace -> smoker; the layered plan works in stages and
  // opens with a crafting table. asserting the literal 'chest' was asserting one
  // plan's rotation, so it failed the moment a second plan existed. what must
  // hold for EVERY plan is that the bot is waiting on a real fixture, that the
  // phase names the same fixture it is waiting for (a phase that disagrees with
  // the target is how a gallery rotates forever on a slot it never fills), and
  // that a shell alone is not a finished homestead.
  const GALLERY_KINDS = ['chest', 'furnace', 'smoker', 'blast_furnace', 'crafting_table'];
  assert.ok(GALLERY_KINDS.includes(project.nextAppliance),
    `the gallery is waiting on a real fixture (got ${project.nextAppliance})`);
  assert.equal(project.phase, `waiting_for_${project.nextAppliance}`,
    'the reported phase names the fixture actually being waited on');
  assert.equal(project.complete, false);
  // installing an oven joins it to the durable collection, which must survive a
  // restart - that ledger is what makes the appliances "hers" across sessions.
  controller._recordCompletion('install_appliance', {
    target: 'furnace', x: 40, y: 70, z: -20, settlementId: project.id
  });
  controllerMemory.flush();
  const resumed = new MinecraftMemory(controllerMemoryPath, { registerExitHook: false });
  assert.equal(resumed.ovenTally().furnace, 1);
  assert.equal(resumed.getMainSettlement().progress.percent, 100);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const bridge = new MinecraftBotBridge();
// ⚠ THE PLAN VERSION HAS TO REACH THE WIRE. the command carries the footprint,
// and a homestead that names no version is resolved to the LATEST plan - so
// sending v1's dimensions without saying "v1" does not build a v1, it builds
// whatever is current at whatever size the current plan is. that is why the
// version is asserted here rather than assumed: getting it wrong puts the big
// toaster on top of the house the bot already lives in.
assert.deepEqual(bridge._translate('build_settlement', {
  role: 'homestead', x: 0, y: 64, z: 0, planVersion: 1, ...HOMESTEAD_V1
}), { command: `toaster_build homestead 0 64 0 ${HOMESTEAD_V1.width} ${HOMESTEAD_V1.depth} ${HOMESTEAD_V1.height} 0` },
'an explicit v1 keeps the flat footprint');
assert.deepEqual(bridge._translate('build_settlement', {
  role: 'homestead', x: 0, y: 64, z: 0, planVersion: 2
}), { command: `toaster_build homestead 0 64 0 ${HOMESTEAD_V2.width} ${HOMESTEAD_V2.depth} ${HOMESTEAD_V2.height} 0` },
'an explicit v2 gets the layered footprint');
// the trailing flag is the defensive trench, which ships OFF - switching it on
// makes every standing homestead read incomplete and start a ~1240-block dig.
assert.ok(bridge._translate('build_settlement', {
  role: 'homestead', x: 0, y: 64, z: 0, planVersion: 2
}).command.endsWith(' 0'), 'the trench is off unless asked for');
assert.ok(bridge._translate('build_settlement', {
  role: 'homestead', x: 0, y: 64, z: 0, planVersion: 2, trench: true
}).command.endsWith(' 1'), 'trench:true reaches the wire');
assert.deepEqual(bridge._translate('install_appliance', {
  target: 'furnace', x: -7, y: 64, z: -3
}), { command: 'place_at -7 64 -3 furnace' });
assert.throws(() => bridge._translate('build_settlement', {
  role: 'cube', x: 0, y: 64, z: 0, width: 20, depth: 20, height: 20
}), /role must be homestead or outpost/);
assert.throws(() => bridge._translate('install_appliance', {
  target: 'oak_door', x: 0, y: 64, z: 0
}), /install_appliance needs a .*furnace.*kind/);

console.log('settlement geometry, persistence, and bridge translation: ok');
