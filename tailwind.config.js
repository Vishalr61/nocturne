/** @type {import('tailwindcss').Config} */
// "Soft Dark, cozy & bookish": warm near-black grounds instead of clinical
// true-black, one muted sepia-gold accent carrying all interactive emphasis,
// Lora (serif) for everything you read, Inter for UI plumbing.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        night: {
          950: '#15110b', // app ground
          900: '#120e08', // deepest wells
          800: '#241a0f', // cards / surfaces
          700: '#2c2113', // raised controls
        },
        panel: '#1c150d', // settings drawer
        inset: '#120d07', // sunken control wells
        line: '#2b2013', // hairline borders
        accent: {
          DEFAULT: '#c9a56a', // muted sepia gold — the only accent
          hi: '#e0c088',
          on: '#1a1408', // text on accent fills
        },
        ink: {
          bright: '#f3e8d3', // headings
          head: '#f4ead4', // hero display
          body: '#e6d6bf', // default text
          shelf: '#dccaad', // book titles on the shelf
          mid: '#a08a63', // secondary
          kicker: '#a98d5c', // uppercase section labels
          soft: '#9a875f', // control captions
          dim: '#7c6d52', // metadata
          faint: '#6f6041', // quietest
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        serif: ['Lora', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
}
