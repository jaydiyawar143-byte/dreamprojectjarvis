"use client";

// ---------------------------------------------------------------------------
// Phase 14 — which project a NEW conversation belongs to.
//
// Shown only before a conversation has started, because that is the only
// moment the choice exists: the server fixes a conversation's project when it
// creates it. "Personal" is the default and means no project — what is said
// there is remembered everywhere; what is said in a project is remembered in
// that project only.
//
// Renders nothing until the user has at least one project, so a deployment
// where nobody uses projects looks exactly as it did.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { listProjects, type ProjectItem } from "@/lib/api";
import { useChatStore } from "@/lib/chat-store";

export function ProjectPicker() {
  const projectId = useChatStore((s) => s.newConversationProjectId);
  const setProject = useChatStore((s) => s.setNewConversationProject);
  const [projects, setProjects] = useState<ProjectItem[]>([]);

  useEffect(() => {
    let live = true;
    void listProjects().then((res) => {
      if (!live) return;
      const mine = res.success && res.data ? res.data.projects : [];
      setProjects(mine);
      // A project that no longer exists is not a choice any more.
      const chosen = useChatStore.getState().newConversationProjectId;
      if (chosen && !mine.some((p) => p.id === chosen)) setProject(null);
    });
    return () => {
      live = false;
    };
  }, [setProject]);

  if (projects.length === 0) return null;

  return (
    <label className="mt-4 inline-flex items-center gap-2 text-xs text-gray-400">
      <span>Project</span>
      <select
        aria-label="Project for this conversation"
        value={projectId ?? ""}
        onChange={(event) => setProject(event.target.value || null)}
        className="sys-focus rounded border border-sys-control bg-sys-edge/40 px-2 py-1 text-xs text-sys-text"
      >
        <option value="">Personal (no project)</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}
