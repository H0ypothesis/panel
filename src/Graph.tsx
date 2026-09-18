import { memo, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  MiniMap,
  Panel,
  applyNodeChanges,
  useReactFlow,
  type Node,
  type NodeProps,
  type NodeChange,
} from "@xyflow/react";
import {
  ArrowUpRight,
  Check,
  Circle,
  GitBranch,
  LayoutGrid,
  Maximize,
  Minus,
  Plus,
  Scan,
  Sparkles,
  Square,
  AlertCircle,
  LoaderCircle,
} from "lucide-react";
import {
  ancestorPath,
  layoutTree,
  thinkingLabels,
  type TurnNode,
  type Workspace,
  type ModelOption,
} from "../shared/types";
import { readPreference, savePreference } from "./api";

type CardData = {
  turn: TurnNode;
  index: number;
  active: boolean;
  inPath: boolean;
  modelName: string;
  branch: (id: string) => void;
};
type GraphNode = Node<CardData, "turn">;
const colors = {
  sage: "#71977f",
  violet: "#a497be",
  blue: "#83a2c4",
  amber: "#c2a272",
};

export const StatusIcon = ({ status }: { status: TurnNode["status"] }) => {
  if (status === "running") return <LoaderCircle size={12} className="spin" />;
  if (status === "queued") return <Circle size={11} className="pulse" />;
  if (status === "completed") return <Check size={12} />;
  if (status === "failed") return <AlertCircle size={12} />;
  if (status === "cancelled") return <Square size={10} />;
  return <Sparkles size={12} />;
};

function plainText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*`>]/g, "")
    .replace(/\n+/g, " ")
    .trim();
}

const TurnCard = memo(function TurnCard({ data }: NodeProps<GraphNode>) {
  const { turn, index, active, inPath, modelName, branch } = data;
  const root = turn.status === "root";
  return (
    <div
      className={`turn-card ${root ? "root-card" : ""} color-${turn.color} ${active ? "active" : ""} ${inPath ? "in-path" : ""} status-${turn.status}`}
    >
      {!root && <Handle type="target" position={Position.Left} />}
      <div className="card-topline">
        <span className="card-kind">
          {root ? <Sparkles size={13} /> : <span className="branch-dot" />}
          {root ? "探索起点" : `对话 ${String(index).padStart(2, "0")}`}
        </span>
        <span
          className={`card-status ${turn.status}`}
          title={turn.status === "completed" ? "已完成" : undefined}
        >
          <StatusIcon status={turn.status} />
          {turn.status === "running"
            ? "生成中"
            : turn.status === "queued"
              ? "排队中"
              : turn.status === "failed"
                ? "失败"
                : turn.status === "cancelled"
                  ? "已停止"
                  : ""}
        </span>
      </div>
      <h3>{turn.prompt}</h3>
      <p className="card-preview">
        {plainText(turn.response) ||
          (turn.status === "failed"
            ? turn.error
            : turn.status === "queued"
              ? "等待空闲的运行位置…"
              : turn.status === "cancelled"
                ? "这次探索已停止，原有分支依然保留。"
                : "正在沿着这个方向思考…")}
      </p>
      <div className="card-footer">
        <span className="card-model">
          {root ? (
            <>
              <GitBranch size={12} /> 从一个问题开始
            </>
          ) : (
            <>
              <span className="model-symbol">π</span>
              {modelName}
              <span className="footer-dot">·</span>
              {thinkingLabels[turn.config.thinking]}
            </>
          )}
        </span>
        {(root || turn.status === "completed") && (
          <button
            className="node-branch nodrag"
            onClick={(event) => {
              event.stopPropagation();
              branch(turn.id);
            }}
            title="从这里创建分支"
            aria-label={`从「${turn.prompt}」创建分支`}
          >
            <Plus size={15} />
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
const nodeTypes = { turn: TurnCard };

interface Props {
  workspace: Workspace;
  selectedId: string;
  models: ModelOption[];
  onSelect: (id: string) => void;
  onBranch: (id: string) => void;
  onPositions: (positions: Record<string, { x: number; y: number }>) => void;
  focusId: string | null;
  focusVersion: number;
}

export function Graph({
  workspace,
  selectedId,
  models,
  onSelect,
  onBranch,
  onPositions,
  focusId,
  focusVersion,
}: Props) {
  const flow = useReactFlow<GraphNode>();
  const [zoom, setZoom] = useState(1);
  const [showMap, setShowMap] = useState(false);
  const path = useMemo(
    () =>
      new Set(ancestorPath(workspace.nodes, selectedId).map((node) => node.id)),
    [workspace.nodes, selectedId],
  );
  const derivedNodes = useMemo<GraphNode[]>(
    () =>
      workspace.nodes.map((turn, index) => ({
        id: turn.id,
        type: "turn",
        position: turn.position,
        selected: turn.id === selectedId,
        data: {
          turn,
          index,
          active: turn.id === selectedId,
          inPath: path.has(turn.id),
          branch: onBranch,
          modelName:
            models.find((model) => model.id === turn.config.model)?.name ??
            turn.config.model.split("/").at(-1)!,
        },
      })),
    [workspace.nodes, selectedId, path, onBranch, models],
  );
  const [nodes, setNodes] = useState<GraphNode[]>(derivedNodes);
  useEffect(
    () =>
      setNodes((current) =>
        derivedNodes.map((node) => {
          const dragging = current.find(
            (item) => item.id === node.id && item.dragging,
          );
          return dragging
            ? { ...node, position: dragging.position, dragging: true }
            : node;
        }),
      ),
    [derivedNodes],
  );
  const edges = useMemo(
    () =>
      workspace.nodes
        .filter((node) => node.parentId)
        .map((node) => ({
          id: `${node.parentId}-${node.id}`,
          source: node.parentId!,
          target: node.id,
          type: "default",
          animated: node.status === "running",
          style: {
            stroke: path.has(node.id) ? colors[node.color] : "#d7ddd7",
            strokeWidth: path.has(node.id) ? 1.8 : 1.4,
          },
        })),
    [workspace.nodes, path],
  );
  useEffect(() => {
    if (!focusId) return;
    const node = workspace.nodes.find((item) => item.id === focusId);
    if (node)
      void flow.setCenter(node.position.x + 142, node.position.y + 105, {
        zoom: 0.95,
        duration: 450,
      });
  }, [focusId, focusVersion]);
  const running = workspace.nodes.filter(
    (node) => node.status === "running" || node.status === "queued",
  ).length;
  const handleLayout = () => {
    onPositions(Object.fromEntries(layoutTree(workspace.nodes)));
    setTimeout(
      () => void flow.fitView({ padding: 0.16, duration: 450, maxZoom: 0.95 }),
      120,
    );
  };
  return (
    <div className="graph-container">
      <ReactFlow<GraphNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes: NodeChange<GraphNode>[]) =>
          setNodes((current) => applyNodeChanges(changes, current))
        }
        onNodeClick={(_, node) => onSelect(node.id)}
        onNodeDragStop={(_, node) => onPositions({ [node.id]: node.position })}
        onInit={(instance) => {
          const saved = readPreference(`viewport:${workspace.id}`);
          try {
            if (saved) {
              const view = JSON.parse(saved);
              if (
                Number.isFinite(view.x) &&
                Number.isFinite(view.y) &&
                Number.isFinite(view.zoom)
              ) {
                void instance.setViewport(view);
                return;
              }
            }
          } catch {
            /* Use initial fit for an invalid stored viewport. */
          }
          void instance.fitView({ padding: 0.13, maxZoom: 0.9 });
        }}
        onMoveEnd={(_, viewport) => {
          setZoom(viewport.zoom);
          savePreference(`viewport:${workspace.id}`, JSON.stringify(viewport));
        }}
        fitView
        fitViewOptions={{ padding: 0.13, maxZoom: 0.9 }}
        minZoom={0.2}
        maxZoom={1.5}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        panOnScroll
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1}
          color="#ced5ce"
        />
        <Panel position="top-left" className="canvas-heading">
          <span>
            <span className="tiny-green-dot" />
            探索画布
          </span>
          <small>{workspace.nodes.length} 个节点</small>
        </Panel>
        <Panel position="top-right">
          <button className="layout-button" onClick={handleLayout}>
            <LayoutGrid size={14} />
            自动布局
          </button>
        </Panel>
        <Panel position="bottom-left" className="canvas-controls">
          <button
            aria-label="缩小画布"
            onClick={() => void flow.zoomOut({ duration: 200 })}
          >
            <Minus size={15} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            aria-label="放大画布"
            onClick={() => void flow.zoomIn({ duration: 200 })}
          >
            <Plus size={15} />
          </button>
          <i />
          <button
            aria-label="适配全部节点"
            title="适配画布"
            onClick={() =>
              void flow.fitView({ padding: 0.14, duration: 400, maxZoom: 1 })
            }
          >
            <Maximize size={14} />
          </button>
          <button
            aria-label="切换小地图"
            title="小地图"
            className={showMap ? "control-active" : ""}
            onClick={() => setShowMap(!showMap)}
          >
            <Scan size={15} />
          </button>
        </Panel>
        <Panel position="bottom-right" className="canvas-hint">
          {running ? (
            <>
              <LoaderCircle size={12} className="spin" /> {running}{" "}
              条探索正在推进
            </>
          ) : (
            <>
              <ArrowUpRight size={13} /> 选择任意节点，探索新的可能
            </>
          )}
        </Panel>
        {showMap && (
          <MiniMap
            position="bottom-right"
            nodeColor={(node) => colors[(node.data as CardData).turn.color]}
            maskColor="rgba(244,246,242,0.65)"
            pannable
            zoomable
          />
        )}
      </ReactFlow>
    </div>
  );
}
