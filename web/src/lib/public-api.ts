import axios from 'axios'

/**
 * Axios client for the two UNAUTHENTICATED customer-facing endpoints
 * (SCMS proposal Modules 5 and 6):
 *
 *   GET/POST /public/quote/{token}   — approve or decline an OW repair quote
 *   GET/POST /public/csat/{token}    — answer the satisfaction survey
 *
 * A SEPARATE instance from `api` on purpose. The main client attaches the
 * staff access token and, on a 401, runs a refresh-and-retry that ends by
 * clearing the session. Neither belongs here: the visitor is a member of the
 * public whose credential is the token in their URL, and if a signed-in
 * employee happens to open one of these links we must not hand their bearer
 * token to a public route nor let its response log them out of TriServe.
 */
export const publicApi = axios.create({
  baseURL: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})
