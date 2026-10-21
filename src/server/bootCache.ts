// Boot-screen brand cache for /book and /me (one minute). Shared so a settings save can clear it.
export const bootCache = new Map<string, { at: number; brand: unknown }>();
