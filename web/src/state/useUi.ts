import { useCallback, useEffect, useState } from "react";
import type { EditorTheme } from "../editor/monaco.js";
import { readStored, writeStored } from "./storage.js";

const THEME_KEY = "coder.theme";

/** The theme to use until the person picks one here: the host page's, else the system's. */
function ambientTheme(): EditorTheme {
  const host = document.documentElement.dataset.theme;
  if (host === "light" || host === "dark") return host;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function useTheme(): [EditorTheme, () => void] {
  const [chosen, setChosen] = useState<EditorTheme | null>(() => {
    const stored = readStored(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  });
  const [ambient, setAmbient] = useState(ambientTheme);

  useEffect(() => {
    const follow = () => setAmbient(ambientTheme());
    const system = window.matchMedia("(prefers-color-scheme: light)");
    system.addEventListener("change", follow);
    const host = new MutationObserver(follow);
    host.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      system.removeEventListener("change", follow);
      host.disconnect();
    };
  }, []);

  const theme = chosen ?? ambient;
  const toggle = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setChosen(next);
    writeStored(THEME_KEY, next);
  }, [theme]);
  return [theme, toggle];
}

/** A yes/no preference remembered in this browser. */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = readStored(key);
    return stored === null ? fallback : stored === "1";
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      writeStored(key, next ? "1" : "0");
    },
    [key],
  );
  return [value, update];
}

/** True while the viewport matches the query; the layout's breakpoints live in CSS, this mirrors one of them. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
