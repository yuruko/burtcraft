package adris.altoclef.util.helpers;

import adris.altoclef.AltoClef;
import adris.altoclef.mixins.ClientConnectionAccessor;
import adris.altoclef.util.Dimension;
import baritone.api.BaritoneAPI;
import baritone.pathing.movement.CalculationContext;
import baritone.pathing.movement.MovementHelper;
import baritone.process.MineProcess;
import baritone.utils.BlockStateInterface;
import net.minecraft.world.*;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.entity.*;
import net.minecraft.world.level.block.grower.*;
import net.minecraft.world.level.block.piston.*;
import net.minecraft.world.level.block.state.*;
import net.minecraft.world.level.block.state.properties.*;
import net.minecraft.world.level.material.*;
import net.minecraft.world.phys.shapes.*;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.SpawnerBlockEntity;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.ChestType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.network.Connection;
import net.minecraft.core.Holder;
import com.mojang.math.*;
import net.minecraft.core.*;
import net.minecraft.core.dispenser.*;
import net.minecraft.server.level.*;
import net.minecraft.util.*;
import net.minecraft.util.datafix.*;
import net.minecraft.util.profiling.jfr.*;
import net.minecraft.world.entity.ai.behavior.*;
import net.minecraft.world.level.*;
import net.minecraft.world.level.block.piston.*;
import net.minecraft.world.level.block.state.properties.*;
import net.minecraft.world.level.levelgen.placement.*;
import net.minecraft.world.level.levelgen.structure.*;
import net.minecraft.world.phys.*;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.Biomes;

import java.util.*;

/**
 * Super useful helper functions for getting information about the world.
 */
public interface WorldHelper {

    // God bless 1.18
    int WORLD_CEILING_Y = 255;
    int WORLD_FLOOR_Y = -64;

    /**
     * Get the number of in-game ticks the game/world has been active for.
     */
    static int getTicks() {
        Connection con = Objects.requireNonNull(Minecraft.getInstance().getConnection()).getConnection();
        return ((ClientConnectionAccessor) con).getTicks();
    }

    static Vec3 toVec3d(BlockPos pos) {
        if (pos == null) return null;
        return new Vec3(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
    }

    static Vec3 toVec3d(Vec3i pos) {
        return new Vec3(pos.getX(), pos.getY(), pos.getZ());
    }

    static Vec3i toVec3i(Vec3 pos) {
        return new Vec3i((int) pos.x(), (int) pos.y(), (int) pos.z());
    }

    static BlockPos toBlockPos(Vec3 pos) {
        return new BlockPos((int) pos.x(), (int) pos.y(), (int) pos.z());
    }

    static boolean isSourceBlock(AltoClef mod, BlockPos pos, boolean onlyAcceptStill) {
        BlockState s = mod.getWorld().getBlockState(pos);
        if (s.getBlock() instanceof LiquidBlock) {
            // Only accept still fluids.
            if (!s.getFluidState().isSource() && onlyAcceptStill) return false;
            int level = s.getFluidState().getAmount();
            // Ignore if there's liquid above, we can't tell if it's a source block or not.
            BlockState above = mod.getWorld().getBlockState(pos.above());
            if (above.getBlock() instanceof LiquidBlock) return false;
            return level == 8;
        }
        return false;
    }

    static double distanceXZSquared(Vec3 from, Vec3 to) {
        Vec3 delta = to.subtract(from);
        return (delta.x * delta.x) + (delta.z * delta.z);
    }

    static double distanceXZ(Vec3 from, Vec3 to) {
        return Math.sqrt(distanceXZSquared(from, to));
    }

    static boolean inRangeXZ(Vec3 from, Vec3 to, double range) {
        return distanceXZSquared(from, to) < range * range;
    }

    static boolean inRangeXZ(BlockPos from, BlockPos to, double range) {
        return inRangeXZ(toVec3d(from), toVec3d(to), range);
    }

    static boolean inRangeXZ(Entity entity, Vec3 to, double range) {
        return inRangeXZ(entity.position(), to, range);
    }

    static boolean inRangeXZ(Entity entity, BlockPos to, double range) {
        return inRangeXZ(entity, toVec3d(to), range);
    }

    static boolean inRangeXZ(Entity entity, Entity to, double range) {
        return inRangeXZ(entity, to.position(), range);
    }

    static Dimension getCurrentDimension() {
        ClientLevel world = Minecraft.getInstance().level;
        if (world == null) return Dimension.OVERWORLD;
        // 26.1: dimensiontype lost ultraWarm()/natural() - the dimension key is the honest check anyway
        if (world.dimension() == Level.NETHER) return Dimension.NETHER;
        if (world.dimension() == Level.OVERWORLD) return Dimension.OVERWORLD;
        return Dimension.END;
    }


    static boolean isSolid(AltoClef mod, BlockPos pos) {
        return mod.getWorld().getBlockState(pos).isRedstoneConductor(mod.getWorld(), pos);
    }

    /**
     * Get the "head" of a block with a bed, if the block is a bed.
     */
    static BlockPos getBedHead(AltoClef mod, BlockPos posWithBed) {
        BlockState state = mod.getWorld().getBlockState(posWithBed);
        if (state.getBlock() instanceof BedBlock) {
            Direction facing = state.getValue(BedBlock.FACING);
            if (mod.getWorld().getBlockState(posWithBed).getValue(BedBlock.PART).equals(BedPart.HEAD)) {
                return posWithBed;
            }
            return posWithBed.relative(facing);
        }
        return null;
    }

    /**
     * Get the "foot" of a block with a bed, if the block is a bed.
     */
    static BlockPos getBedFoot(AltoClef mod, BlockPos posWithBed) {
        BlockState state = mod.getWorld().getBlockState(posWithBed);
        if (state.getBlock() instanceof BedBlock) {
            Direction facing = state.getValue(BedBlock.FACING);
            if (mod.getWorld().getBlockState(posWithBed).getValue(BedBlock.PART).equals(BedPart.FOOT)) {
                return posWithBed;
            }
            return posWithBed.relative(facing.getOpposite());
        }
        return null;
    }

    // Get the left side of a chest, given a block pos.
    // Used to consistently identify whether a double chest is part of the same chest.
    static BlockPos getChestLeft(AltoClef mod, BlockPos posWithChest) {
        BlockState state = mod.getWorld().getBlockState(posWithChest);
        if (state.getBlock() instanceof ChestBlock) {
            ChestType type = state.getValue(ChestBlock.TYPE);
            if (type == ChestType.SINGLE || type == ChestType.LEFT) {
                return posWithChest;
            }
            Direction facing = state.getValue(ChestBlock.FACING);
            return posWithChest.relative(facing.getCounterClockWise());
        }
        return null;
    }

    static boolean isChestBig(AltoClef mod, BlockPos posWithChest) {
        BlockState state = mod.getWorld().getBlockState(posWithChest);
        if (state.getBlock() instanceof ChestBlock) {
            ChestType type = state.getValue(ChestBlock.TYPE);
            return (type == ChestType.RIGHT || type == ChestType.LEFT);
        }
        return false;
    }

    static int getGroundHeight(AltoClef mod, int x, int z) {
        for (int y = WORLD_CEILING_Y; y >= WORLD_FLOOR_Y; --y) {
            BlockPos check = new BlockPos(x, y, z);
            if (isSolid(mod, check)) return y;
        }
        return -1;
    }

    static BlockPos getADesertTemple(AltoClef mod) {
        List<BlockPos> stonePressurePlates = mod.getBlockTracker().getKnownLocations(Blocks.STONE_PRESSURE_PLATE);
        if (!stonePressurePlates.isEmpty()) {
            for (BlockPos pos : stonePressurePlates) {
                if (mod.getWorld().getBlockState(pos).getBlock() == Blocks.STONE_PRESSURE_PLATE && // Duct tape
                        mod.getWorld().getBlockState(pos.below()).getBlock() == Blocks.CUT_SANDSTONE &&
                        mod.getWorld().getBlockState(pos.below(2)).getBlock() == Blocks.TNT) {
                    return pos;
                }
            }
        }
        return null;
    }

    static boolean isUnopenedChest(AltoClef mod, BlockPos pos) {
        return mod.getItemStorage().getContainerAtPosition(pos).isEmpty();
    }

    static int getGroundHeight(AltoClef mod, int x, int z, Block... groundBlocks) {
        Set<Block> possibleBlocks = new HashSet<>(Arrays.asList(groundBlocks));
        for (int y = WORLD_CEILING_Y; y >= WORLD_FLOOR_Y; --y) {
            BlockPos check = new BlockPos(x, y, z);
            if (possibleBlocks.contains(mod.getWorld().getBlockState(check).getBlock())) return y;

        }
        return -1;
    }

    static boolean canBreak(AltoClef mod, BlockPos pos) {
        // JANK: Temporarily check if we can break WITHOUT paused interactions.
        // Not doing this creates bugs where we loop back and forth through the nether portal and stuff.
        boolean prevInteractionPaused = mod.getExtraBaritoneSettings().isInteractionPaused();
        mod.getExtraBaritoneSettings().setInteractionPaused(false);
        boolean result = mod.getWorld().getBlockState(pos).getDestroySpeed(mod.getWorld(), pos) >= 0
                && !mod.getExtraBaritoneSettings().shouldAvoidBreaking(pos)
                && MineProcess.plausibleToBreak(new CalculationContext(mod.getClientBaritone()), pos)
                && canReach(mod, pos);
        mod.getExtraBaritoneSettings().setInteractionPaused(prevInteractionPaused);
        return result;
    }

    static boolean isInNetherPortal(AltoClef mod) {
        if (mod.getPlayer() == null || mod.getWorld() == null)
            return false;
        // 26.1: Entity#inNetherPortal is gone. the replacement (Entity#portalProcess) is
        // only advanced by handlePortal(), which returns immediately off a ServerLevel -
        // on the client it would latch true forever after the first portal touch. so ask
        // the world what we're actually standing in.
        BlockPos feet = mod.getPlayer().blockPosition();
        return mod.getWorld().getBlockState(feet).is(Blocks.NETHER_PORTAL)
                || mod.getWorld().getBlockState(feet.above()).is(Blocks.NETHER_PORTAL);
    }

    static boolean dangerousToBreakIfRightAbove(AltoClef mod, BlockPos toBreak) {
        // There might be mumbo jumbo next to it, we fall and we get killed by lava or something.
        if (MovementHelper.avoidBreaking(mod.getClientBaritone().bsi, toBreak.getX(), toBreak.getY(), toBreak.getZ(), mod.getWorld().getBlockState(toBreak))) {
            return true;
        }
        // Fall down
        for (int dy = 1; dy <= toBreak.getY() - WORLD_FLOOR_Y; ++dy) {
            BlockPos check = toBreak.below(dy);
            BlockState s = mod.getWorld().getBlockState(check);
            boolean tooFarToFall = dy > mod.getClientBaritoneSettings().maxFallHeightNoWater.value;
            // Don't fall in lava
            if (MovementHelper.isLava(s))
                return true;
            // Always fall in water
            // TODO: If there's a 1 meter thick layer of water and then a massive drop below, the bot will think it is safe.
            if (MovementHelper.isWater(s))
                return true;
            // We hit ground, depends
            if (WorldHelper.isSolid(mod, check)) {
                return tooFarToFall;
            }
        }
        // At this point we probably fall through the void, so not safe.
        return true;
    }

    static boolean canPlace(AltoClef mod, BlockPos pos) {
        return !mod.getExtraBaritoneSettings().shouldAvoidPlacingAt(pos)
                && canReach(mod, pos);
    }

    static boolean canReach(AltoClef mod, BlockPos pos) {
        if (mod.getModSettings().shouldAvoidOcean()) {
            // 45 is roughly the ocean floor. We add 2 just cause why not.
            // This > 47 can clearly cause a stuck bug.
            if (mod.getPlayer().getY() > 47 && mod.getChunkTracker().isChunkLoaded(pos) && isOcean(mod.getWorld().getBiome(pos))) { // But if we stuck, add more oceans
                // Block is in an ocean biome. If it's below sea level...
                if (pos.getY() < 64 && getGroundHeight(mod, pos.getX(), pos.getZ(), Blocks.WATER) > pos.getY()) {
                    return false;
                }
            }
        }
        return !mod.getBlockTracker().unreachable(pos);
    }

    static boolean isOcean(Holder<Biome> b) {
        return (b.is(Biomes.OCEAN)
                || b.is(Biomes.COLD_OCEAN)
                || b.is(Biomes.DEEP_COLD_OCEAN)
                || b.is(Biomes.DEEP_OCEAN)
                || b.is(Biomes.DEEP_FROZEN_OCEAN)
                || b.is(Biomes.DEEP_LUKEWARM_OCEAN)
                || b.is(Biomes.LUKEWARM_OCEAN)
                || b.is(Biomes.WARM_OCEAN)
                || b.is(Biomes.FROZEN_OCEAN));
    }

    static boolean isAir(AltoClef mod, BlockPos pos) {
        return mod.getBlockTracker().blockIsValid(pos, Blocks.AIR, Blocks.CAVE_AIR, Blocks.VOID_AIR);
        //return state.isAir() || isAir(state.getBlock());
    }

    static boolean isAir(Block block) {
        return block == Blocks.AIR || block == Blocks.CAVE_AIR || block == Blocks.VOID_AIR;
    }

    static boolean isInteractableBlock(AltoClef mod, BlockPos pos) {
        Block block = mod.getWorld().getBlockState(pos).getBlock();
        return (block instanceof ChestBlock
                || block instanceof EnderChestBlock
                || block instanceof CraftingTableBlock
                || block instanceof AbstractFurnaceBlock
                || block instanceof LoomBlock
                || block instanceof CartographyTableBlock
                || block instanceof EnchantingTableBlock
                || block instanceof RedStoneOreBlock
                || block instanceof BarrelBlock
        );
    }

    static boolean isInsidePlayer(AltoClef mod, BlockPos pos) {
        return pos.closerToCenterThan(mod.getPlayer().position(), 2);
    }

    static Iterable<BlockPos> getBlocksTouchingPlayer(AltoClef mod) {
        return getBlocksTouchingBox(mod, mod.getPlayer().getBoundingBox());
    }

    static Iterable<BlockPos> getBlocksTouchingBox(AltoClef mod, AABB box) {
        BlockPos min = new BlockPos((int) box.minX, (int) box.minY, (int) box.minZ);
        BlockPos max = new BlockPos((int) box.maxX, (int) box.maxY, (int) box.maxZ);
        return scanRegion(mod, min, max);
    }

    static Iterable<BlockPos> scanRegion(AltoClef mod, BlockPos start, BlockPos end) {
        return () -> new Iterator<>() {
            int x = start.getX(), y = start.getY(), z = start.getZ();

            @Override
            public boolean hasNext() {
                return y <= end.getY() && z <= end.getZ() && x <= end.getX();
            }

            @Override
            public BlockPos next() {
                BlockPos result = new BlockPos(x, y, z);
                ++x;
                if (x > end.getX()) {
                    x = start.getX();
                    ++z;
                    if (z > end.getZ()) {
                        z = start.getZ();
                        ++y;
                    }
                }
                return result;
            }
        };
    }

    static boolean fallingBlockSafeToBreak(BlockPos pos) {
        BlockStateInterface bsi = new BlockStateInterface(BaritoneAPI.getProvider().getPrimaryBaritone().getPlayerContext());
        Level w = Minecraft.getInstance().level;
        assert w != null;
        while (isFallingBlock(pos)) {
            if (MovementHelper.avoidBreaking(bsi, pos.getX(), pos.getY(), pos.getZ(), w.getBlockState(pos)))
                return false;
            pos = pos.above();
        }
        return true;
    }

    static boolean isFallingBlock(BlockPos pos) {
        Level w = Minecraft.getInstance().level;
        assert w != null;
        return w.getBlockState(pos).getBlock() instanceof FallingBlock;
    }

    static Entity getSpawnerEntity(AltoClef mod, BlockPos pos) {
        BlockState state = mod.getWorld().getBlockState(pos);
        if (state.getBlock() instanceof SpawnerBlock) {
            BlockEntity be = mod.getWorld().getBlockEntity(pos);
            if (be instanceof SpawnerBlockEntity blockEntity) {
                return blockEntity.getSpawner().getOrCreateDisplayEntity(mod.getWorld(), pos);
            }
        }
        return null;
    }

    static Vec3 getOverworldPosition(Vec3 pos) {
        if (getCurrentDimension() == Dimension.NETHER) {
            pos = pos.multiply(8.0, 1, 8.0);
        }
        return pos;
    }

    static BlockPos getOverworldPosition(BlockPos pos) {
        if (getCurrentDimension() == Dimension.NETHER) {
            pos = new BlockPos(pos.getX() * 8, pos.getY(), pos.getZ() * 8);
        }
        return pos;
    }

    static boolean isChest(AltoClef mod, BlockPos block) {
        Block b = mod.getWorld().getBlockState(block).getBlock();
        return isChest(b);
    }

    static boolean isChest(Block b) {
        return b instanceof ChestBlock || b instanceof EnderChestBlock;
    }

    static boolean isBlock(AltoClef mod, BlockPos pos, Block block) {
        return mod.getWorld().getBlockState(pos).getBlock() == block;
    }

    static boolean canSleep() {
        int time = 0;
        ClientLevel world = Minecraft.getInstance().level;
        if (world != null) {
            // You can sleep during thunderstorms
            if (world.isThundering() && world.isRaining())
                return true;
            time = (int) (world.getOverworldClockTime() % 24000);
        }
        // https://minecraft.fandom.com/wiki/Daylight_cycle
        return 12542 <= time && time <= 23992;
    }
}
