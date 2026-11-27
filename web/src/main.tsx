import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Language } from "../../src/domain/deliberation/model.js";
import { createWorkspace, type Workspace } from "./api/createApi.js";
import { App } from "./App.js";
import { BrandMark } from "./components/TitleBar.js";
import { initialLanguage, STRINGS } from "./state/i18n.js";
import { readStored, writeStored } from "./state/storage.js";
import { useTheme } from "./state/useUi.js";
import "./styles/tokens.css";
import "./styles/app.css";

const LANGUAGE_KEY = "coder.language";

function Root() {
  const [language, setLanguage] = useState<Language>(() => initialLanguage(readStored(LANGUAGE_KEY)));
  const [theme, toggleTheme] = useTheme();
  const [opened, setOpened] = useState<{ workspace: Workspace; seed: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // The standalone demo starts over in the chosen language, so the council speaks it too.
  // A server keeps its sessions: there the language only applies to what is convened next.
  const seed: Language = __STANDALONE__ ? language : "en";
  useEffect(() => {
    let cancelled = false;
    setFailure(null);
    createWorkspace(seed).then(
      (workspace) => !cancelled && setOpened({ workspace, seed }),
      (error: unknown) => !cancelled && setFailure(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [seed]);

  const changeLanguage = (next: Language) => {
    setLanguage(next);
    writeStored(LANGUAGE_KEY, next);
  };

  if (!opened || opened.seed !== seed) {
    return (
      <div className="coder splash" data-theme={theme} lang={language}>
        <BrandMark size={40} />
        <p className="splash__name">CodeR</p>
        <p className={failure ? "splash__error" : "splash__note"}>{failure ?? STRINGS[language].loading}</p>
      </div>
    );
  }
  return (
    <App
      key={opened.seed}
      workspace={opened.workspace}
      language={language}
      onLanguageChange={changeLanguage}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
