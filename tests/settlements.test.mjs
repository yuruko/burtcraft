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

let previous = null;
for (let furnace = 1; furnace <= 24; furnace += 1) {
  const dimensions = toasterHomesteadDimensions(furnace);
  if (previous) {
    assert.equal(dimensions.width, previous.width + 1, 'home expands for every furnace');
    assert.ok(dimensions.depth >= previous.depth);
    assert.ok(dimensions.height >= previous.height);
  }
  assert.ok(dimensions.width > dimensions.depth && dimensions.depth > dimensions.height, 'toaster stays rectangular');
  previous = dimensions;
}

const main = new ToasterHomestead({ name: 'main toaster', anchor: { x: 0, y: 64, z: 0 }, furnaceTarget: 1 });
const outposts = [1, 2, 3, 4].map((level) => new ToasterOutpost({
  name: `outpost ${level}`, anchor: { x: level * 200, y: 64, z: 0 },
  level, ...toasterOutpostDimensions(level)
}));
assert.equal(mainIsBiggest(main, outposts), true, 'main is strictly larger than every supported outpost');
const blueprint = toasterBlueprint(main);
assert.equal(blueprint.shape, 'rectangular_prism');
assert.equal(blueprint.material, 'smooth_stone');
assert.equal(blueprint.doorRequired, false);
assert.equal(blueprint.toastSlots.length, 2);
assert.equal(blueprint.walkthrough.length, 6);
assert.ok(blueprint.sideTorches.every((torch) => ['west', 'east'].includes(torch.facing)));

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
    width: 20, depth: 13, height: 9, phase: 'complete', percent: 100,
    complete: true, clear: true, floor: true, walls: true, roof: true,
    toastSlots: true, toastSlotCount: 2, walkthrough: true, lit: true,
    smoothStoneRemaining: 0, clearRemaining: 0, torches: 8, torchesRequired: 8
  };
  controller._applyState({ settlementBuild: survey }, Date.now());
  const project = controller.getStatus().homeProject;
  assert.equal(project.shellPercent, 100);
  assert.ok(project.percent < 100);
  assert.equal(project.nextAppliance, 'furnace');
  const afterSurvey = controller._homesteadBehavior();
  assert.equal(afterSurvey.action, 'install_appliance');
  assert.equal(afterSurvey.params.target, 'furnace');
  controller._recordCompletion('install_appliance', afterSurvey.params);
  controllerMemory.flush();
  const resumed = new MinecraftMemory(controllerMemoryPath, { registerExitHook: false });
  assert.equal(resumed.ovenTally().furnace, 1);
  assert.equal(resumed.getMainSettlement().progress.percent, 100);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const bridge = new MinecraftBotBridge();
assert.deepEqual(bridge._translate('build_settlement', {
  role: 'homestead', x: 0, y: 64, z: 0, width: 20, depth: 13, height: 9
}), { command: 'toaster_build homestead 0 64 0 20 13 9' });
assert.deepEqual(bridge._translate('install_appliance', {
  target: 'furnace', x: -7, y: 64, z: -3
}), { command: 'place_at -7 64 -3 furnace' });
assert.throws(() => bridge._translate('build_settlement', {
  role: 'cube', x: 0, y: 64, z: 0, width: 20, depth: 20, height: 20
}), /role must be homestead or outpost/);
assert.throws(() => bridge._translate('install_appliance', {
  target: 'oak_door', x: 0, y: 64, z: 0
}), /needs a furnace/);

console.log('settlement geometry, persistence, and bridge translation: ok');
