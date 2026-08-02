package adris.altoclef.util.serialization;

import net.minecraft.world.phys.Vec3;

import java.util.Arrays;
import java.util.Collection;

public class Vec3dSerializer extends AbstractVectorSerializer<Vec3> {
    @Override
    protected Collection<String> getParts(Vec3 value) {
        return Arrays.asList("" + value.x(), "" + value.y(), "" + value.z());
    }
}
