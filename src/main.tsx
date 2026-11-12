import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// A file dropped anywhere but on a conversation must not open in the window (it would replace the app).
// The message box adds its own drop handling on top (App.tsx, Composer).
for (const type of ["dragover", "drop"] as const) window.addEventListener(type, (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
