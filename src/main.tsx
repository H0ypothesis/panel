import React from "react";
import ReactDOM from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import "./theme-palettes.css";
import "./desktop.css";
import "./computer-use.css";
import "./long-task.css";
import "./thinking-intensity.css";
import "./subagents.css";
import "./generation-indicator.css";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </React.StrictMode>,
);
