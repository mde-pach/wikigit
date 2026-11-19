import { repoContent, type Wiki } from "./mock-engine";

export const TENANT = (label: string, path = "/") =>
  `http://${label}.wikigit.org:4329${path}`;

export const flagship: Wiki = { repo: "mde-pach/wikigit", files: repoContent() };

export const recipes: Wiki = {
  repo: "wikigit-tenants/recipes",
  config: { title: "Grandma's Recipes", tagline: "The family cookbook" },
  files: {
    index: [
      "---",
      "tags: [cooking, family]",
      "hatnote: Not to be confused with the restaurant menu.",
      "---",
      "# Recipes",
      "",
      "Welcome to the **family cookbook**. Start with [[soup]] or [[bread]].",
      "",
      "## Starters",
      "",
      "Light dishes to open a meal.",
      "",
      "## Mains",
      "",
      "The heart of Sunday lunch.",
      "",
      "### Sauces",
      "",
      "Every main deserves one.",
      "",
      "## Desserts",
      "",
      "Saved for last.",
      "",
    ].join("\n"),
    soup: "# Soup\n\nA warm bowl.\n\n## Ingredients\n\n- water\n- salt\n",
  },
};
