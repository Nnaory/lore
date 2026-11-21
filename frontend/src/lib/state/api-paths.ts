/**
 * API paths for the projects backend (FastAPI behind Caddy, same origin).
 *
 * Kept in its own module so http-repository.ts and sync.ts can both use it
 * without importing each other.
 */

export const API_BASE = "/api/v1/projects";

export const projectUrl = (id: string) => `${API_BASE}/${encodeURIComponent(id)}`;
