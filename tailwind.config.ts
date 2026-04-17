import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      colors: {
        ink: {
          0: "#ffffff",
          50: "#fafafa",
          100: "#f3f3f2",
          200: "#e8e8e6",
          300: "#c9c9c5",
          400: "#8e8e8a",
          500: "#5a5a57",
          600: "#3a3a38",
          700: "#222221",
          800: "#141414",
          900: "#0a0a0a",
        },
        signal: {
          live: "#16a34a",
          wait: "#a1a1aa",
          fail: "#b91c1c",
          hold: "#a16207",
        },
      },
      letterSpacing: { tightest: "-0.03em" },
      boxShadow: {
        seam: "0 1px 0 0 rgba(0,0,0,0.04)",
        lift: "0 1px 2px rgba(0,0,0,0.04), 0 8px 28px rgba(0,0,0,0.06)",
      },
      borderRadius: { xl: "14px", "2xl": "20px" },
      transitionTimingFunction: {
        glide: "cubic-bezier(0.2, 0.7, 0.1, 1)",
      },
    },
  },
  plugins: [],
};
export default config;
