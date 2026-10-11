// ---------------------------------------------------------------------------
// Phase 14 — projects.
//
// A project gives a memory a scope and nothing else: a name, owned by one
// user. EVERY read and write here is scoped to that user, so a project id is
// only ever a way to choose among the caller's own projects — another user's
// id finds nothing, exactly as an unknown one does.
//
// There is deliberately no delete and no rename. Deleting a project deletes
// its memories (the foreign key cascades), which is a destructive act on
// memory and would need the same confirmation a forget does; nothing in
// Phase 14 asks for it.
// ---------------------------------------------------------------------------

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  JarvisError,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_LIMIT,
  PROJECT_NAME_MAX_LENGTH,
  type Project,
} from "@jarvis/core";

function toProject(row: { id: string; userId: string; name: string; description: string | null; createdAt: Date; updatedAt: Date }): Project {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PrismaProjectRepository {
  constructor(private prisma: PrismaClient) {}

  async create(userId: string, input: { name: string; description?: string | null }): Promise<Project> {
    const name = input.name.trim().replace(/\s+/g, " ");
    const description = input.description?.trim() || null;
    if (name.length === 0 || name.length > PROJECT_NAME_MAX_LENGTH) {
      throw new JarvisError("INVALID_REQUEST", `A project name must be 1 to ${PROJECT_NAME_MAX_LENGTH} characters`);
    }
    if (description && description.length > PROJECT_DESCRIPTION_MAX_LENGTH) {
      throw new JarvisError("INVALID_REQUEST", `A project description may be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters`);
    }
    if ((await this.prisma.project.count({ where: { userId } })) >= PROJECT_LIMIT) {
      throw new JarvisError("INVALID_REQUEST", `At most ${PROJECT_LIMIT} projects are allowed`);
    }
    try {
      return toProject(await this.prisma.project.create({ data: { userId, name, description } }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new JarvisError("INVALID_REQUEST", "You already have a project with that name");
      }
      throw error;
    }
  }

  /** The user's own projects, by name. Bounded by PROJECT_LIMIT. */
  async list(userId: string): Promise<Project[]> {
    const rows = await this.prisma.project.findMany({ where: { userId }, orderBy: { name: "asc" }, take: PROJECT_LIMIT });
    return rows.map(toProject);
  }

  /** The project, only if this user owns it. Another user's project is `null`, like an unknown id. */
  async findOwned(userId: string, projectId: string): Promise<Project | null> {
    const row = await this.prisma.project.findFirst({ where: { id: projectId, userId } });
    return row ? toProject(row) : null;
  }
}
