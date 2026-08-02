package adris.altoclef.util;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.recipebook.RecipeCollection;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.Holder;
import net.minecraft.util.context.ContextMap;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.display.RecipeDisplayEntry;
import net.minecraft.world.item.crafting.display.SlotDisplayContext;

import java.util.*;
import java.util.stream.Collectors;

/**
 * For crafting table/inventory recipe book crafting, we need to figure out identifiers given a recipe.
 */
public class JankCraftingRecipeMapping {
    private static final HashMap<Item, List<RecipeDisplayEntry>> _recipeMapping = new HashMap<>();

    /**
     * Reloads the recipe mapping.
     */
    private static void reloadRecipeMapping() {
        Minecraft client = Minecraft.getInstance();
        LocalPlayer player = client.player;
        ClientLevel world = client.level;

        // 26.1: the client is no longer sent whole Recipe objects. the recipe book holds
        // RecipeDisplayEntry (id + display + crafting requirements) instead, which is all
        // the place-recipe packet actually needs, so build the mapping off of that.
        if (player == null || world == null) return;

        ContextMap context = SlotDisplayContext.fromLevel(world);
        _recipeMapping.clear();
        for (RecipeCollection collection : player.getRecipeBook().getCollections()) {
            for (RecipeDisplayEntry entry : collection.getRecipes()) {
                for (ItemStack result : entry.resultItems(context)) {
                    if (result.isEmpty()) continue;
                    _recipeMapping.computeIfAbsent(result.getItem(), k -> new ArrayList<>()).add(entry);
                }
            }
        }
    }

    /**
     * Retrieves the mapped recipe for a given output item from the Minecraft crafting recipe.
     *
     * @param recipe The crafting recipe to check against.
     * @param output The output item of the recipe.
     * @return An Optional containing the mapped recipe entry if found, or an empty Optional if not found.
     */
    public static Optional<RecipeDisplayEntry> getMinecraftMappedRecipe(CraftingRecipe recipe, Item output) {
        reloadRecipeMapping();
        // Check if the output item is present in the recipe mapping
        if (_recipeMapping.containsKey(output)) {
            // Iterate through all the recipes mapped to the output item
            for (RecipeDisplayEntry checkRecipe : _recipeMapping.get(output)) {
                Optional<List<Ingredient>> requirements = checkRecipe.craftingRequirements();
                // Check if the recipe has ingredients
                if (requirements.isEmpty() || requirements.get().isEmpty()) {
                    continue;
                }
                // Create a list of item targets to satisfy
                List<ItemTarget> toSatisfy = Arrays.stream(recipe.getSlots())
                        .filter(itemTarget -> itemTarget != null && !itemTarget.isEmpty())
                        .collect(Collectors.toList());
                // Iterate through the ingredients of the recipe
                for (Ingredient ingredient : requirements.get()) {
                    // Skip empty ingredients
                    if (ingredient.isEmpty()) {
                        continue;
                    }
                    // Iterate through the items to satisfy
                    outer:
                    for (int i = 0; i < toSatisfy.size(); ++i) {
                        ItemTarget target = toSatisfy.get(i);
                        // Check if any of the ingredient's matching items matches the item target
                        for (Holder<Item> holder : ingredient.items().toList()) {
                            if (target.matches(holder.value())) {
                                toSatisfy.remove(i);
                                break outer;
                            }
                        }
                    }
                }
                // Check if all the item targets have been satisfied
                if (toSatisfy.isEmpty()) {
                    return Optional.of(checkRecipe);
                }
            }
        }
        return Optional.empty();
    }
}
