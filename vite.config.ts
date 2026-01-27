import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  // We removed "root: 'public'" because your HTML files are now in the main project folder
  build: {
    rollupOptions: {
      input: {
        // Tells Vite to build index.html as the main entry
        main: resolve(__dirname, 'index.html'),
        // Tells Vite to build admin.html as the second entry
        admin: resolve(__dirname, 'admin.html'),
      },
    },
    // The output will go into the 'dist' folder at the root
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 8888,
  },
})