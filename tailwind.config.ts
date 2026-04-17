import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      // A real, 4-step scale. Use these instead of text-sm everywhere so
      // hierarchy is legible at a glance.
      fontSize: {
        // display (page-level H1)
        display: ["28px", { lineHeight: "34px", letterSpacing: "-0.02em", fontWeight: "500" }],
        // section (H2)
        section: ["20px", { lineHeight: "28px", letterSpacing: "-0.01em", fontWeight: "500" }],
        // sub (H3 / card title)
        sub: ["16px", { lineHeight: "22px", letterSpacing: "-0.005em", fontWeight: "500" }],
        // body
        body: ["14px", { lineHeight: "20px", letterSpacing: "0em", fontWeight: "400" }],
        // micro label (uppercase tracked)
        micro: ["11px", { lineHeight: "14px", letterSpacing: "0.08em", fontWeight: "500" }],
        // tiny helper text
        mini: ["12px", { lineHeight: "16px" }],
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
          info: "#0369a1",
        },
      },
      letterSpacing: { tightest: "-0.03em" },
      boxShadow: {
        seam: "0 1px 0 0 rgba(0,0,0,0.04)",
        lift: "0 1px 2px rgba(0,0,0,0.04), 0 8px 28px rgba(0,0,0,0.06)",
        float: "0 2px 6px rgba(0,0,0,0.04), 0 16px 40px rgba(0,0,0,0.08)",
      },
      borderRadius: { xl: "14px", "2xl": "20px" },
      transitionTimingFunction: {
        glide: "cubic-bezier(0.2, 0.7, 0.1, 1)",
        spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
      keyframes: {
        "drawer-in": {
          from: { transform: "translateX(16px)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        "drawer-in-rtl": {
          from: { transform: "translateX(-16px)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "toast-in": {
          from: { transform: "translateY(12px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
        "modal-in": {
          from: { transform: "translateY(8px) scale(0.98)", opacity: "0" },
          to: { transform: "translateY(0) scale(1)", opacity: "1" },
        },
      },
      animation: {
        "drawer-in": "drawer-in 220ms cubic-bezier(0.2, 0.7, 0.1, 1) both",
        "drawer-in-rtl": "drawer-in-rtl 220ms cubic-bezier(0.2, 0.7, 0.1, 1) both",
        "fade-in": "fade-in 180ms ease-out both",
        "toast-in": "toast-in 240ms cubic-bezier(0.34, 1.56, 0.64, 1) both",
        "modal-in": "modal-in 200ms cubic-bezier(0.2, 0.7, 0.1, 1) both",
      },
    },
  },
  plugins: [],
};
export default config;
