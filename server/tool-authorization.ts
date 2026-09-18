import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";

export const TOOL_POLICY_VERSION = "panel-tools-v3-pi-web-0.29.0";

export interface ToolAuthorizationScope {
  workspaceId: string;
  nodeId: string;
  workingDirectory: string | null;
  settingsVersion: number;
  approvalMode: "ask" | "auto";
  safetyModel?: string;
}

export interface ToolAuthorizationCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolAuthorizationAudit {
  id: string;
  actionHash: string;
  policyVersion: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt?: number;
}

function invalidInput(): never {
  throw new Error("操作授权参数必须是完整、无访问器的 JSON 数据。");
}

function dataDescriptors(value: object) {
  if (types.isProxy(value)) invalidInput();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") invalidInput();
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) invalidInput();
  }
  return descriptors;
}

function recordDescriptors(value: unknown) {
  if (value === null || typeof value !== "object" || types.isProxy(value)) {
    invalidInput();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidInput();
  const descriptors = dataDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable) invalidInput();
  }
  return descriptors;
}

// Do not use JSON.stringify on caller objects: it can execute toJSON/getters,
// silently omit fields, or turn non-finite numbers and array holes into null.
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidInput();
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || types.isProxy(value)) invalidInput();
  if (ancestors.has(value)) invalidInput();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalidInput();
      const descriptors = dataDescriptors(value);
      if (Object.keys(descriptors).length !== value.length + 1) invalidInput();
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable) invalidInput();
        items.push(canonicalJson(descriptor.value, ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const descriptors = recordDescriptors(value);
    return `{${Object.keys(descriptors)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(descriptors[key].value, ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function actionSnapshot(
  scope: ToolAuthorizationScope,
  call: ToolAuthorizationCall,
) {
  const scopeFields = recordDescriptors(scope);
  const scopeKeys = new Set([
    "workspaceId",
    "nodeId",
    "workingDirectory",
    "settingsVersion",
    "approvalMode",
    "safetyModel",
  ]);
  if (Object.keys(scopeFields).some((key) => !scopeKeys.has(key)))
    invalidInput();
  for (const key of ["workspaceId", "nodeId"]) {
    if (
      typeof scopeFields[key]?.value !== "string" ||
      scopeFields[key].value.length === 0
    ) {
      invalidInput();
    }
  }
  const workingDirectory = scopeFields.workingDirectory?.value;
  if (
    workingDirectory !== null &&
    (typeof workingDirectory !== "string" || workingDirectory.length === 0)
  )
    invalidInput();
  const settingsVersion = scopeFields.settingsVersion?.value;
  if (!Number.isSafeInteger(settingsVersion) || settingsVersion < 0) {
    invalidInput();
  }
  const approvalMode = scopeFields.approvalMode?.value;
  if (approvalMode !== "ask" && approvalMode !== "auto") invalidInput();
  const safetyModel = scopeFields.safetyModel?.value;
  if (
    safetyModel !== undefined &&
    (typeof safetyModel !== "string" || safetyModel.length === 0)
  ) {
    invalidInput();
  }

  const callFields = recordDescriptors(call);
  const callKeys = new Set(["id", "name", "arguments"]);
  if (Object.keys(callFields).some((key) => !callKeys.has(key))) invalidInput();
  for (const key of ["id", "name"]) {
    if (
      typeof callFields[key]?.value !== "string" ||
      callFields[key].value.length === 0
    ) {
      invalidInput();
    }
  }
  recordDescriptors(callFields.arguments?.value);

  return {
    nodeId: scopeFields.nodeId.value as string,
    actionHash: createHash("sha256")
      .update(
        canonicalJson({
          policyVersion: TOOL_POLICY_VERSION,
          scope: {
            workspaceId: scopeFields.workspaceId.value,
            nodeId: scopeFields.nodeId.value,
            workingDirectory,
            settingsVersion,
            approvalMode,
            safetyModel: safetyModel ?? null,
          },
          call: {
            id: callFields.id.value,
            name: callFields.name.value,
            arguments: callFields.arguments.value,
          },
        }),
      )
      .digest("hex"),
  };
}

interface StoredAuthorization {
  nodeId: string;
  audit: ToolAuthorizationAudit;
}

/** Process-local capabilities; persisted audit metadata cannot restore a grant. */
export class ToolAuthorizationRegistry {
  private readonly grants = new Map<string, StoredAuthorization>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly ttlMs = 30_000,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("操作授权有效期必须是正整数毫秒。");
    }
  }

  private now() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("操作授权的时间来源无效。");
    }
    return now;
  }

  issue(scope: ToolAuthorizationScope, call: ToolAuthorizationCall) {
    const { nodeId, actionHash } = actionSnapshot(scope, call);
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new Error("操作授权的过期时间无效。");
    }
    for (const [id, grant] of this.grants) {
      if (issuedAt >= grant.audit.expiresAt) this.grants.delete(id);
    }
    const audit: ToolAuthorizationAudit = {
      id: randomUUID(),
      actionHash,
      policyVersion: TOOL_POLICY_VERSION,
      issuedAt,
      expiresAt,
    };
    this.grants.set(audit.id, { nodeId, audit });
    return { ...audit };
  }

  consume(
    grantId: string,
    scope: ToolAuthorizationScope,
    call: ToolAuthorizationCall,
  ): ToolAuthorizationAudit {
    const grant = this.grants.get(grantId);
    // Consumption is synchronous and destructive even if validation fails.
    this.grants.delete(grantId);
    if (!grant) {
      throw new Error("操作授权不存在、已失效或已使用，请重新审批。");
    }
    const consumedAt = this.now();
    if (
      consumedAt >= grant.audit.expiresAt ||
      consumedAt < grant.audit.issuedAt
    ) {
      throw new Error("操作授权已过期或时钟已变化，请重新审批。");
    }
    if (actionSnapshot(scope, call).actionHash !== grant.audit.actionHash) {
      throw new Error("执行参数或审批配置已变化，请重新审批。");
    }
    return { ...grant.audit, consumedAt };
  }

  revoke(grantId: string): void {
    this.grants.delete(grantId);
  }

  revokeNode(nodeId: string): void {
    for (const [id, grant] of this.grants) {
      if (grant.nodeId === nodeId) this.grants.delete(id);
    }
  }
}
