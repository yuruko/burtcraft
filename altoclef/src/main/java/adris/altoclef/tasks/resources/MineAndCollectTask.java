package adris.altoclef.tasks.resources;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.tasks.AbstractDoToClosestObjectTask;
import adris.altoclef.tasks.ResourceTask;
import adris.altoclef.tasks.construction.DestroyBlockTask;
import adris.altoclef.tasks.movement.GetToYTask;
import adris.altoclef.tasks.movement.PickupDroppedItemTask;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.Dimension;
import adris.altoclef.util.ItemTarget;
import adris.altoclef.util.MiningRequirement;
import adris.altoclef.util.helpers.StorageHelper;
import adris.altoclef.util.helpers.WorldHelper;
import adris.altoclef.util.progresscheck.MovementProgressChecker;
import adris.altoclef.util.slots.CursorSlot;
import adris.altoclef.util.slots.PlayerSlot;
import adris.altoclef.util.time.TimerGame;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.client.Minecraft;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

import java.util.*;
import adris.altoclef.util.helpers.ItemVersionHelper;

public class MineAndCollectTask extends ResourceTask {

    private final Block[] _blocksToMine;

    private final MiningRequirement _requirement;

    private final TimerGame _cursorStackTimer = new TimerGame(3);

    private final MineOrCollectTask _subtask;

    public MineAndCollectTask(ItemTarget[] itemTargets, Block[] blocksToMine, MiningRequirement requirement) {
        super(itemTargets);
        _requirement = requirement;
        _blocksToMine = blocksToMine;
        _subtask = new MineOrCollectTask(_blocksToMine, _itemTargets);
    }

    public MineAndCollectTask(ItemTarget[] blocksToMine, MiningRequirement requirement) {
        this(blocksToMine, itemTargetToBlockList(blocksToMine), requirement);
    }

    public MineAndCollectTask(ItemTarget target, Block[] blocksToMine, MiningRequirement requirement) {
        this(new ItemTarget[]{target}, blocksToMine, requirement);
    }

    public MineAndCollectTask(Item item, int count, Block[] blocksToMine, MiningRequirement requirement) {
        this(new ItemTarget(item, count), blocksToMine, requirement);
    }

    public static Block[] itemTargetToBlockList(ItemTarget[] targets) {
        List<Block> result = new ArrayList<>(targets.length);
        for (ItemTarget target : targets) {
            for (Item item : target.getMatches()) {
                Block block = Block.byItem(item);
                if (block != null && !WorldHelper.isAir(block)) {
                    result.add(block);
                }
            }
        }
        return result.toArray(Block[]::new);
    }

    @Override
    protected void onResourceStart(AltoClef mod) {
        mod.getBehaviour().push();
        mod.getBlockTracker().trackBlock(_blocksToMine);

        // We're mining, so don't throw away pickaxes.
        mod.getBehaviour().addProtectedItems(Items.WOODEN_PICKAXE, Items.STONE_PICKAXE, Items.IRON_PICKAXE, Items.DIAMOND_PICKAXE, Items.NETHERITE_PICKAXE);

        _subtask.resetSearch();
    }

    @Override
    protected boolean shouldAvoidPickingUp(AltoClef mod) {
        // Picking up is controlled by a separate task here.
        return true;
    }

    @Override
    protected Task onResourceTick(AltoClef mod) {
        if (!StorageHelper.miningRequirementMet(mod, _requirement)) {
            return new SatisfyMiningRequirementTask(_requirement);
        }

        if (_subtask.isMining()) {
            makeSureToolIsEquipped(mod);
        }

        // Wrong dimension check.
        if (_subtask.wasWandering() && isInWrongDimension(mod) && !mod.getBlockTracker().anyFound(_blocksToMine)) {
            return getToCorrectDimensionTask(mod);
        }

        return _subtask;
    }

    @Override
    protected void onResourceStop(AltoClef mod, Task interruptTask) {
        mod.getBlockTracker().stopTracking(_blocksToMine);
        mod.getBehaviour().pop();
    }

    @Override
    protected boolean isEqualResource(ResourceTask other) {
        if (other instanceof MineAndCollectTask task) {
            return Arrays.equals(task._blocksToMine, _blocksToMine);
        }
        return false;
    }

    @Override
    protected String toDebugStringName() {
        return "Mine And Collect";
    }

    private void makeSureToolIsEquipped(AltoClef mod) {
        if (_cursorStackTimer.elapsed() && !mod.getFoodChain().needsToEat()) {
            assert Minecraft.getInstance().player != null;
            ItemStack cursorStack = StorageHelper.getItemStackInCursorSlot();
            if (cursorStack != null && !cursorStack.isEmpty()) {
                // We have something in our cursor stack
                Item item = cursorStack.getItem();
                if (cursorStack.isCorrectToolForDrops(mod.getWorld().getBlockState(_subtask.miningPos()))) {
                    // Our cursor stack would help us mine our current block
                    Item currentlyEquipped = StorageHelper.getItemStackInSlot(PlayerSlot.getEquipSlot()).getItem();
                    if (ItemVersionHelper.isMiningTool(item)) {
                        if (ItemVersionHelper.isMiningTool(currentlyEquipped)) {
                            if (ItemVersionHelper.getMaterialLevel(item) > ItemVersionHelper.getMaterialLevel(currentlyEquipped)) {
                                // We can equip a better pickaxe.
                                mod.getSlotHandler().forceEquipSlot(CursorSlot.SLOT);
                            }
                        } else {
                            // We're not equipped with a pickaxe...
                            mod.getSlotHandler().forceEquipSlot(CursorSlot.SLOT);
                        }
                    }
                }
            }
            _cursorStackTimer.reset();
        }
    }

    private static class MineOrCollectTask extends AbstractDoToClosestObjectTask<Object> {

        // WHERE A BLOCK ACTUALLY LIVES. the inherited "I can't see one" fallback is
        // baritone exploration, which searches the SURFACE outward - the one search
        // that cannot work for a block that is under her feet. she spent minutes
        // wandering for stone while standing on sixty blocks of it (2026-08-05,
        // "wander for infinity blocks: exploring." under a stone pickaxe goal).
        // depth is the overworld y where each block is genuinely common in 1.18+
        // terrain; anything not listed here (wood, dirt, gravel, emerald, mob
        // drops) is left to explore, because for those the horizon IS the answer.
        private static int undergroundDepth(Block block) {
            if (block == Blocks.STONE || block == Blocks.COBBLESTONE || block == Blocks.ANDESITE
                    || block == Blocks.DIORITE || block == Blocks.GRANITE || block == Blocks.TUFF
                    || block == Blocks.DEEPSLATE || block == Blocks.COBBLED_DEEPSLATE) return 40;
            if (block == Blocks.COAL_ORE || block == Blocks.DEEPSLATE_COAL_ORE) return 45;
            if (block == Blocks.COPPER_ORE || block == Blocks.DEEPSLATE_COPPER_ORE) return 48;
            if (block == Blocks.IRON_ORE || block == Blocks.DEEPSLATE_IRON_ORE) return 16;
            if (block == Blocks.GOLD_ORE || block == Blocks.DEEPSLATE_GOLD_ORE) return -16;
            if (block == Blocks.REDSTONE_ORE || block == Blocks.DEEPSLATE_REDSTONE_ORE
                    || block == Blocks.LAPIS_ORE || block == Blocks.DEEPSLATE_LAPIS_ORE
                    || block == Blocks.DIAMOND_ORE || block == Blocks.DEEPSLATE_DIAMOND_ORE) return -52;
            return Integer.MAX_VALUE;
        }

        private final Block[] _blocks;
        private final ItemTarget[] _targets;
        private final Set<BlockPos> _blacklist = new HashSet<>();
        private final MovementProgressChecker _progressChecker = new MovementProgressChecker();
        private final Task _pickupTask;
        private BlockPos _miningPos;

        public MineOrCollectTask(Block[] blocks, ItemTarget[] targets) {
            _blocks = blocks;
            _targets = targets;
            _pickupTask = new PickupDroppedItemTask(_targets, true);
        }

        @Override
        protected Vec3 getPos(AltoClef mod, Object obj) {
            if (obj instanceof BlockPos b) {
                return WorldHelper.toVec3d(b);
            }
            if (obj instanceof ItemEntity item) {
                return item.position();
            }
            throw new UnsupportedOperationException("Shouldn't try to get the position of object " + obj + " of type " + (obj != null ? obj.getClass().toString() : "(null object)"));
        }

        @Override
        protected Optional<Object> getClosestTo(AltoClef mod, Vec3 pos) {
            Optional<BlockPos> closestBlock = mod.getBlockTracker().getNearestTracking(pos, check -> {
                if (_blacklist.contains(check)) return false;
                if (mod.getBlockTracker().unreachable(check)) return false;
                return WorldHelper.canBreak(mod, check);
            }, _blocks);

            Optional<ItemEntity> closestDrop = Optional.empty();
            if (mod.getEntityTracker().itemDropped(_targets)) {
                closestDrop = mod.getEntityTracker().getClosestItemDrop(pos, _targets);
            }

            double blockSq = closestBlock.isEmpty() ? Double.POSITIVE_INFINITY : closestBlock.get().distToCenterSqr(pos);
            double dropSq = closestDrop.isEmpty() ? Double.POSITIVE_INFINITY : closestDrop.get().distanceToSqr(pos) + 10; // + 5 to make the bot stop mining a bit less

            // We can't mine right now.
            if (mod.getExtraBaritoneSettings().isInteractionPaused()) {
                return closestDrop.map(Object.class::cast);
            }

            if (dropSq <= blockSq) {
                return closestDrop.map(Object.class::cast);
            } else {
                return closestBlock.map(Object.class::cast);
            }
        }

        @Override
        protected Vec3 getOriginPos(AltoClef mod) {
            return mod.getPlayer().position();
        }

        @Override
        protected Task onTick(AltoClef mod) {
            if (mod.getClientBaritone().getPathingBehavior().isPathing()) {
                _progressChecker.reset();
            }
            if (_miningPos != null && !_progressChecker.check(mod)) {
                mod.getClientBaritone().getPathingBehavior().forceCancel();
                Debug.logMessage("Failed to mine block. Suggesting it may be unreachable.");
                mod.getBlockTracker().requestBlockUnreachable(_miningPos, 2);
                _blacklist.add(_miningPos);
                _miningPos = null;
                _progressChecker.reset();
            }
            return super.onTick(mod);
        }

        // NOTHING OF OURS IS IN SIGHT. when every block we want lives underground and
        // she is still up on the surface, the answer is DOWN, not out: get under the
        // ground and let the ordinary tracker/mine loop take over the moment stone is
        // around her. once she is inside the band - or the target is something the
        // horizon really does hold, like wood - the inherited exploration is correct
        // again, so this hands back cleanly and cannot loop.
        @Override
        protected Task getWanderTask(AltoClef mod) {
            if (WorldHelper.getCurrentDimension() == Dimension.OVERWORLD && _blocks != null && _blocks.length > 0) {
                boolean allUnderground = true;
                int depth = Integer.MIN_VALUE;
                for (Block block : _blocks) {
                    int blockDepth = undergroundDepth(block);
                    if (blockDepth == Integer.MAX_VALUE) {
                        allUnderground = false;
                        break;
                    }
                    // the SHALLOWEST band satisfies "find any one of these" soonest.
                    depth = Math.max(depth, blockDepth);
                }
                // still meaningfully above the band - below it, digging further is not
                // a search, and lateral exploring through the caves is the real move.
                if (allUnderground && mod.getPlayer() != null && mod.getPlayer().getBlockY() > depth + 6) {
                    setDebugState("Nothing in sight, digging down to y=" + depth);
                    return new GetToYTask(depth);
                }
            }
            return super.getWanderTask(mod);
        }

        @Override
        protected Task getGoalTask(Object obj) {
            if (obj instanceof BlockPos newPos) {
                if (_miningPos == null || !_miningPos.equals(newPos)) {
                    _progressChecker.reset();
                }
                _miningPos = newPos;
                return new DestroyBlockTask(_miningPos);
            }
            if (obj instanceof ItemEntity) {
                _miningPos = null;
                return _pickupTask;
            }
            throw new UnsupportedOperationException("Shouldn't try to get the goal from object " + obj + " of type " + (obj != null ? obj.getClass().toString() : "(null object)"));
        }

        @Override
        protected boolean isValid(AltoClef mod, Object obj) {
            if (obj instanceof BlockPos b) {
                return mod.getBlockTracker().blockIsValid(b, _blocks) && WorldHelper.canBreak(mod, b);
            }
            if (obj instanceof ItemEntity drop) {
                Item item = drop.getItem().getItem();
                if (_targets != null) {
                    for (ItemTarget target : _targets) {
                        if (target.matches(item)) return true;
                    }
                }
                return false;
            }
            return false;
        }

        @Override
        protected void onStart(AltoClef mod) {
            _progressChecker.reset();
            _miningPos = null;
        }

        @Override
        protected void onStop(AltoClef mod, Task interruptTask) {

        }

        @Override
        protected boolean isEqual(Task other) {
            if (other instanceof MineOrCollectTask task) {
                return Arrays.equals(task._blocks, _blocks) && Arrays.equals(task._targets, _targets);
            }
            return false;
        }

        @Override
        protected String toDebugString() {
            return "Mining or Collecting";
        }

        public boolean isMining() {
            return _miningPos != null;
        }

        public BlockPos miningPos() {
            return _miningPos;
        }
    }

}
