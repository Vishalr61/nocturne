/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        night: {
          950: '#050506',
          900: '#0b0b0e',
          800: '#14141a',
          700: '#1e1e26',
        },
      },
    },
  },
  plugins: [],
}
