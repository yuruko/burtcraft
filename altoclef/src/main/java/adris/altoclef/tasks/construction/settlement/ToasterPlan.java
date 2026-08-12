package adris.altoclef.tasks.construction.settlement;

/**
 * GENERATED - DO NOT EDIT BY HAND.
 *
 *   node tmp/gen_toaster_plan.mjs "<New Project.schematic>"
 *
 * THE TOASTER, one map per layer. She is a toast girl and she lives in a
 * toaster, so the silhouette is the point: a solid base, two slots cut clean
 * through the roof, furnace banks lining them as the elements, and the lever
 * slot up the front face with a torch either side of the step.
 *
 * A single 2D map extruded upward cannot describe any of that, which is why
 * this is layered. Layer 0 is the floor course.
 *
 *   W shell (material rises by tier)   . interior air
 *   F furnace   C chest   K crafting table   B bed
 *   T floor torch   t wall torch (the two by the door)
 *   D walk-through   S intentional opening (toast slots + lever slot)
 *
 * 13 wide x 21 long x 11 tall - .:1304 B:2 C:32 D:2 F:320 K:3 S:108 T:104 W:1126 t:2
 */
public final class ToasterPlan {
    private ToasterPlan() { }

    /** One map per layer, layer 0 = the floor course. */
    public static final String[][] LAYERS = {
        // layer 0
        {
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            ".....WWW.....",
            ".....WWW....."
        },
        // layer 1
        {
            "WWWWWWWWWWWWW",
            "WCCCW...WCCCW",
            "W...........W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W...........W",
            "WCCCW...WCCCW",
            "WWWWWWDWWWWWW",
            ".............",
            "............."
        },
        // layer 2
        {
            "WWWWWWWWWWWWW",
            "WCCW.....WCCW",
            "W...........W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W...........W",
            "WCCW.....WCCW",
            "WWWWWWDWWWWWW",
            ".....t.t.....",
            "............."
        },
        // layer 3
        {
            "WWWWWWWWWWWWW",
            "WCW.......WCW",
            "W...........W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W...........W",
            "WCW.......WCW",
            "WWWWWWWWWWWWW",
            ".............",
            "............."
        },
        // layer 4
        {
            "WWWWWWWWWWWWW",
            "WW....K....WW",
            "WW.........WW",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "WWW.......WWW",
            "WW.........WW",
            "WWWWWWSWWWWWW",
            ".............",
            "............."
        },
        // layer 5
        {
            "WWWWWWWWWWWWW",
            "W....WWW....W",
            "W.WWWWWWWWW.W",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "W.WWWWWWWWW.W",
            "W....WWW....W",
            "WWWWWWSWWWWWW",
            ".............",
            "............."
        },
        // layer 6
        {
            "WWWWWWWWWWWWW",
            "W....FBF....W",
            "W.....B.....W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W...........W",
            "W....C.C....W",
            "WWWWWWSWWWWWW",
            ".............",
            "............."
        },
        // layer 7
        {
            "WWWWWWWWWWWWW",
            "W....F.F....W",
            "W...........W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W...........W",
            "W....CWC....W",
            "WWWWWWWWWWWWW",
            "......W......",
            "....WWWWW...."
        },
        // layer 8
        {
            "WWWWWWWWWWWWW",
            "W....F.F....W",
            "W...........W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W.F..F.F..F.W",
            "W...........W",
            "W....C.C....W",
            "WWWWWWSWWWWWW",
            ".............",
            "............."
        },
        // layer 9
        {
            "WWWWWWWWWWWWW",
            "W....FKF....W",
            "W...........W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W.T..T.T..T.W",
            "W...........W",
            "W....CKC....W",
            "WWWWWWWWWWWWW",
            ".............",
            "............."
        },
        // layer 10
        {
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWSSWWWSSWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            "WWWWWWWWWWWWW",
            ".............",
            "............."
        }
    };
}
