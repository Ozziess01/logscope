import { defineConfig } from "vite";

// Страница живёт в подпапке сайта (fedorov-n.ru/logscope/), пути относительные.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
});
