import { Component, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./fonts.css";
import { Admin } from "./Admin";
import { Book } from "./Book";
import { Barber } from "./Barber";
import { Workspace } from "./Workspace";
import { PreviewBar, Notice, type Scenario } from "./ui";

class PreviewErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="state-card">
        <h1>The preview needs a fresh start</h1>
        <p>
          No bookings or payments have been made. Reload to restore the example
          screens.
        </p>
        <a className="button primary" href={location.pathname}>
          Reload preview
        </a>
      </main>
    ) : (
      this.props.children
    );
  }
}
function App() {
  const [scenario, setScenario] = useState<Scenario>("normal");
  const [online, setOnline] = useState(navigator.onLine);
  const surface = location.pathname.split("/")[2] || "admin";
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return (
    <>
      <PreviewBar
        surface={surface}
        scenario={scenario}
        onScenario={setScenario}
      />
      {!online && (
        <div className="actual-offline">
          <Notice icon="offline" tone="warning">
            Your device is offline. Only the already loaded design preview is
            available; no live actions or saved queue are connected.
          </Notice>
        </div>
      )}
      <PreviewErrorBoundary>
        {surface === "book" ? (
          <Book scenario={scenario} setScenario={setScenario} />
        ) : surface === "barber" ? (
          <Barber scenario={scenario} setScenario={setScenario} />
        ) : (
          <Admin scenario={scenario} setScenario={setScenario} />
        )}
      </PreviewErrorBoundary>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  location.pathname === "/workspace" ? <Workspace /> : <App />,
);
