package adris.altoclef.tasks.construction.blueprint;

import adris.altoclef.tasks.construction.settlement.ToasterTier;

import java.util.EnumMap;
import java.util.Map;

/**
 * A BUILDING, DESCRIBED RATHER THAN DRAWN.
 *
 * the toaster is a hand-built schematic and it has to be - its whole point is a
 * silhouette no rule could have produced. everything else she builds is a box
 * with a roof, a door, somewhere to sleep and somewhere to smelt, and typing
 * five more ascii maps to say that is five more places for java and node to
 * drift apart.
 *
 * so a spec says WHAT, and {@link ProceduralPlan} works out WHERE. every field
 * here is a number or a flag; there is no geometry in this class at all.
 *
 * TWO AXES, exactly as {@link ToasterTier} splits them:
 *
 *   COUNT - how many of a thing the finished house has. zero means the feature
 *   is off, which is why {@link #enabled(Feature)} is just "count > 0" and there
 *   is no separate boolean to fall out of sync with it.
 *
 *   STAGE - when she is allowed to start owing it. every stage is a superset of
 *   the one before, so growing never moves anything she already placed.
 */
public final class BlueprintSpec {

    /**
     * everything a procedural plan can be asked for.
     *
     * a FEATURE, not a glyph: TORCHES_INSIDE and TORCHES_OUTSIDE both write 't'
     * and can sit on different stages, so stage gating has to key off this and
     * never off the letter.
     */
    public enum Feature {
        FLOOR,
        WALLS,
        ROOF,
        DOOR,
        WINDOWS,
        PORCH,
        BED,
        CRAFTING_TABLE,
        CHESTS,
        FURNACES,
        TORCHES_INSIDE,
        TORCHES_OUTSIDE
    }

    private final String id;
    private final String role;
    private final int width;
    private final int depth;
    private final int height;
    private final Palette.Kind palette;
    private final boolean gableRoof;
    private final int porchDepth;
    private final Map<Feature, Integer> counts;
    private final Map<Feature, ToasterTier.Stage> stages;

    private BlueprintSpec(Builder b) {
        this.id = b.id;
        this.role = b.role;
        this.width = b.width;
        this.depth = b.depth;
        this.height = b.height;
        this.palette = b.palette;
        this.gableRoof = b.gableRoof;
        this.porchDepth = b.porchDepth;
        this.counts = new EnumMap<>(b.counts);
        this.stages = new EnumMap<>(b.stages);
    }

    public String id() { return id; }
    public String role() { return role; }
    public int width() { return width; }
    public int depth() { return depth; }
    public int height() { return height; }
    public Palette.Kind palette() { return palette; }
    public boolean gableRoof() { return gableRoof; }

    /** how far the porch deck reaches out from the entrance wall. "expand porch" raises this. */
    public int porchDepth() { return enabled(Feature.PORCH) ? porchDepth : 0; }

    /** how many of this feature the finished house has. 0 = the feature is off. */
    public int count(Feature feature) {
        Integer n = counts.get(feature);
        return n == null ? 0 : n;
    }

    public boolean enabled(Feature feature) { return count(feature) > 0; }

    /** the earliest stage that owes this feature. never null for an enabled feature. */
    public ToasterTier.Stage stageOf(Feature feature) {
        ToasterTier.Stage stage = stages.get(feature);
        return stage == null ? ToasterTier.Stage.FULL : stage;
    }

    /**
     * does this stage owe this feature yet?
     *
     * deliberately NOT routed through {@link ToasterTier#budgetFor}. that
     * function exists to ration a 1589-block hand-drawn plan down to something
     * she can finish in a night - it clamps chests to two and torches to twelve
     * because the toaster holds thirty-two and a hundred and six. a procedural
     * spec has already declared exactly how many of each it wants, and they are
     * single digits; rationing them again would just make the number in the spec
     * a lie.
     */
    public boolean inStage(Feature feature, ToasterTier.Stage stage) {
        if (!enabled(feature)) return false;
        return stage.ordinal() >= stageOf(feature).ordinal();
    }

    @Override
    public String toString() {
        return id + " (" + role + " " + width + "x" + depth + "x" + height + " " + palette + ")";
    }

    public static Builder of(String id, String role, int width, int depth, int height, Palette.Kind palette) {
        return new Builder(id, role, width, depth, height, palette);
    }

    /**
     * LOUD ON THE WAY IN.
     *
     * every guard here is a shape {@link ProceduralPlan} cannot lay out, and a
     * spec that cannot be laid out must fail at the registry rather than at the
     * moment she walks up to the site with a stack of planks.
     */
    public static final class Builder {
        private final String id;
        private final String role;
        private final int width;
        private final int depth;
        private final int height;
        private final Palette.Kind palette;
        private boolean gableRoof;
        private int porchDepth;
        private final Map<Feature, Integer> counts = new EnumMap<>(Feature.class);
        private final Map<Feature, ToasterTier.Stage> stages = new EnumMap<>(Feature.class);

        private Builder(String id, String role, int width, int depth, int height, Palette.Kind palette) {
            if (id == null || id.isBlank()) throw new IllegalArgumentException("blueprint spec needs an id");
            if (role == null || role.isBlank()) throw new IllegalArgumentException(id + ": blueprint spec needs a role");
            if (palette == null) throw new IllegalArgumentException(id + ": blueprint spec needs a palette");
            // 5x5x5 is the floor, and it is Settlement's floor, not one invented
            // here - Settlement refuses anything under five in any dimension and
            // every plan has to be carryable by one. it is also the smallest
            // footprint with an interior ring to hang fixtures on, and floor +
            // three wall courses + roof is the shortest thing that reads as a
            // room rather than a crawlspace on stream.
            if (width < 5 || depth < 5) throw new IllegalArgumentException(id + ": footprint must be at least 5x5, got " + width + "x" + depth);
            if (height < 5) throw new IllegalArgumentException(id + ": height must be at least 5, got " + height);
            if (width > 64 || depth > 64 || height > 64) throw new IllegalArgumentException(id + ": nothing here is 64 blocks across");
            this.id = id;
            this.role = role;
            this.width = width;
            this.depth = depth;
            this.height = height;
            this.palette = palette;
        }

        private Builder set(Feature feature, int count, ToasterTier.Stage stage) {
            if (count < 0) throw new IllegalArgumentException(id + ": " + feature + " count cannot be negative");
            if (count > 0 && stage == null) throw new IllegalArgumentException(id + ": " + feature + " needs a stage");
            if (count == 0) {
                counts.remove(feature);
                stages.remove(feature);
                return this;
            }
            counts.put(feature, count);
            stages.put(feature, stage);
            return this;
        }

        /** floor, walls, roof and door in one go - the silhouette is never split up. */
        public Builder shell(ToasterTier.Stage stage) {
            set(Feature.FLOOR, 1, stage);
            set(Feature.WALLS, 1, stage);
            set(Feature.ROOF, 1, stage);
            set(Feature.DOOR, 1, stage);
            return this;
        }

        public Builder gableRoof() { this.gableRoof = true; return this; }
        public Builder bed(ToasterTier.Stage stage) { return set(Feature.BED, 1, stage); }
        public Builder craftingTable(ToasterTier.Stage stage) { return set(Feature.CRAFTING_TABLE, 1, stage); }
        public Builder windows(ToasterTier.Stage stage) { return set(Feature.WINDOWS, 1, stage); }
        public Builder chests(int n, ToasterTier.Stage stage) { return set(Feature.CHESTS, n, stage); }
        public Builder furnaces(int n, ToasterTier.Stage stage) { return set(Feature.FURNACES, n, stage); }
        public Builder torchesInside(int n, ToasterTier.Stage stage) { return set(Feature.TORCHES_INSIDE, n, stage); }
        public Builder torchesOutside(int n, ToasterTier.Stage stage) { return set(Feature.TORCHES_OUTSIDE, n, stage); }

        public Builder porch(int depthOut, ToasterTier.Stage stage) {
            if (depthOut < 1) throw new IllegalArgumentException(id + ": a porch reaches at least one block out");
            this.porchDepth = depthOut;
            return set(Feature.PORCH, 1, stage);
        }

        public BlueprintSpec build() {
            // THE FOUR THINGS THAT MAKE IT A HOUSE. a shelter with no floor is a
            // hole, and one with no bed is a place she dies at 3am - both of them
            // still survey as "finished", which is the failure that matters.
            require(Feature.FLOOR, "a floor");
            require(Feature.DOOR, "a door opening");
            require(Feature.BED, "a bed");
            require(Feature.CRAFTING_TABLE, "a crafting table");
            return new BlueprintSpec(this);
        }

        private void require(Feature feature, String english) {
            Integer n = counts.get(feature);
            if (n == null || n <= 0) throw new IllegalStateException(id + ": every plan needs " + english);
        }
    }
}
