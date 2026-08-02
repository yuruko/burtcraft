package adris.altoclef.util.progresscheck;

import net.minecraft.world.phys.Vec3;

public class DistanceProgressChecker implements IProgressChecker<Vec3> {

    private final IProgressChecker<Double> _distanceChecker;
    private final boolean _reduceDistance;
    private Vec3 _start;
    private Vec3 _prevPos;

    public DistanceProgressChecker(IProgressChecker<Double> distanceChecker, boolean reduceDistance) {
        _distanceChecker = distanceChecker;
        _reduceDistance = reduceDistance;
        if (reduceDistance) {
            _distanceChecker.setProgress(Double.NEGATIVE_INFINITY);
        }
        reset();
    }

    public DistanceProgressChecker(double timeout, double minDistanceToMake, boolean reduceDistance) {
        this(new LinearProgressChecker(timeout, minDistanceToMake), reduceDistance);
    }

    public DistanceProgressChecker(double timeout, double minDistanceToMake) {
        this(timeout, minDistanceToMake, false);
    }

    @Override
    public void setProgress(Vec3 position) {
        if (_start == null) {
            _start = position;
            return;
        }
        double delta = position.distanceTo(_start);
        // If we want to reduce distance, penalize distance.
        if (_reduceDistance) delta *= -1;
        _prevPos = position;
        _distanceChecker.setProgress(delta);
    }

    @Override
    public boolean failed() {
        return _distanceChecker.failed();
    }

    @Override
    public void reset() {
        _start = null;//_prevPos;
        _distanceChecker.setProgress(0.0);
        _distanceChecker.reset();
    }
}
