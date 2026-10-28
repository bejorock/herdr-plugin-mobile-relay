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
          tonalOffset: 0.2,
          primary: { main: "#8ea4ff", light: "#bfd0ff", dark: "#5a73e8", contrastText: "#0d1020" },
          success: { main: "#50d69b", light: "#a7f1cf", dark: "#249b68", contrastText: "#071b12" },
          warning: { main: "#f4bf62", light: "#ffe1a6", dark: "#be7e18", contrastText: "#241600" },
          error: { main: "#ff767d", light: "#ffb8bc", dark: "#d63e48", contrastText: "#260509" },
          gray: { 50: "#f5f7f8", 100: "#cbd1d4" },
          border: { light: "#3b4145", dark: "#596168" },
          text: { primary: "#f5f7f8", secondary: "#d0d5d8" },
          responses: {
            success: { color: "#b8f6d7", backgroundColor: "#10281c", tabTextColor: "#d9ffeb" },
            error: { color: "#ffc4c8", backgroundColor: "#311217", tabTextColor: "#ffe0e2" },
            redirect: { color: "#d6ccff", backgroundColor: "#201b3d", tabTextColor: "#ece7ff" },
            info: { color: "#c7ddff", backgroundColor: "#142945", tabTextColor: "#e1edff" },
          },
          http: {
            get: "#72b7ff", post: "#59dc9f", put: "#ffc866", options: "#b8a8ff",
            patch: "#f28be5", delete: "#ff8088", basic: "#b3bbc0", link: "#b3bbc0", head: "#b3bbc0",
          },
        },
        schema: {
          linesColor: "#596168", defaultDetailsWidth: "75%", typeNameColor: "#b9c8ff",
          typeTitleColor: "#f5f7f8", requireLabelColor: "#ffb8bc", labelsTextSize: "0.8em",
          nestingSpacing: "1em", nestedBackground: "#1e2225", arrow: { size: "1.4em", color: "#d0d5d8" },
        },
        sidebar: {
          backgroundColor: "#161a1d", textColor: "#dbe0e3", activeTextColor: "#ffffff",
          groupItems: { activeBackgroundColor: "#27313a", activeTextColor: "#ffffff", textTransform: "none" },
          level1Items: { activeBackgroundColor: "#20282e", activeTextColor: "#ffffff", textTransform: "none" },
          arrow: { size: "1.5em", color: "#d0d5d8" },
        },
        rightPanel: {
          backgroundColor: "#171c20", textColor: "#f5f7f8", width: "40%",
          servers: { overlay: { backgroundColor: "#252c31", textColor: "#f5f7f8" }, url: { backgroundColor: "#252c31" } },
        },
        codeBlock: { backgroundColor: "#101416" },
        fab: { backgroundColor: "#8ea4ff", color: "#0d1020" },
        typography: {
          fontSize: "16px", lineHeight: "1.65em", fontWeightLight: "400", fontWeightRegular: "500", fontWeightBold: "700",
          fontFamily: "DM Sans Variable, DM Sans, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
          headings: { fontFamily: "DM Sans Variable, DM Sans, sans-serif", fontWeight: "700", lineHeight: "1.28em" },
          links: { color: "#aebeff", visited: "#c5b5ff", hover: "#ffffff", textDecoration: "underline", hoverTextDecoration: "underline" },
          code: {
            fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "14px", fontWeight: "400",
            lineHeight: "1.65em", color: "#eff3f5", backgroundColor: "#101416", wrap: true,
          },
        },
      },
    }}
  />,
);
