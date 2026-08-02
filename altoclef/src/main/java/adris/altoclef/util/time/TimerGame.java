package adris.altoclef.util.time;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.mixins.ClientConnectionAccessor;
import net.minecraft.client.Minecraft;
import net.minecraft.network.Connection;

// Simple timer
public class TimerGame extends BaseTimer {

    private Connection _lastConnection;

    public TimerGame(double intervalSeconds) {
        super(intervalSeconds);
    }

    private static double getTime(Connection connection) {
        if (connection == null) return 0;
        return (double) ((ClientConnectionAccessor) connection).getTicks() / 20.0;
    }

    @Override
    protected double currentTime() {
        if (!AltoClef.inGame()) {
            Debug.logError("Running game timer while not in game.");
            return 0;
        }
        // If we change connections, our game time will also be reset. In that case, offset our time to reflect that change.
        Connection currentConnection = null;
        if (Minecraft.getInstance().getConnection() != null) {
            currentConnection = Minecraft.getInstance().getConnection().getConnection();
        }
        if (currentConnection != _lastConnection) {
            if (_lastConnection != null) {
                double prevTimeTotal = getTime(_lastConnection);
                Debug.logInternal("(TimerGame: New connection detected, offsetting by " + prevTimeTotal + " seconds)");
                setPrevTimeForce(getPrevTime() - prevTimeTotal);
            }
            _lastConnection = currentConnection;
        }
        // Use ticks for timing. 20TPS is normal, if we go slower that's fine.
        // Adding a "mod" argument here would be hell across the board. Not happening.
        return getTime(currentConnection);
    }
}
