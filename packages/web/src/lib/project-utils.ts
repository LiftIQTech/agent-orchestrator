type ProjectWithPrefix = { sessionPrefix?: string };

/**
 * Check if a session belongs to a specific project.
 * Matches by projectId or sessionPrefix (same logic as resolveProject).
 *
 * @param session - Session with id and projectId
 * @param projectId - The project key to match against
 * @param projects - Projects config mapping
 */
export function matchesProject(
  session: { id: string; projectId: string },
  projectId: string,
  projects: Record<string, ProjectWithPrefix>,
): boolean {
  if (session.projectId === projectId) return true;
  const project = projects[projectId];
  if (project?.sessionPrefix && session.id.startsWith(project.sessionPrefix)) return true;
  return false;
}
