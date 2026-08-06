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
// finished one. the plan is now a single ascii map that never changes size, so
// these dimensions must be CONSTANT no matter how many appliances are wanted.
const HOMESTEAD = { width: 14, depth: 9, height: 8 };
const OUTPOST = { width: 12, depth: 7, height: 6 };
for (let furnace = 1; furnace <= 24; furnace += 1) {
  assert.deepEqual(toasterHomesteadDimensions(furnace), HOMESTEAD,
    'the homestead plan is fixed - it must not grow with the furnace target');
}
for (let level = 1; level <= 4; level += 1) {
  assert.deepEqual(toasterOutpostDimensions(level), OUTPOST,
    'the outpost plan is fixed - it must not grow with the level');
}
for (const dimensions of [HOMESTEAD, OUTPOST]) {
  assert.ok(dimensions.width > dimensions.depth && dimensions.depth > dimensions.height,
    'toaster stays rectangular');
}

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
const FACINGS = ['north', 'south', 'east', 'west'];
assert.ok(blueprint.sideTorches.length > 0, 'the shell is lit');
assert.ok(blueprint.sideTorches.every((torch) => FACINGS.includes(torch.facing)),
  'every wall torch has a real facing');
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
  const survey = {
    kind: 'toaster_homestead', role: 'homestead', x: 40, y: 70, z: -20,
    ...HOMESTEAD, phase: 'complete', percent: 100,
    complete: true, clear: true, floor: true, walls: true, roof: true,
    toastSlots: true, toastSlotCount: 2, walkthrough: true, lit: true,
    smoothStoneRemaining: 0, clearRemaining: 0, torches: 8, torchesRequired: 8
  };
  controller._applyState({ settlementBuild: survey }, Date.now());
  const project = controller.getStatus().homeProject;
  assert.equal(project.shellPercent, 100, 'a complete survey finishes the shell');
  assert.ok(project.percent < 100, 'the shell is not the whole project - the gallery is still empty');
  // the gallery installs bottom course first, rotating chest -> furnace -> smoker.
  // a block placed in mid-air has no face to click on, and the one below it is
  // that face, so the order is load-bearing rather than cosmetic.
  assert.equal(project.nextAppliance, 'chest');
  assert.equal(project.phase, 'waiting_for_chest');
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
assert.deepEqual(bridge._translate('build_settlement', {
  role: 'homestead', x: 0, y: 64, z: 0, ...HOMESTEAD
}), { command: `toaster_build homestead 0 64 0 ${HOMESTEAD.width} ${HOMESTEAD.depth} ${HOMESTEAD.height}` });
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
