/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f4f2ff',
          200: '#d6d0ff',
          300: '#b6a9ff',
          500: '#7a5cff',
          600: '#6a4cff',
          700: '#5c3fe0',
        },
      },
    },
  },
  plugins: [],
};
