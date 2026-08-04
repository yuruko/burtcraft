package adris.altoclef.util.baritone;

import baritone.api.pathing.goals.Goal;
import baritone.api.pathing.goals.GoalXZ;
import net.minecraft.world.level.ChunkPos;

public class GoalChunk implements Goal {

    private final ChunkPos _pos;

    public GoalChunk(ChunkPos pos) {
        _pos = pos;
    }

    @Override
    public boolean isInGoal(int x, int y, int z) {
        return _pos.getMinBlockX() <= x && x <= _pos.getMaxBlockX() &&
                _pos.getMinBlockZ() <= z && z <= _pos.getMaxBlockZ();
    }

    @Override
    public double heuristic(int x, int y, int z) {
        double cx = (_pos.getMinBlockX() + _pos.getMaxBlockX()) / 2.0, cz = (_pos.getMinBlockZ() + _pos.getMaxBlockZ()) / 2.0;
        return GoalXZ.calculate(cx - x, cz - z);
    }
}
