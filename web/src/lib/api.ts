import axios from 'axios'

/**
 * Axios client for the TriServe API.
 *
 * Base URL defaults to /api/v1 — in dev the Vite server proxies /api to the
 * NestJS backend (see vite.config.ts). Override with VITE_API_BASE_URL.
 */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
})
