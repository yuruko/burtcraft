package adris.altoclef.tasks.construction.settlement;

import net.minecraft.core.BlockPos;

import java.util.ArrayList;
import java.util.List;

/** Shared toaster openings and side-light geometry. */
public final class ToasterGeometry {
    private ToasterGeometry() { }

    public static boolean isEntrance(Settlement s, BlockPos pos) {
        int centre = s.minX() + s.width() / 2;
        return pos.getZ() == s.minZ()
            && pos.getX() >= centre - 1 && pos.getX() <= centre + 1
            && pos.getY() >= s.floorY() + 1 && pos.getY() <= s.floorY() + 2;
    }

    public static boolean isToastSlot(Settlement s, BlockPos pos) {
        if (pos.getY() != s.roofY()) return false;
        int centreZ = s.minZ() + s.depth() / 2;
        int firstZ = Math.max(s.minZ() + 2, centreZ - 2);
        int secondZ = Math.min(s.maxZ() - 2, centreZ + 2);
        return (pos.getZ() == firstZ || pos.getZ() == secondZ)
            && pos.getX() >= s.minX() + 3 && pos.getX() <= s.maxX() - 3;
    }

    public static List<BlockPos> torchPositions(Settlement s) {
        List<BlockPos> result = new ArrayList<>();
        int y = Math.min(s.roofY() - 2, s.floorY() + 3);
        for (int z = s.minZ() + 2; z <= s.maxZ() - 2; z += 4) {
            result.add(new BlockPos(s.minX() - 1, y, z));
            result.add(new BlockPos(s.maxX() + 1, y, z));
        }
        return result;
    }
}
