"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-pressed={theme === "dark"}
      onClick={() => {
        const next: Theme = currentTheme() === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        localStorage.setItem("byoki-theme", next);
        setTheme(next);
      }}
    >
      {theme === "dark" ? "Light mode" : "Dark mode"}
    </button>
  );
}
