import nextConfig from "eslint-config-next";
import tseslint from "typescript-eslint";

const config = [
  // `public/vendor/` is third-party code copied in by `scripts/copy-vendor.mjs`
  // (OpenCV, the pdf.js worker); its `Function` constructors are its own.
  { ignores: ["coverage/**", "public/vendor/**"] },
  ...nextConfig,
  {
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-new-func": "error",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "react/no-unescaped-entities": "off",
    },
  },
  {
    files: ["**/*.test.tsx", "**/*.test.ts", "**/*.spec.tsx", "**/*.spec.ts"],
    rules: {
      "@next/next/no-img-element": "off",
      "jsx-a11y/alt-text": "off",
    },
  },
];
export default config;
