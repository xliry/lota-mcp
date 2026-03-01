export type AgentMode = "auto" | "supervised";

export interface AgentConfig {
  configPath: string;
  model: string;
  interval: number;
  once: boolean;
  mode: AgentMode;
  singlePhase: boolean;
  agentName: string;
  maxTasksPerCycle: number;
  githubToken: string;
  githubRepo: string;
  telegramBotToken: string;
  telegramChatId: string;
  timeout: number;
  maxRssMb: number;
  useWorktree: boolean;
}

export interface TaskInfo {
  id: number;
  title: string;
  status: string;
  body?: string;
  workspace?: string;
  depends_on?: number[];
  comment_count?: number;
  plan?: {
    affected_files?: string[];
    goals?: string[];
  };
}

export interface CommentUpdate {
  id: number;
  title: string;
  workspace?: string;
  new_comment_count: number;
}

export interface WorkData {
  phase: "plan" | "execute" | "comments" | "single";
  tasks: TaskInfo[];
  commentUpdates: CommentUpdate[];
}

export interface ClaudeEvent {
  type: string;
  subtype?: string;
  content_block?: { type?: string; name?: string };
  message?: { content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown> }> };
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}
