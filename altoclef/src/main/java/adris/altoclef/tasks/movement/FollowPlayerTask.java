package adris.altoclef.tasks.movement;

import adris.altoclef.AltoClef;
import adris.altoclef.tasksystem.Task;
import net.minecraft.world.entity.player.Player;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

import java.util.Optional;

public class FollowPlayerTask extends Task {

    private static final long FIRST_SIGHT_TIMEOUT_MS = 30_000L;
    private final String _playerName;
    private long _startedAt;

    public FollowPlayerTask(String playerName) {
        _playerName = playerName;
    }

    @Override
    protected void onStart(AltoClef mod) {
        _startedAt = System.currentTimeMillis();
    }

    @Override
    protected Task onTick(AltoClef mod) {

        Optional<Vec3> lastPos = mod.getEntityTracker().getPlayerMostRecentPosition(_playerName);

        if (lastPos.isEmpty()) {
            if (System.currentTimeMillis() - _startedAt >= FIRST_SIGHT_TIMEOUT_MS) {
                mod.logWarning("Could not follow \"" + _playerName + "\": player never entered tracking range.");
                stop(mod);
                return null;
            }
            setDebugState("Waiting for " + _playerName + " to enter tracking range.");
            return null;
        }
        Vec3 target = lastPos.get();

        if (target.closerThan(mod.getPlayer().position(), 1) && !mod.getEntityTracker().isPlayerLoaded(_playerName)) {
            mod.logWarning("Failed to get to player \"" + _playerName + "\". We moved to where we last saw them but now have no idea where they are.");
            stop(mod);
            return null;
        }

        Optional<Player> player = mod.getEntityTracker().getPlayerEntity(_playerName);
        if (player.isEmpty()) {
            // Go to last location
            return new GetToBlockTask(new BlockPos((int) target.x, (int) target.y, (int) target.z), false);
        }
        return new GetToEntityTask(player.get(), 2);
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {

    }

    @Override
    protected boolean isEqual(Task other) {
        if (other instanceof FollowPlayerTask task) {
            return task._playerName.equalsIgnoreCase(_playerName);
        }
        return false;
    }

    @Override
    protected String toDebugString() {
        return "Going to player " + _playerName;
    }
}
