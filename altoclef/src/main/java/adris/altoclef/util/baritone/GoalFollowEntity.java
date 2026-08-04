package adris.altoclef.util.baritone;

import baritone.api.pathing.goals.Goal;
import baritone.api.pathing.goals.GoalBlock;
import net.minecraft.world.entity.Entity;
import net.minecraft.core.BlockPos;

public class GoalFollowEntity implements Goal {

    private final Entity _entity;
    private final double _closeEnoughDistance;

    public GoalFollowEntity(Entity entity, double closeEnoughDistance) {
        _entity = entity;
        _closeEnoughDistance = closeEnoughDistance;
    }

    @Override
    public boolean isInGoal(int x, int y, int z) {
        BlockPos p = new BlockPos(x, y, z);
        return _entity.blockPosition().equals(p) || p.closerToCenterThan(_entity.position(), _closeEnoughDistance);
    }

    @Override
    public double heuristic(int x, int y, int z) {
        //synchronized (BaritoneHelper.MINECRAFT_LOCK) {
        double xDiff = x - _entity.position().x();
        int yDiff = y - _entity.blockPosition().getY();
        double zDiff = z - _entity.position().z();
        return GoalBlock.calculate(xDiff, yDiff, zDiff);
        //}
    }
}
