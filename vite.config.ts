import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  define: process.env.FIREBASE_WEBAPP_CONFIG
    ? { 'import.meta.env.VITE_FIREBASE_CONFIG': JSON.stringify(process.env.FIREBASE_WEBAPP_CONFIG) }
    : {},
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) return 'firebase';
          if (id.includes('node_modules/react')) return 'react';
          if (id.includes('node_modules/lucide-react')) return 'icons';
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787'
    }
  }
});
