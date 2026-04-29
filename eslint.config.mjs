import obsidian from "eslint-plugin-obsidianmd";

export default [
  ...obsidian.configs.recommendedWithLocalesEn,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: ["main.js", "node_modules/**"],
  },
];
