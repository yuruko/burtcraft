package adris.altoclef.util.baritone;


import baritone.api.pathing.goals.Goal;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.phys.Vec3;
import net.minecraft.core.Vec3i;

public class GoalBlockSide implements Goal {

    private final BlockPos _block;
    private final Direction _direction;
    private final double _buffer;

    public GoalBlockSide(BlockPos block, Direction direction, double bufferDistance) {
        this._block = block;
        this._direction = direction;
        this._buffer = bufferDistance;
    }

    public GoalBlockSide(BlockPos block, Direction direction) {
        this(block, direction, 1);
    }

    @Override
    public boolean isInGoal(int x, int y, int z) {
        // We are on the right side
        return getDistanceInRightDirection(x, y, z) > 0;
    }

    @Override
    public double heuristic(int x, int y, int z) {
        // A* MINIMISES THIS, so a wrong-side position must cost MORE, not less.
        // `Math.min(dist, 0)` scored the correct side 0 and the wrong side
        // NEGATIVE, i.e. the search was actively pulled to the side it is meant to
        // avoid. zero once she is far enough round, rising the further the wrong
        // way she is.
        return Math.max(0, -getDistanceInRightDirection(x, y, z));
    }

    private double getDistanceInRightDirection(int x, int y, int z) {
        Vec3 delta = new Vec3(x, y, z).subtract(_block.getX(), _block.getY(), _block.getZ());
        Vec3i dir = _direction.getUnitVec3i();
        double dot = new Vec3(dir.getX(), dir.getY(), dir.getZ()).dot(delta);
        // WE ASSUME THAT dir IS NORMALIZED
        double distCorrect = dot;
        return distCorrect - this._buffer;
    }
}
