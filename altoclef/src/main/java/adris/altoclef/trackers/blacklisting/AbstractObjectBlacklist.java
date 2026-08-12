package adris.altoclef.trackers.blacklisting;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.util.MiningRequirement;
import adris.altoclef.util.helpers.StorageHelper;
import net.minecraft.world.phys.Vec3;

import java.util.HashMap;

/**
 * Sometimes we will try to access something and fail TOO many times.
 * <p>
 * This lets us know that a block is unreachable, and will ignore it from the search intelligently.
 */
public abstract class AbstractObjectBlacklist<T> {

    private final HashMap<T, BlacklistEntry> _entries = new HashMap<>();

    /**
     * How much closer, IN BLOCKS, a new attempt must get before it counts as real
     * progress and forgives the failures so far.
     * <p>
     * The comparison used to be {@code newDistance < bestDistanceSq - 1} - and
     * BOTH those values are SQUARED distances while the {@code 1} is not. At the
     * ~20 blocks these failures actually happen at, bestDistanceSq is ~400, so
     * subtracting 1 asked for an improvement of about 0.025 blocks. The comment
     * promised "a slight threshold so it doesn't reset EVERY time we move a tiny
     * bit closer"; the arithmetic delivered the opposite.
     */
    private static final double RESET_MARGIN_BLOCKS = 2.0;

    /**
     * Whether getting closer is evidence that this item is becoming reachable.
     * <p>
     * TRUE for blocks, whose position is fixed: closing the distance really does
     * mean the approach is working. FALSE for entities, because
     * {@code EntityLocateBlacklist.getPos} reads the mob's LIVE position - so the
     * "distance" is mostly the mob's own movement, and a zombie stepping toward
     * her reads identically to her making progress toward it. A mob that chases
     * her, or one on the far side of water while she paces the shore, therefore
     * produced a new all-time minimum on nearly every failure and reset the
     * counter forever. Observed live on 2026-08-08 as the same drowned reaching
     * "Try 4 / 3" and then "Blacklist RESET" instead of being dropped.
     */
    protected boolean resetsOnGettingCloser() {
        return true;
    }

    /**
     * Has this attempt got meaningfully closer than the best so far?
     * <p>
     * Both arguments are SQUARED distances, which is exactly what the old inline
     * test forgot: it read {@code newDistanceSq < bestDistanceSq - 1}, mixing a
     * squared quantity with a linear margin. The real tolerance that produced was
     * {@code d - sqrt(d*d - 1)} blocks - about 0.5 blocks at d=1, but only 0.025
     * blocks at d=20, which is where these failures actually happen. Pulled out as
     * a pure function so the arithmetic can be tested without a running game; see
     * tmp/probe/BlacklistMathProbe.java.
     * <p>
     * An infinite best (the very first failure) is not an improvement to beat - it
     * only records where we started.
     */
    static boolean isMeaningfullyCloser(double bestDistanceSq, double newDistanceSq) {
        if (!Double.isFinite(bestDistanceSq)) return false;
        if (!(newDistanceSq < bestDistanceSq)) return false;
        return Math.sqrt(bestDistanceSq) - Math.sqrt(newDistanceSq) >= RESET_MARGIN_BLOCKS;
    }

    public void blackListItem(AltoClef mod, T item, int numberOfFailuresAllowed) {
        if (!_entries.containsKey(item)) {
            BlacklistEntry entry = new BlacklistEntry();
            entry.numberOfFailuresAllowed = numberOfFailuresAllowed;
            entry.numberOfFailures = 0;
            entry.bestDistanceSq = Double.POSITIVE_INFINITY;
            entry.bestTool = MiningRequirement.HAND;
            _entries.put(item, entry);
        }
        BlacklistEntry entry = _entries.get(item);
        double newDistance = getPos(item).distanceToSqr(mod.getPlayer().position());
        MiningRequirement newTool = StorageHelper.getCurrentMiningRequirement(mod);
        // Compare in BLOCKS, not in squared blocks - see RESET_MARGIN_BLOCKS.
        boolean betterTool = newTool.ordinal() > entry.bestTool.ordinal();
        boolean meaningfullyCloser = resetsOnGettingCloser()
                && isMeaningfullyCloser(entry.bestDistanceSq, newDistance);
        if (betterTool || meaningfullyCloser) {
            if (betterTool) entry.bestTool = newTool;
            if (newDistance < entry.bestDistanceSq) entry.bestDistanceSq = newDistance;
            entry.numberOfFailures = 0;
            Debug.logMessage("Blacklist RESET: " + item.toString());
        } else if (newDistance < entry.bestDistanceSq) {
            // still the closest we have been, but not by enough to forgive anything.
            entry.bestDistanceSq = newDistance;
        }
        entry.numberOfFailures++;
        entry.numberOfFailuresAllowed = numberOfFailuresAllowed;
        Debug.logMessage("Blacklist: " + item.toString() + ": Try " + entry.numberOfFailures + " / " + entry.numberOfFailuresAllowed);
    }

    protected abstract Vec3 getPos(T item);

    public boolean unreachable(T item) {
        if (_entries.containsKey(item)) {
            BlacklistEntry entry = _entries.get(item);
            return entry.numberOfFailures > entry.numberOfFailuresAllowed;
        }
        return false;
    }

    public void clear() {
        _entries.clear();
    }

    // Key: BlockPos
    private static class BlacklistEntry {
        public int numberOfFailuresAllowed;
        public int numberOfFailures;
        public double bestDistanceSq;
        public MiningRequirement bestTool;
    }
}
