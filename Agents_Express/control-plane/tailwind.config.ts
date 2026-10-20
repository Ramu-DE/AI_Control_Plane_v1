import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Takeda brand palette — anchored on Takeda red #E1242A (Pantone 1795 C).
        brand: {
          50: "#fdecec",
          100: "#fbd5d6",
          200: "#f5a9ab",
          300: "#ef7d80",
          400: "#e95156",
          500: "#e1242a", // Takeda red
          600: "#c01d23",
          700: "#9a171c",
          800: "#741115",
          900: "#4f0b0e",
        },
      },
    },
  },
  plugins: [],
};

export default config;
