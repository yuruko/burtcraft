/*
 * This file is part of Baritone.
 *
 * Baritone is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Baritone is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Baritone.  If not, see <https://www.gnu.org/licenses/>.
 */

package baritone.altoclef;

import net.minecraft.core.BlockPos;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.function.BiFunction;
import java.util.function.BiPredicate;
import java.util.function.Predicate;

public class AltoClefSettings {

    // woo singletons
    private static AltoClefSettings _instance = new AltoClefSettings();
    private final Object breakMutex = new Object();
    private final Object placeMutex = new Object();
    private final Object propertiesMutex = new Object();
    private final Object globalHeuristicMutex = new Object();
    private final HashSet<BlockPos> _blocksToAvoidBreaking = new HashSet<>();
    private final List<Predicate<BlockPos>> _breakAvoiders = new ArrayList<>();
    /**
     * THINGS SHE BUILT. Never broken, by anything, ever - and deliberately NOT
     * part of {@link #_breakAvoiders}.
     *
     * That list is owned by AltoClef's BotBehaviour stack: every push snapshots
     * it and every pop CLEARS the live list and re-adds the frame's copy. So an
     * avoider registered by a task lives exactly as long as the task. That is
     * correct for "while I am smelting, do not break my furnace", and it is
     * exactly wrong for a house, which has to stay un-mineable when nothing is
     * running at all.
     *
     * The result on stream: the toaster's wall was protected while she was
     * building it, and the moment the build task stopped the guard was erased -
     * so a plain `@goto` home priced the wall as ordinary stone and she mined a
     * doorway through her own house because it was two blocks shorter.
     *
     * Nothing here is ever cleared by a state change. Registration is idempotent
     * per id, so re-registering a settlement replaces its rule instead of
     * stacking another one every time she resumes the build.
     */
    private final java.util.LinkedHashMap<String, Predicate<BlockPos>> _structureAvoiders = new java.util.LinkedHashMap<>();
    private static final int MAX_PROTECTED_STRUCTURES = 16;
    private final List<Predicate<BlockPos>> _placeAvoiders = new ArrayList<>();
    /**
     * GROUND SHE BUILT BY EMPTYING IT. The trench, and anything else whose whole
     * value is that it stays a hole - never filled, by anything, ever.
     *
     * The same argument as {@link #_structureAvoiders}, in the opposite direction,
     * and it fails the same way: {@link #_placeAvoiders} is snapshotted by
     * BotBehaviour on push and CLEARED and restored on pop, so an avoider a task
     * registers lives exactly as long as that task. For "while I am bridging this
     * ravine, do not place there" that is right. For a moat it is exactly wrong -
     * the guard would be lifted the instant the build task ended, which is the
     * instant a plain {@code @goto} starts pricing one dirt block across the gap
     * against the walk round to the gate. MovementTraverse quotes walk + place for
     * that crossing, so the shortcut wins, and the moat is a bridge forever after.
     *
     * Never cleared by a state change. Idempotent per id, so re-registering a
     * settlement replaces its rule instead of stacking another copy onto a check
     * that runs per candidate placement on the pathing thread.
     */
    private final java.util.LinkedHashMap<String, Predicate<BlockPos>> _structurePlaceAvoiders = new java.util.LinkedHashMap<>();
    private final List<Predicate<BlockPos>> _forceCanWalkOn = new ArrayList<>();
    private final List<Predicate<BlockPos>> _forceAvoidWalkThrough = new ArrayList<>();
    private final List<BiPredicate<BlockState, ItemStack>> _forceUseTool = new ArrayList<>();
    private final List<BiFunction<Double, BlockPos, Double>> _globalHeuristics = new ArrayList<>();
    private final HashSet<Item> _protectedItems = new HashSet<>();
    private boolean _allowFlowingWaterPass;
    private boolean _pauseInteractions;
    private boolean _dontPlaceBucketButStillFall;
    private boolean _allowSwimThroughLava = false;
    private boolean _treatSoulSandAsOrdinaryBlock = false;
    private boolean canWalkOnEndPortal = false;

    public static AltoClefSettings getInstance() {
        return _instance;
    }

    public void canWalkOnEndPortal(boolean canWalk) {
        canWalkOnEndPortal = canWalk;
    }

    public void avoidBlockBreak(BlockPos pos) {
        synchronized (breakMutex) {
            _blocksToAvoidBreaking.add(pos);
        }
    }

    public void avoidBlockBreak(Predicate<BlockPos> avoider) {
        synchronized (breakMutex) {
            _breakAvoiders.add(avoider);
        }
    }

    public void configurePlaceBucketButDontFall(boolean allow) {
        synchronized (propertiesMutex) {
            _dontPlaceBucketButStillFall = allow;
        }
    }

    public void treatSoulSandAsOrdinaryBlock(boolean enable) {
        synchronized (propertiesMutex) {
            _treatSoulSandAsOrdinaryBlock = enable;
        }
    }

    public void avoidBlockPlace(Predicate<BlockPos> avoider) {
        synchronized (placeMutex) {
            _placeAvoiders.add(avoider);
        }
    }

    public boolean shouldAvoidBreaking(int x, int y, int z) {
        return shouldAvoidBreaking(new BlockPos(x, y, z));
    }

    public boolean shouldAvoidBreaking(BlockPos pos) {
        synchronized (breakMutex) {
            if (_blocksToAvoidBreaking.contains(pos))
                return true;
            if (!_structureAvoiders.isEmpty()) {
                for (Predicate<BlockPos> structure : _structureAvoiders.values()) {
                    if (structure.test(pos)) return true;
                }
            }
            return (_breakAvoiders.stream().anyMatch(pred -> pred.test(pos)));
        }
    }

    /**
     * Register something she built as permanently un-mineable. See
     * {@link #_structureAvoiders}: this outlives every task and every
     * BotBehaviour push/pop.
     *
     * The predicate runs on BARITONE'S PATHING THREAD, once per candidate block
     * break, so it must reject fast and it must never assume a world exists.
     *
     * @param id       stable identity for this structure; registering the same id
     *                 again replaces the rule rather than adding a second one.
     * @param isPartOf true when the position is a piece of the structure that
     *                 must survive. Keep the cheap geometry test first.
     */
    public void protectStructure(String id, Predicate<BlockPos> isPartOf) {
        if (id == null || isPartOf == null) return;
        synchronized (breakMutex) {
            _structureAvoiders.remove(id);          // re-insert so the newest is last
            _structureAvoiders.put(id, isPartOf);
            // she has one homestead and a handful of outposts, so this never
            // normally trips - it is here so a bug upstream cannot turn a
            // per-block pathing check into a walk over an unbounded list.
            while (_structureAvoiders.size() > MAX_PROTECTED_STRUCTURES) {
                _structureAvoiders.remove(_structureAvoiders.keySet().iterator().next());
            }
        }
    }

    /** Forget one structure (it was demolished, or she moved house). */
    public void unprotectStructure(String id) {
        if (id == null) return;
        synchronized (breakMutex) {
            _structureAvoiders.remove(id);
        }
    }

    /** Which structures are currently protected - for logs and probes. */
    public java.util.Set<String> getProtectedStructureIds() {
        synchronized (breakMutex) {
            return new java.util.LinkedHashSet<>(_structureAvoiders.keySet());
        }
    }

    /**
     * Register a volume that must stay empty, permanently. See
     * {@link #_structurePlaceAvoiders}: this outlives every task and every
     * BotBehaviour push/pop, which is the whole point of it.
     *
     * Runs on BARITONE'S PATHING THREAD once per candidate placement, so reject on
     * cheap geometry first and never touch the world.
     *
     * @param id      stable identity; re-registering replaces the rule.
     * @param isInside true when nothing may be placed at that position.
     */
    public void protectStructurePlacement(String id, Predicate<BlockPos> isInside) {
        if (id == null || isInside == null) return;
        synchronized (placeMutex) {
            _structurePlaceAvoiders.remove(id);     // re-insert so the newest is last
            _structurePlaceAvoiders.put(id, isInside);
            while (_structurePlaceAvoiders.size() > MAX_PROTECTED_STRUCTURES) {
                _structurePlaceAvoiders.remove(_structurePlaceAvoiders.keySet().iterator().next());
            }
        }
    }

    /** Forget one protected volume (it was filled in on purpose, or she moved house). */
    public void unprotectStructurePlacement(String id) {
        if (id == null) return;
        synchronized (placeMutex) {
            _structurePlaceAvoiders.remove(id);
        }
    }

    /** Which volumes are currently held empty - for logs and probes. */
    public java.util.Set<String> getProtectedPlacementIds() {
        synchronized (placeMutex) {
            return new java.util.LinkedHashSet<>(_structurePlaceAvoiders.keySet());
        }
    }

    public boolean shouldAvoidPlacingAt(BlockPos pos) {
        synchronized (placeMutex) {
            if (!_structurePlaceAvoiders.isEmpty()) {
                for (Predicate<BlockPos> structure : _structurePlaceAvoiders.values()) {
                    if (structure.test(pos)) return true;
                }
            }
            return _placeAvoiders.stream().anyMatch(pred -> pred.test(pos));
        }
    }

    public boolean shouldAvoidPlacingAt(int x, int y, int z) {
        return shouldAvoidPlacingAt(new BlockPos(x, y, z));
    }

    public boolean canWalkOnForce(int x, int y, int z) {
        synchronized (propertiesMutex) {
            return _forceCanWalkOn.stream().anyMatch(pred -> pred.test(new BlockPos(x, y, z)));
        }
    }

    public boolean shouldAvoidWalkThroughForce(BlockPos pos) {
        synchronized (propertiesMutex) {
            return _forceAvoidWalkThrough.stream().anyMatch(pred -> pred.test(pos));
        }
    }

    public boolean shouldAvoidWalkThroughForce(int x, int y, int z) {
        return shouldAvoidWalkThroughForce(new BlockPos(x, y, z));
    }

    public boolean shouldForceUseTool(BlockState state, ItemStack tool) {
        synchronized (propertiesMutex) {
            return _forceUseTool.stream().anyMatch(pred -> pred.test(state, tool));
        }
    }

    public boolean shouldNotPlaceBucketButStillFall() {
        synchronized (propertiesMutex) {
            return _dontPlaceBucketButStillFall;
        }
    }

    public boolean shouldTreatSoulSandAsOrdinaryBlock() {
        synchronized (propertiesMutex) {
            return _treatSoulSandAsOrdinaryBlock;
        }
    }

    public boolean isInteractionPaused() {
        synchronized (propertiesMutex) {
            return _pauseInteractions;
        }
    }

    public void setInteractionPaused(boolean paused) {
        synchronized (propertiesMutex) {
            _pauseInteractions = paused;
        }
    }

    public boolean isFlowingWaterPassAllowed() {
        synchronized (propertiesMutex) {
            return _allowFlowingWaterPass;
        }
    }

    public boolean canSwimThroughLava() {
        synchronized (propertiesMutex) {
            return _allowSwimThroughLava;
        }
    }

    public void setFlowingWaterPass(boolean pass) {
        synchronized (propertiesMutex) {
            _allowFlowingWaterPass = pass;
        }
    }

    public void allowSwimThroughLava(boolean allow) {
        synchronized (propertiesMutex) {
            _allowSwimThroughLava = allow;
        }
    }

    public double applyGlobalHeuristic(double prev, int x, int y, int z) {
        return prev;
        /*
        synchronized (globalHeuristicMutex) {
            BlockPos p = new BlockPos(x, y, z);
            for (BiFunction<Double, BlockPos, Double> toApply : _globalHeuristics) {
                prev = toApply.apply(prev, p);
            }
        }
        return prev;
         */
    }

    public HashSet<BlockPos> getBlocksToAvoidBreaking() {
        return _blocksToAvoidBreaking;
    }

    public List<Predicate<BlockPos>> getBreakAvoiders() {
        return _breakAvoiders;
    }

    public List<Predicate<BlockPos>> getPlaceAvoiders() {
        return _placeAvoiders;
    }

    public List<Predicate<BlockPos>> getForceWalkOnPredicates() {
        return _forceCanWalkOn;
    }

    public List<Predicate<BlockPos>> getForceAvoidWalkThroughPredicates() {
        return _forceAvoidWalkThrough;
    }

    public List<BiPredicate<BlockState, ItemStack>> getForceUseToolPredicates() {
        return _forceUseTool;
    }

    public List<BiFunction<Double, BlockPos, Double>> getGlobalHeuristics() {
        return _globalHeuristics;
    }

    public boolean isItemProtected(Item item) {
        return _protectedItems.contains(item);
    }

    public HashSet<Item> getProtectedItems() {
        return _protectedItems;
    }

    public void protectItem(Item item) {
        _protectedItems.add(item);
    }

    public void stopProtectingItem(Item item) {
        _protectedItems.remove(item);
    }

    public Object getBreakMutex() {
        return breakMutex;
    }

    public Object getPlaceMutex() {
        return placeMutex;
    }

    public Object getPropertiesMutex() {
        return propertiesMutex;
    }

    public Object getGlobalHeuristicMutex() {
        return globalHeuristicMutex;
    }

    public boolean isCanWalkOnEndPortal() {
        return canWalkOnEndPortal;
    }
}
