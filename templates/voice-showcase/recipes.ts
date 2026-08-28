/** Hardcoded short recipes for the voice showcase. */

export interface Recipe {
  title: string;
  keywords: string[];
  steps: string;
}

export const RECIPES: readonly Recipe[] = [
  {
    title: "Quick garlic pasta",
    keywords: ["pasta", "noodle", "spaghetti", "italian"],
    steps:
      "Boil pasta until al dente. Sauté minced garlic in olive oil, toss with pasta, parmesan, and black pepper. Serve hot.",
  },
  {
    title: "Simple vegetable soup",
    keywords: ["soup", "broth", "stew"],
    steps:
      "Sauté onion and carrot in a pot. Add vegetable stock, diced potatoes, and simmer twenty minutes. Season with salt and herbs.",
  },
  {
    title: "Easy breakfast scramble",
    keywords: ["breakfast", "eggs", "morning", "brunch"],
    steps:
      "Whisk three eggs with a splash of milk. Cook in a buttered pan with spinach and cheese. Fold and serve with toast.",
  },
  {
    title: "Classic chocolate chip cookies",
    keywords: ["cookie", "cookies", "dessert", "sweet", "bake"],
    steps:
      "Cream butter and sugar, mix in flour, egg, and chocolate chips. Drop spoonfuls on a tray and bake at one seventy five Celsius for ten minutes.",
  },
  {
    title: "Fresh garden salad",
    keywords: ["salad", "greens", "vegetable", "healthy"],
    steps:
      "Toss mixed greens with cherry tomatoes, cucumber, and feta. Dress with olive oil, lemon juice, salt, and pepper.",
  },
] as const;

const DEFAULT_RECIPE = RECIPES[0]!;

/** Match a recipe by keywords in the utterance, or return the default. */
export function pickRecipe(utterance: string): Recipe {
  const lower = utterance.toLowerCase();
  for (const recipe of RECIPES) {
    if (recipe.keywords.some((kw) => lower.includes(kw))) {
      return recipe;
    }
  }
  return DEFAULT_RECIPE;
}

export function formatRecipeSpeech(recipe: Recipe): string {
  return `${recipe.title}. ${recipe.steps}`;
}
