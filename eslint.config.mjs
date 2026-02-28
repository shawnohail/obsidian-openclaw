// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        console: "readonly",
        document: "readonly",
        crypto: "readonly",
        btoa: "readonly",
        atob: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        process: "readonly",
        fetch: "readonly",
      },
    },

    // You can add your own configuration to override or add rules
    rules: {
      semi: ["error", "never"],
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["OpenClaw"]
        },
      ]
    },
  },
]);
