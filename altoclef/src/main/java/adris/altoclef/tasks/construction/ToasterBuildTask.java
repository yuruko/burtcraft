package adris.altoclef.tasks.construction;

import adris.altoclef.AltoClef;
import adris.altoclef.TaskCatalogue;
import adris.altoclef.tasks.construction.settlement.Settlement;
import adris.altoclef.tasksystem.ITaskRequiresGrounded;
import adris.altoclef.tasksystem.Task;
import baritone.api.schematic.AbstractSchematic;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.AirBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.WallTorchBlock;
import net.minecraft.world.level.block.state.BlockState;

import java.util.List;

/**
 * Builds and repairs one settlement-shaped toaster.
 *
 * Baritone owns the bulk prism work while this task owns resupply, exact side
 * torches, progress telemetry, and completion. Reissuing the same command after
 * a restart is safe: the world is surveyed and only incorrect blocks are changed.
 */
public final class ToasterBuildTask extends Task implements ITaskRequiresGrounded {
    private static final int STONE_BATCH = 192;
    private static final int STONE_RESTOCK_AT = 24;
    private static final int TORCH_BATCH = 16;
    private static final long SURVEY_INTERVAL_MS = 900L;
    private static JsonObject latestTelemetry;

    private final Settlement settlement;
    private Survey survey;
    private long surveyedAt;
    private String phase = "surveying";
    private boolean behaviourPushed;

    public ToasterBuildTask(Settlement settlement) {
        if (settlement == null) throw new IllegalArgumentException("settlement is required");
        this.settlement = settlement;
    }

    public static JsonObject getLatestTelemetry() {
        return latestTelemetry == null ? null : latestTelemetry.deepCopy();
    }

    @Override
    protected void onStart(AltoClef mod) {
        mod.getBehaviour().push();
        behaviourPushed = true;
        mod.getBehaviour().addProtectedItems(Blocks.SMOOTH_STONE.asItem(), Blocks.TORCH.asItem());
        surveyedAt = 0L;
        phase = "surveying";
        refreshSurvey(mod, true);
    }

    @Override
    protected Task onTick(AltoClef mod) {
        Survey current = refreshSurvey(mod, false);
        if (current.complete()) {
            phase = "complete";
            publish(current, false);
            stopBuilder(mod);
            return null;
        }

        // Shell and clearing are one idempotent schematic. A healthy stockpile
        // keeps Baritone working for several minutes instead of interrupting it
        // after every stack.
        if (current.shellRemaining() > 0 || current.clearRemaining > 0) {
            int smooth = mod.getItemStorage().getItemCount(Blocks.SMOOTH_STONE.asItem());
            if (current.smoothStoneRemaining() > 0 && smooth < STONE_RESTOCK_AT) {
                stopBuilder(mod);
                phase = "gathering_smooth_stone";
                publish(current, true);
                int target = Math.min(STONE_BATCH, Math.max(64, current.smoothStoneRemaining()));
                return TaskCatalogue.getItemTask("smooth_stone", target);
            }
            phase = current.clearRemaining > 0 ? "clearing_interior" : current.nextShellPhase();
            if (!mod.getClientBaritone().getBuilderProcess().isActive()) {
                mod.getClientBaritone().getBuilderProcess().build(
                    settlement.kind() + "_" + settlement.name(),
                    new SettlementSchematic(settlement), settlement.origin());
            }
            publish(current, true);
            return null;
        }

        stopBuilder(mod);
        BlockPos missingTorch = current.firstMissingTorch;
        if (missingTorch != null) {
            if (!mod.getItemStorage().hasItem(Blocks.TORCH.asItem())) {
                phase = "crafting_side_torches";
                publish(current, true);
                return TaskCatalogue.getItemTask("torch", TORCH_BATCH);
            }
            phase = "lighting_sides";
            publish(current, true);
            // A wall torch chooses its facing from the real supporting wall. The
            // task validates the block position, not an invented default facing.
            Direction facing = missingTorch.getX() < settlement.minX() ? Direction.WEST : Direction.EAST;
            BlockState wallTorch = Blocks.WALL_TORCH.defaultBlockState().setValue(WallTorchBlock.FACING, facing);
            return new PlaceBlockTask(missingTorch, wallTorch);
        }

        phase = "surveying";
        publish(current, true);
        return null;
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {
        stopBuilder(mod);
        if (behaviourPushed) {
            mod.getBehaviour().pop();
            behaviourPushed = false;
        }
        Survey current = refreshSurvey(mod, true);
        publish(current, false);
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        return refreshSurvey(mod, false).complete();
    }

    @Override
    protected boolean isEqual(Task other) {
        if (!(other instanceof ToasterBuildTask task)) return false;
        Settlement a = task.settlement;
        return a.kind().equals(settlement.kind()) && a.anchor().equals(settlement.anchor())
            && a.width() == settlement.width() && a.depth() == settlement.depth()
            && a.height() == settlement.height();
    }

    @Override
    protected String toDebugString() {
        int percent = survey == null ? 0 : survey.percent();
        return "building " + settlement.kind().replace('_', ' ') + " "
            + settlement.width() + "x" + settlement.depth() + "x" + settlement.height()
            + " (" + percent + "%): " + phase;
    }

    private void stopBuilder(AltoClef mod) {
        if (mod.getClientBaritone().getBuilderProcess().isActive()) {
            mod.getClientBaritone().getBuilderProcess().onLostControl();
        }
    }

    private Survey refreshSurvey(AltoClef mod, boolean force) {
        long now = System.currentTimeMillis();
        if (!force && survey != null && now - surveyedAt < SURVEY_INTERVAL_MS) return survey;
        survey = Survey.scan(mod, settlement);
        surveyedAt = now;
        publish(survey, isActive());
        return survey;
    }

    private void publish(Survey current, boolean active) {
        latestTelemetry = current.toJson(settlement, phase, active);
    }

    private static final class SettlementSchematic extends AbstractSchematic {
        private final Settlement settlement;

        SettlementSchematic(Settlement settlement) {
            super(settlement.width(), settlement.height(), settlement.depth());
            this.settlement = settlement;
        }

        @Override
        public BlockState desiredState(int x, int y, int z, BlockState current, List<BlockState> available) {
            BlockPos world = settlement.origin().offset(x, y, z);
            return settlement.desiredState(world, current);
        }
    }

    private static final class Survey {
        int floorTotal, floorCorrect;
        int wallTotal, wallCorrect;
        int roofTotal, roofCorrect;
        int slotTotal, slotCorrect;
        int entranceTotal, entranceCorrect;
        int interiorTotal, clearRemaining;
        int torchTotal, torchCorrect;
        BlockPos firstMissingTorch;

        static Survey scan(AltoClef mod, Settlement settlement) {
            Survey out = new Survey();
            for (int x = settlement.minX(); x <= settlement.maxX(); x++) {
                for (int y = settlement.floorY(); y <= settlement.roofY(); y++) {
                    for (int z = settlement.minZ(); z <= settlement.maxZ(); z++) {
                        BlockPos pos = new BlockPos(x, y, z);
                        BlockState state = mod.getWorld().getBlockState(pos);
                        if (settlement.isEntrance(pos)) {
                            out.entranceTotal++;
                            if (state.getBlock() instanceof AirBlock) out.entranceCorrect++;
                        } else if (settlement.isToastSlot(pos)) {
                            out.slotTotal++;
                            if (state.getBlock() instanceof AirBlock) out.slotCorrect++;
                        } else if (settlement.isFloor(pos)) {
                            out.floorTotal++;
                            if (state.getBlock() == settlement.material()) out.floorCorrect++;
                        } else if (settlement.isRoof(pos)) {
                            out.roofTotal++;
                            if (state.getBlock() == settlement.material()) out.roofCorrect++;
                        } else if (settlement.isWall(pos)) {
                            out.wallTotal++;
                            if (state.getBlock() == settlement.material()) out.wallCorrect++;
                        } else if (settlement.isInterior(pos)) {
                            out.interiorTotal++;
                            if (!(state.getBlock() instanceof AirBlock) && !settlement.preserveInterior(state)) {
                                out.clearRemaining++;
                            }
                        }
                    }
                }
            }
            List<BlockPos> torches = settlement.torchPositions();
            out.torchTotal = torches.size();
            for (BlockPos pos : torches) {
                BlockState state = mod.getWorld().getBlockState(pos);
                if (state.getBlock() == Blocks.WALL_TORCH || state.getBlock() == Blocks.TORCH) {
                    out.torchCorrect++;
                } else if (out.firstMissingTorch == null) {
                    out.firstMissingTorch = pos;
                }
            }
            return out;
        }

        int shellRemaining() {
            return smoothStoneRemaining()
                + slotTotal - slotCorrect + entranceTotal - entranceCorrect;
        }

        int smoothStoneRemaining() {
            return floorTotal - floorCorrect + wallTotal - wallCorrect + roofTotal - roofCorrect;
        }

        boolean complete() {
            return shellRemaining() == 0 && clearRemaining == 0 && torchCorrect == torchTotal;
        }

        String nextShellPhase() {
            if (floorCorrect < floorTotal) return "building_smooth_floor";
            if (wallCorrect < wallTotal) return "building_smooth_walls";
            if (roofCorrect < roofTotal) return "building_roof_and_toast_slots";
            if (slotCorrect < slotTotal) return "cutting_two_toast_slots";
            if (entranceCorrect < entranceTotal) return "cutting_walkthrough";
            return "repairing_shell";
        }

        private static double ratio(int correct, int total) {
            return total <= 0 ? 1.0 : Math.max(0.0, Math.min(1.0, (double) correct / total));
        }

        int percent() {
            double clear = interiorTotal <= 0 ? 1.0 : 1.0 - (double) clearRemaining / interiorTotal;
            double weighted = ratio(floorCorrect, floorTotal) * 0.18
                + ratio(wallCorrect, wallTotal) * 0.22
                + ratio(roofCorrect, roofTotal) * 0.18
                + ratio(slotCorrect, slotTotal) * 0.12
                + ratio(entranceCorrect, entranceTotal) * 0.08
                + Math.max(0.0, clear) * 0.12
                + ratio(torchCorrect, torchTotal) * 0.10;
            return complete() ? 100 : Math.min(99, Math.max(0, (int) Math.floor(weighted * 100.0)));
        }

        JsonObject toJson(Settlement s, String phase, boolean active) {
            JsonObject json = new JsonObject();
            json.addProperty("active", active);
            json.addProperty("kind", s.kind());
            json.addProperty("role", s.role());
            json.addProperty("name", s.name());
            json.addProperty("x", s.anchor().getX());
            json.addProperty("y", s.anchor().getY());
            json.addProperty("z", s.anchor().getZ());
            json.addProperty("width", s.width());
            json.addProperty("depth", s.depth());
            json.addProperty("height", s.height());
            json.addProperty("material", "smooth_stone");
            json.addProperty("phase", phase);
            json.addProperty("percent", percent());
            json.addProperty("complete", complete());
            json.addProperty("clear", clearRemaining == 0);
            json.addProperty("floor", floorCorrect == floorTotal);
            json.addProperty("walls", wallCorrect == wallTotal);
            json.addProperty("roof", roofCorrect == roofTotal);
            json.addProperty("toastSlots", slotCorrect == slotTotal && slotTotal > 0);
            json.addProperty("toastSlotCount", 2);
            json.addProperty("walkthrough", entranceCorrect == entranceTotal && entranceTotal > 0);
            json.addProperty("lit", torchCorrect == torchTotal && torchTotal > 0);
            json.addProperty("smoothStoneRemaining", Math.max(0, smoothStoneRemaining()));
            json.addProperty("clearRemaining", clearRemaining);
            json.addProperty("torches", torchCorrect);
            json.addProperty("torchesRequired", torchTotal);
            json.addProperty("updatedAt", System.currentTimeMillis());
            return json;
        }
    }
}
