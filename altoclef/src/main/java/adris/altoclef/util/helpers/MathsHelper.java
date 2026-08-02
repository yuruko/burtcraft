package adris.altoclef.util.helpers;

import net.minecraft.world.phys.Vec3;

/**
 * Math utilities
 * <p>
 * I'm not British. I swear. I just don't want it to conflict with minecraft's `MathHelper`.
 */
public interface MathsHelper {

    static Vec3 project(Vec3 vec, Vec3 onto, boolean assumeOntoNormalized) {
        if (!assumeOntoNormalized) {
            onto = onto.normalize();
        }
        return onto.scale(vec.dot(onto));
    }

    static Vec3 project(Vec3 vec, Vec3 onto) {
        return project(vec, onto, false);
    }

    static Vec3 projectOntoPlane(Vec3 vec, Vec3 normal, boolean assumeNormalNormalized) {
        Vec3 p = project(vec, normal, assumeNormalNormalized);
        return vec.subtract(p);
    }

    static Vec3 projectOntoPlane(Vec3 vec, Vec3 normal) {
        return projectOntoPlane(vec, normal, false);
    }
}
