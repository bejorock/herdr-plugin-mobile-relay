import { createRoot } from "react-dom/client";
import { RedocStandalone } from "redoc";
import "./developer.css";

const element = document.getElementById("redoc");
if (!element) throw new Error("Developer documentation root is missing");

createRoot(element).render(
  <RedocStandalone
    specUrl="/developer/openapi.json"
    options={{
      expandResponses: "200,201,204",
      hideDownloadButton: false,
      hideHostname: false,
      nativeScrollbars: true,
      pathInMiddlePanel: true,
      requiredPropsFirst: true,
      scrollYOffset: 58,
      sortOperationsAlphabetically: true,
      theme: {
        colors: {
          primary: { main: "#7791ff" },
          success: { main: "#42c98a" },
          warning: { main: "#dfaa52" },
          error: { main: "#ee5c62" },
          text: { primary: "#eceeee", secondary: "#aeb3b5" },
          http: {
            get: "#5795df",
            post: "#42c98a",
            put: "#dfaa52",
            options: "#8f82df",
            patch: "#d26dca",
            delete: "#ee5c62",
            head: "#8b9091",
          },
        },
        sidebar: { backgroundColor: "#171818", textColor: "#c8cbcc", activeTextColor: "#ffffff" },
        rightPanel: { backgroundColor: "#151616", textColor: "#e1e4e5" },
        typography: {
          fontFamily: "DM Sans Variable, DM Sans, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
          headings: { fontFamily: "DM Sans Variable, DM Sans, sans-serif", fontWeight: "650" },
          code: { fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace" },
        },
      },
    }}
  />,
);
