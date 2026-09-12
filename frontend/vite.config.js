import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 8093,
    strictPort: true,
    /**
     * En desarrollo, `/api` va al backend local.
     *
     * Así el código es el MISMO en el portátil y en el servidor: siempre llama a `/api`
     * y quien lo reenvía cambia —aquí Vite, allí nginx—. Antes la dirección estaba escrita
     * a mano en App.vue y había que acordarse de cambiarla para subir.
     */
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true
      }
    }
  }
})
