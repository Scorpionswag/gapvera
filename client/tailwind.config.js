/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["Fraunces", "Georgia", "serif"],
      },
      colors: {
        // GapVera navy palette. Token names are kept from the old theme so
        // every existing className re-skins by value; only the hexes changed.
        void: "#0a1f44",    // canvas — deep navy
        coal: "#0f2549",    // panels — lifted navy
        ink: "#e6e9ed",     // primary text — light gray
        dim: "#8fa3bc",     // muted text / labels — blue-gray
        ember: "#c24b2e",   // primary accent / brand — rust
        emberhi: "#d6673f", // brighter rust — hovers, highlights
        teal: "#2a5fa8",    // medium blue — "Replied" status
        violet: "#b9d7ec",  // light blue — "Interested"/"In Progress"
        coral: "#e5484d",   // danger — kept red (see note)
        mint: "#57c08a",    // success — kept green (see note)
      },
    },
  },
  plugins: [],
};
