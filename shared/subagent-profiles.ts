export interface SubagentProfile {
  name: string;
  description: string;
  source: string;
  filePath: string;
  model?: string;
  thinking?: string | false;
  tools?: string[];
  excludeTools?: string[];
  skills?: string[];
  extensions?: string[];
  systemPromptMode: string;
  inheritProjectContext: boolean;
  inheritGlobalContext: boolean;
  inheritSkills: boolean;
  diagnostics: string[];
}
export interface SubagentCatalog {
  profiles: SubagentProfile[];
  diagnostics: { filePath: string; error: string }[];
}
