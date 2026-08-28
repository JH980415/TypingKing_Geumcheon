import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BootstrapData } from "../../../shared/types";
import { resolveBootstrapTheme } from "../../../shared/events/bootstrapData";
import { TypingGameApp } from "../../typing-game/src/TypingGameApp";
import { LeaderboardApp } from "../../leaderboard/src/LeaderboardApp";
import "./styles.css";

function Shell() {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    window.typingKing.getBootstrap().then((result) => {
      if (result.ok && result.data) {
        setBootstrap(result.data);
        applyTheme(result.data);
        document.title = result.data.variantPolicy.windowTitle;
      } else {
        setError(result.error || "프로그램 설정을 불러오지 못했습니다.");
      }
    });
  }, []);

  if (error) {
    return (
      <main className="app app-fallback">
        <section className="empty-state">
          <h1>2026 일잘러 페스타 타자왕</h1>
          <p>{error}</p>
        </section>
      </main>
    );
  }

  if (!bootstrap) {
    return (
      <main className="app app-fallback">
        <section className="empty-state">
          <h1>2026 일잘러 페스타 타자왕</h1>
          <p>프로그램을 준비하고 있습니다.</p>
        </section>
      </main>
    );
  }

  return bootstrap.mode === "leaderboard" ? (
    <LeaderboardApp bootstrap={bootstrap} />
  ) : (
    <TypingGameApp bootstrap={bootstrap} />
  );
}

function applyTheme(bootstrap: BootstrapData): void {
  const root = document.documentElement;
  const theme = resolveBootstrapTheme(bootstrap);
  root.dataset.eventProfile = bootstrap.eventProfile.profileId;
  root.style.setProperty("--primary", theme.primaryColor);
  root.style.setProperty("--accent", theme.accentColor);
  root.style.setProperty("--bg", theme.backgroundColor);
  root.style.setProperty("--correct", theme.correctColor);
  root.style.setProperty("--wrong", theme.wrongColor);
  root.style.setProperty("--cyan", theme.cyanColor || "#08A7D8");
  root.style.setProperty("--orange", theme.orangeColor || "#F58220");
  root.style.setProperty("--success", theme.successColor || "#098A55");
  if (bootstrap.eventProfile.profileId === "geumcheon-2026") {
    root.style.setProperty("--deep-purple", "#3F1556");
    root.style.setProperty("--yellow", "#FED900");
    root.style.setProperty("--white", "#FFFFFF");
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>
);
