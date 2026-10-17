/** The standalone site has no workspaces and nothing to edit. */
export function useWorkspace() {
  return { canWrite: false }
}
