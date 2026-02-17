export type Organization = {
  id: string;
  name: string;
  github_repo_url: string | null;
  created_at: string;
};

export type Member = {
  id: string;
  name: string;
  agent_id: string;
  role: "developer" | "admin" | "agent";
  avatar_url: string | null;
  org_id: string;
  created_at: string;
  organizations?: { name: string };
};

export type TaskStatus = "draft" | "planned" | "assigned" | "in_progress" | "completed";
export type TaskPriority = "low" | "medium" | "high" | "critical";

export type TechnicalPlan = {
  goals: { title: string; completed: boolean }[];
  affected_files: string[];
  estimated_effort: "low" | "medium" | "high";
  notes: string;
};

export type Task = {
  id: string;
  title: string;
  brief: string | null;
  technical_plan: TechnicalPlan | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_to: string | null;
  delegated_from: string | null;
  org_id: string;
  created_at: string;
  updated_at: string;
  assigned_member?: Member;
};

export type Report = {
  id: string;
  task_id: string;
  summary: string | null;
  deliverables: { title: string; completed: boolean }[] | null;
  new_files: string[] | null;
  modified_files: string[] | null;
  test_plan: string | null;
  deployment_notes: string | null;
  submitted_by: string | null;
  submitted_at: string;
  submitter?: Member;
};

export type TaskComment = {
  id: string;
  task_id: string;
  author_id: string | null;
  content: string;
  created_at: string;
  author?: Member;
};

export type Message = {
  id: string;
  sender_id: string | null;
  receiver_id: string | null;
  content: string;
  created_at: string;
  sender?: Member;
  receiver?: Member;
};
