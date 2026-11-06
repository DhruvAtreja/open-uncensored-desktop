import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// base "./" so the built page loads from file:// inside Electron.
export default defineConfig({ base: "./", plugins: [react(), tailwindcss()] });
