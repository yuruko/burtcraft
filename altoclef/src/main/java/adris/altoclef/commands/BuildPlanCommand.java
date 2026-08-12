package adris.altoclef.commands;

import adris.altoclef.AltoClef;
import adris.altoclef.commandsystem.Arg;
import adris.altoclef.commandsystem.ArgParser;
import adris.altoclef.commandsystem.Command;
import adris.altoclef.commandsystem.CommandException;
import adris.altoclef.tasks.construction.ToasterBuildTask;
import adris.altoclef.tasks.construction.blueprint.BuildingPlan;
import adris.altoclef.tasks.construction.blueprint.Blueprints;
import adris.altoclef.tasks.construction.blueprint.Palette;
import adris.altoclef.tasks.construction.settlement.BlueprintSettlement;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Block;

import java.util.List;

/**
 * build one of the procedural blueprints - a shelter, a wood house, an outpost.
 *
 * the footprint is NOT an argument. it comes from the blueprint, the same way the
 * toaster's does: a size the caller can name is a size that can disagree with the
 * plan, and a plan that does not fit its own settlement addresses blocks outside
 * the building.
 */
public final class BuildPlanCommand extends Command {
    public BuildPlanCommand() throws CommandException {
        super("build_plan", "Builds a procedural blueprint (shelter, wood house, outpost) at coordinates",
            new Arg(String.class, "blueprint"),
            new Arg(Integer.class, "x"), new Arg(Integer.class, "y"), new Arg(Integer.class, "z"));
    }

    @Override
    protected void call(AltoClef mod, ArgParser parser) throws CommandException {
        String id = parser.get(String.class).trim().toLowerCase().replace(' ', '_');
        BuildingPlan plan = Blueprints.byId(id);
        if (plan == null) {
            throw new CommandException("unknown blueprint \"" + id + "\" - have: " + String.join(", ", Blueprints.ids()));
        }
        BlockPos anchor = new BlockPos(parser.get(Integer.class), parser.get(Integer.class), parser.get(Integer.class));

        // the wood is whatever she has most of, resolved ONCE here rather than per
        // cell - "uniform, whatever is available" means the whole house agrees, and
        // a per-cell answer would give her a patchwork as her bag changed.
        Block material = Blueprints.shellMaterialFor(plan, plankCounts(mod));

        String role = Blueprints.forRole("homestead").contains(plan) ? "homestead"
            : Blueprints.forRole("outpost").contains(plan) ? "outpost"
            : "shelter";
        try {
            BlueprintSettlement settlement = new BlueprintSettlement(plan.id(), anchor, plan, role, material);
            mod.runUserTask(new ToasterBuildTask(settlement), this::finish);
        } catch (IllegalArgumentException e) {
            throw new CommandException(e.getMessage());
        }
    }

    /** her plank stock, indexed to match {@link Palette#woods()}. */
    private static int[] plankCounts(AltoClef mod) {
        List<Palette.Wood> woods = Palette.woods();
        int[] counts = new int[woods.size()];
        for (int i = 0; i < woods.size(); i++) {
            counts[i] = mod.getItemStorage().getItemCount(woods.get(i).planks.asItem());
        }
        return counts;
    }
}
