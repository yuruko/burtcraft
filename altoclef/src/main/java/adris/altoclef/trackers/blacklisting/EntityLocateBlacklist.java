package adris.altoclef.trackers.blacklisting;

import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;

public class EntityLocateBlacklist extends AbstractObjectBlacklist<Entity> {
    @Override
    protected Vec3 getPos(Entity item) {
        return item.position();
    }

    /**
     * A mob MOVES, so distance to it is not evidence about our own approach.
     * <p>
     * getPos above reads the live position, so a zombie walking one step toward
     * her is indistinguishable from her closing the gap - and the failure loop
     * itself (wander 5 blocks, walk back) manufactures a new minimum every cycle.
     * The counter reset on nearly every strike and "unreachable" was unreachable.
     * Failures against an entity are forgiven only by a genuinely better tool.
     */
    @Override
    protected boolean resetsOnGettingCloser() {
        return false;
    }
}
