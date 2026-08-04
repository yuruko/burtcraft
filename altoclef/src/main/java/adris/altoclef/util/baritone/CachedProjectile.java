package adris.altoclef.util.baritone;

import adris.altoclef.util.time.TimerGame;
import net.minecraft.world.phys.Vec3;

import java.lang.reflect.Type;

public class CachedProjectile {
    private final TimerGame _lastCache = new TimerGame(2);
    public Vec3 velocity;
    public Vec3 position;
    public double gravity;
    public Type projectileType;
    private Vec3 _cachedHit;
    private boolean _cacheHeld = false;

    public Vec3 getCachedHit() {
        return _cachedHit;
    }

    public void setCacheHit(Vec3 cache) {
        _cachedHit = cache;
        _cacheHeld = true;
        _lastCache.reset();
    }

    public boolean needsToRecache() {
        return !_cacheHeld || _lastCache.elapsed();
    }
}
