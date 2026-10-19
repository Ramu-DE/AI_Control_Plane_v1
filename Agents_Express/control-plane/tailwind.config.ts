import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef5ff",
          100: "#d9e8ff",
          400: "#4d94ff",
          500: "#1a74ff",
          600: "#0b5ed7",
          700: "#0a4fb4",
        },
      },
    },
  },
  plugins: [],
};

export default config;
