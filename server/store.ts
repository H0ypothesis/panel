import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AppState, TurnNode, Workspace } from "../shared/types.ts";
import { exampleWorkspace } from "./seed.ts";

export interface StoredNode extends TurnNode {
  messages?: Message[];
}
export interface StoredWorkspace extends Omit<Workspace, "nodes"> {
  nodes: StoredNode[];
}
interface Database {
  version: 1;
  revision: number;
  workspaces: StoredWorkspace[];
}

export class Store extends EventEmitter {
  readonly instanceId = randomUUID();
  data: Database = { version: 1, revision: 0, workspaces: [] };
  storageError?: string;
  private writes: Promise<void> = Promise.resolve();
  private directory: string;

  constructor(directory: string) {
    super();
    this.directory = directory;
  }

  async init(seed = true) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const parsed: Database = JSON.parse(
        await readFile(join(this.directory, "state.json"), "utf8"),
      );
      if (parsed.version !== 1 || !Array.isArray(parsed.workspaces))
        throw new Error("不支持的数据文件格式。");
      this.data = parsed;
      for (const workspace of this.data.workspaces) {
        for (const node of workspace.nodes) {
          if (node.status === "running" || node.status === "queued") {
            node.status = "failed";
            node.error = "运行被服务重启中断。请从父节点重新生成。";
            node.finishedAt = Date.now();
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (seed) this.data.workspaces = [exampleWorkspace()];
    }
    await this.save();
  }

  snapshot(): AppState {
    return {
      instanceId: this.instanceId,
      revision: this.data.revision,
      storageError: this.storageError,
      workspaces: this.data.workspaces.map((workspace) => ({
        ...workspace,
        nodes: workspace.nodes.map(({ messages: _messages, ...node }) => node),
      })),
    };
  }

  workspace(id: string) {
    const workspace = this.data.workspaces.find((item) => item.id === id);
    if (!workspace) throw new Error("探索不存在。");
    return workspace;
  }

  touch(workspace?: StoredWorkspace) {
    this.data.revision++;
    if (workspace) workspace.updatedAt = Date.now();
    this.emit("change");
  }

  async save() {
    const serialized = JSON.stringify(this.data);
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        const temp = join(this.directory, "state.json.tmp");
        await writeFile(temp, serialized, { mode: 0o600 });
        await rename(temp, join(this.directory, "state.json"));
      });
    this.writes = write;
    try {
      await write;
      if (this.storageError) {
        this.storageError = undefined;
        this.touch();
      }
    } catch (error) {
      this.storageError = "本地保存失败，请检查数据目录权限或剩余磁盘空间。";
      this.touch();
      throw error;
    }
  }
}
