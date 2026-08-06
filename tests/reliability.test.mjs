import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MinecraftTool } from '../core/minecraft_tool.js';
import { MinecraftMemory } from '../core/minecraft_memory.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burtcraft-reliability-'));
const tools = [];
const makeTool = (name) => {
  const tool = new MinecraftTool({
    memory: new MinecraftMemory(path.join(tempDir, `${name}.json`), { registerExitHook: false }),
    registerMemoryExitHook: false
  });
  tools.push(tool);
  return tool;
};
const turn = () => new Promise((resolve) => setImmediate(resolve));

try {
  const prepTool = makeTool('prep');
  prepTool.lastGameStateAt = Date.now();
  prepTool.gameState.inventory = ['1 minecraft:stone_pickaxe'];
  let prep = prepTool._survivalPrep();
  assert.equal(prep.action, 'eat', 'no wheat must not masquerade as bread crafting');
  prepTool.gameState.inventory.push('3 minecraft:wheat');
  prep = prepTool._survivalPrep();
  assert.equal(prep.action, 'craft');
  assert.equal(prep.params.target, 'bread');

  const stallTool = makeTool('stall');
  const recovered = [];
  stallTool.executeAction = async (action) => { recovered.push(action); return { started: true }; };
  stallTool.enabled = true;
  stallTool.connected = true;
  stallTool.gameConnected = true;
  stallTool.activeGoal = {
    id: 'dead-craft', action: 'craft', params: { target: 'bread' }, source: 'autonomous',
    watchdog: true, lastProgressAt: Date.now() - 21_000,
    lastPosition: { x: 10, y: 64, z: 10 }, lastInventorySignature: ''
  };
  stallTool._applyState({
    position: { x: 10, y: 64, z: 10 }, inventory: [],
    botTask: 'doing stuff in crafting_table x 1 container: [[bread] x 1]',
    botAction: 'wander for infinity blocks: exploring'
  }, Date.now());
  // `hud` is the intent overlay push, not control - it rides along on any tick
  // that changes what she is doing, so filter it out and assert the control verb.
  assert.deepEqual(recovered.filter((a) => a !== 'hud'), ['stop'],
    'fresh telemetry stops a dead craft after 20s');
  assert.equal(stallTool.activeGoal, null);

  stallTool.activeGoal = { action: 'craft', params: { target: 'bread' }, source: 'autonomous' };
  stallTool.gameState.botTaskPath = [
    'doing stuff in crafting_table x 1 container: [[bread] x 1]',
    'collect recipe resources: recipe target: getting wheat x 3',
    'wander for infinity blocks: exploring'
  ];
  assert.equal(stallTool._intentPayload().phase, 'needs wheat x3');

  const gamerTool = makeTool('gamer');
  const sent = [];
  gamerTool.connected = true;
  gamerTool.gameConnected = true;
  gamerTool.enabled = true;
  gamerTool.autonomous = true;
  gamerTool.lastGameStateAt = Date.now();
  gamerTool.client = { readyState: 1, send: (wire) => sent.push(JSON.parse(wire)) };
  // the wire also carries `config` frames (leaving gamer mode hands self-play
  // back, which re-arms autonomous) and `hud` intent pushes. neither is a control
  // action, and either can land after the verb under test - so every assertion
  // below wants the last real ACTION wire, not simply the last thing sent.
  const lastSent = () => [...sent].reverse()
    .find((wire) => wire.type === 'action' && wire.action !== 'hud');

  const breadCraft = gamerTool.executeAction('craft', { target: 'bread' }, {
    source: 'autonomous', waitForCompletion: false
  });
  await turn();
  const breadWire = lastSent();
  gamerTool._handleResponse({ action_id: breadWire.id, status: 'executing' });
  await breadCraft;

  const gamerStart = gamerTool.startGamerMode();
  assert.equal(gamerTool.startGamerMode(), gamerStart, 'double-clicking gamer shares one transition');
  await turn();
  const gamerStop = lastSent();
  assert.equal(gamerStop.action, 'stop', 'gamer interrupts bread crafting');
  assert.equal(gamerTool.pendingActions.has(breadWire.id), false);
  gamerTool._handleResponse({ action_id: gamerStop.id, status: 'executing' });
  gamerTool._handleResponse({ action_id: gamerStop.id, status: 'success', result: { success: true } });
  await turn();
  const speedrunWire = lastSent();
  assert.equal(speedrunWire.action, 'speedrun');
  gamerTool._handleResponse({ action_id: speedrunWire.id, status: 'executing' });
  await gamerStart;

  const replacement = gamerTool.executeAction('collect', { target: 'oak_log' }, {
    source: 'agent', waitForCompletion: false
  });
  await turn();
  const replacementStop = lastSent();
  assert.equal(replacementStop.action, 'stop', 'agent can interrupt gamer mode');
  gamerTool._handleResponse({ action_id: replacementStop.id, status: 'executing' });
  gamerTool._handleResponse({ action_id: replacementStop.id, status: 'success', result: { success: true } });
  await turn();
  const collectWire = lastSent();
  assert.equal(collectWire.action, 'collect');
  gamerTool._handleResponse({ action_id: collectWire.id, status: 'executing' });
  await replacement;

  const lostStop = gamerTool.executeAction('stop');
  const lostStopCheck = assert.rejects(lostStop, /not confirmed/);
  await turn();
  const lostStopWire = lastSent();
  let terminated = false;
  gamerTool.client.terminate = () => { terminated = true; };
  gamerTool._expirePendingAction(
    lostStopWire.id,
    gamerTool.pendingActions.get(lostStopWire.id),
    'stop was not confirmed by minecraft'
  );
  await lostStopCheck;
  assert.equal(terminated, true);
  assert.equal(gamerTool.fault?.code, 'stop_unconfirmed');

  const wanderSource = fs.readFileSync(
    new URL('../altoclef/src/main/java/adris/altoclef/tasks/movement/TimeoutWanderTask.java', import.meta.url),
    'utf8'
  );
  assert.match(wanderSource, /getExploreProcess\(\)\.onLostControl\(\)/);
  assert.ok(
    wanderSource.indexOf('_failCounter > 10') < wanderSource.indexOf('Float.isInfinite(_distanceToWander)'),
    'infinite wander honors its failure counter'
  );
  const companionSource = fs.readFileSync(
    new URL('../altoclef/src/main/java/adris/altoclef/external/ExternalControlServer.java', import.meta.url),
    'utf8'
  );
  assert.match(companionSource, /gs\.add\("botTaskPath", botTaskPath\)/);

  console.log('reliability checks passed');
} finally {
  for (const tool of tools) tool.shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
