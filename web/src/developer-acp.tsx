import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./developer.css";

const root = document.getElementById("acp-guide");
if (!root) throw new Error("ACP guide root is missing");

function AcpGuide() {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/developer/acp.md", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`guide request failed (${response.status})`);
        return await response.text();
      })
      .then(setSource)
      .catch((reason: unknown) => {
        if ((reason as Error).name !== "AbortError") setError((reason as Error).message);
      });
    return () => controller.abort();
  }, []);

  if (error) return <p className="guide-status">Could not load the ACP guide: {error}</p>;
  if (!source) return <p className="guide-status">Loading ACP WebSocket documentation…</p>;
  return <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>;
}

createRoot(root).render(<AcpGuide />);
