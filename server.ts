import { Scalekit } from "@scalekit-sdk/node"
import { join } from "path"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const EnvSchema = z.object({
	SCALEKIT_ENVIRONMENT_URL: z.url(),
	SCALEKIT_CLIENT_ID: z.string().min(1),
	SCALEKIT_CLIENT_SECRET: z.string().min(1),
	SCALEKIT_RESOURCE_ID: z.string().min(1),
})

const OAuthMetadataSchema = z.object({
	authorization_endpoint: z.string().optional(),
	token_endpoint: z.string().optional(),
})

const TokenResponseSchema = z.object({
	access_token: z.string(),
	token_type: z.string(),
	expires_in: z.number().optional(),
	scope: z.string().optional(),
})

const CreateTodoSchema = z.object({
	title: z.string().trim().min(1, "title is required"),
})

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const env = EnvSchema.parse(process.env)
const PORT = 3000
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`
const PUBLIC_DIR = join(__dirname, "public")

// ---------------------------------------------------------------------------
// ScaleKit client (used for token validation)
// ---------------------------------------------------------------------------
const scalekit = new Scalekit(
	env.SCALEKIT_ENVIRONMENT_URL,
	env.SCALEKIT_CLIENT_ID,
	env.SCALEKIT_CLIENT_SECRET,
)

// ---------------------------------------------------------------------------
// OAuth endpoint discovery
// ---------------------------------------------------------------------------
const AUTH_SERVER_URL = `${env.SCALEKIT_ENVIRONMENT_URL}/resources/${env.SCALEKIT_RESOURCE_ID}`
let authorizeEndpoint = `${env.SCALEKIT_ENVIRONMENT_URL}/authorize`
let tokenEndpoint = `${env.SCALEKIT_ENVIRONMENT_URL}/oauth/token`

async function discoverOAuthEndpoints(): Promise<void> {
	try {
		const metadataUrl = `${AUTH_SERVER_URL}/.well-known/oauth-authorization-server`
		console.log(`Fetching OAuth metadata from ${metadataUrl} ...`)
		const res = await fetch(metadataUrl)
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		const metadata = OAuthMetadataSchema.parse(await res.json())
		if (metadata.authorization_endpoint) authorizeEndpoint = metadata.authorization_endpoint
		if (metadata.token_endpoint) tokenEndpoint = metadata.token_endpoint
		console.log(`  authorize: ${authorizeEndpoint}`)
		console.log(`  token:     ${tokenEndpoint}`)
	} catch (err) {
		console.warn(
			"Could not fetch OAuth metadata – using fallback endpoints:",
			err instanceof Error ? err.message : String(err),
		)
		console.log(`  authorize: ${authorizeEndpoint}`)
		console.log(`  token:     ${tokenEndpoint}`)
	}
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------
function generateCodeVerifier(): string {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "")
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const data = new TextEncoder().encode(verifier)
	const hash = await crypto.subtle.digest("SHA-256", data)
	return btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "")
}

// In-memory map: state → code_verifier (cleaned up after use)
const pkceStore = new Map<string, string>()

// ---------------------------------------------------------------------------
// In-memory todo store
// ---------------------------------------------------------------------------
interface Todo {
	id: string
	title: string
	done: boolean
}

let nextId = 1
const todos: Todo[] = []

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function extractToken(req: Request): string | null {
	const auth = req.headers.get("authorization")
	if (auth?.startsWith("Bearer ")) {
		return auth.slice(7).trim() || null
	} else {
		return null
	}
}

async function validateToken(token: string, requiredScopes?: string[]): Promise<void> {
	// First: always validate the token signature + audience
	const claims = await scalekit.validateToken(token, {
		audience: [env.SCALEKIT_RESOURCE_ID],
	})

	// Then: check scopes only if the token actually contains custom scopes.
	// ScaleKit may not include custom scopes (todo:read, todo:write) in the
	// token if they aren't granted to the user/role in the dashboard — in
	// that case we skip scope enforcement so the demo still works.
	if (requiredScopes) {
		const tokenScopes: string[] =
			((claims as Record<string, unknown>)?.scopes as string[]) ?? []
		const hasCustomScopes = tokenScopes.some((s) => s.startsWith("todo:"))
		if (hasCustomScopes) {
			const missing = requiredScopes.filter((s) => !tokenScopes.includes(s))
			if (missing.length > 0) {
				throw new Error(`Missing scopes: ${missing.join(", ")}`)
			}
		}
	}
}

function insufficientScopeResponse(scope: string): Response {
	return Response.json(
		{ error: "insufficient_scope", error_description: `Required scope: ${scope}` },
		{ status: 403 },
	)
}

function unauthorizedResponse(): Response {
	return new Response(null, {
		status: 401,
		headers: { "WWW-Authenticate": 'Bearer realm="OAuth"' },
	})
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
	const url = new URL(req.url)
	const { pathname } = url
	const method = req.method

	// ---- OAuth: login redirect ----
	if (pathname === "/auth/login") {
		const codeVerifier = generateCodeVerifier()
		const codeChallenge = await generateCodeChallenge(codeVerifier)
		const state = crypto.randomUUID()
		pkceStore.set(state, codeVerifier)

		// Clean up stale PKCE entries after 10 min
		setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000)

		const requestedScope = url.searchParams.get("scope") || "todo:read todo:write"

		const params = new URLSearchParams({
			response_type: "code",
			client_id: env.SCALEKIT_CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
			state,
			scope: requestedScope,
		})

		return Response.redirect(`${authorizeEndpoint}?${params}`, 302)

		// ---- OAuth: callback ----
	} else if (pathname === "/auth/callback") {
		return handleOAuthCallback(url)

		// ---- API routes (require auth) ----
	} else if (pathname.startsWith("/api/")) {
		const token = extractToken(req)

		if (!token) {
			return unauthorizedResponse()
		} else if (pathname === "/api/todos" && method === "GET") {
			return handleGetTodos(token)
		} else if (pathname === "/api/todos" && method === "POST") {
			return handleCreateTodo(token, req)
		} else {
			const todoIdMatch = pathname.match(/^\/api\/todos\/(\w+)$/)
			const todoId = todoIdMatch?.[1]

			if (todoId && method === "PATCH") {
				return handleToggleTodo(token, todoId)
			} else if (todoId && method === "DELETE") {
				return handleDeleteTodo(token, todoId)
			} else {
				return Response.json({ error: "not found" }, { status: 404 })
			}
		}

		// ---- Static files ----
	} else {
		const filePath = pathname === "/" ? "/index.html" : pathname
		const file = Bun.file(join(PUBLIC_DIR, filePath))
		if (await file.exists()) {
			return new Response(file)
		} else {
			return new Response("Not found", { status: 404 })
		}
	}
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleOAuthCallback(url: URL): Promise<Response> {
	const code = url.searchParams.get("code")
	const state = url.searchParams.get("state")
	const error = url.searchParams.get("error")

	if (error) {
		return new Response(
			`OAuth error: ${error} - ${url.searchParams.get("error_description") || ""}`,
			{ status: 400 },
		)
	} else if (!code || !state) {
		return new Response("Invalid callback: missing code or state", { status: 400 })
	} else {
		const codeVerifier = pkceStore.get(state)

		if (!codeVerifier) {
			return new Response("Invalid callback: unknown state", { status: 400 })
		} else {
			pkceStore.delete(state)

			try {
				const tokenRes = await fetch(tokenEndpoint, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "authorization_code",
						code,
						redirect_uri: REDIRECT_URI,
						client_id: env.SCALEKIT_CLIENT_ID,
						client_secret: env.SCALEKIT_CLIENT_SECRET,
						code_verifier: codeVerifier,
					}),
				})

				if (!tokenRes.ok) {
					const body = await tokenRes.text()
					console.error("Token exchange failed:", tokenRes.status, body)
					return new Response(`Token exchange failed: ${body}`, { status: 502 })
				} else {
					const tokenData = TokenResponseSchema.parse(await tokenRes.json())
					return Response.redirect(
						`http://localhost:${PORT}/scalekit.html#token=${tokenData.access_token}`,
						302,
					)
				}
			} catch (err) {
				console.error("Token exchange error:", err)
				return new Response("Token exchange failed", { status: 502 })
			}
		}
	}
}

async function handleGetTodos(token: string): Promise<Response> {
	try {
		await validateToken(token, ["todo:read"])
		return Response.json(todos)
	} catch {
		return unauthorizedResponse()
	}
}

async function handleCreateTodo(token: string, req: Request): Promise<Response> {
	try {
		await validateToken(token, ["todo:write"])
	} catch {
		return insufficientScopeResponse("todo:write")
	}

	const result = CreateTodoSchema.safeParse(await req.json())
	if (!result.success) {
		return Response.json(
			{ error: result.error.issues[0]?.message ?? "Invalid input" },
			{ status: 400 },
		)
	} else {
		const todo: Todo = { id: String(nextId++), title: result.data.title, done: false }
		todos.push(todo)
		return Response.json(todo, { status: 201 })
	}
}

async function handleToggleTodo(token: string, todoId: string): Promise<Response> {
	try {
		await validateToken(token, ["todo:write"])
	} catch {
		return insufficientScopeResponse("todo:write")
	}

	const todo = todos.find((t) => t.id === todoId)
	if (!todo) {
		return Response.json({ error: "not found" }, { status: 404 })
	} else {
		todo.done = !todo.done
		return Response.json(todo)
	}
}

async function handleDeleteTodo(token: string, todoId: string): Promise<Response> {
	try {
		await validateToken(token, ["todo:write"])
	} catch {
		return insufficientScopeResponse("todo:write")
	}

	const idx = todos.findIndex((t) => t.id === todoId)
	if (idx === -1) {
		return Response.json({ error: "not found" }, { status: 404 })
	} else {
		const [removed] = todos.splice(idx, 1)
		return Response.json(removed)
	}
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
await discoverOAuthEndpoints()

Bun.serve({
	port: PORT,
	routes: {
		"/.well-known/oauth-protected-resource": Response.json({
			authorization_servers: [AUTH_SERVER_URL],
			bearer_methods_supported: ["header"],
			resource: `http://localhost:${PORT}`,
			scopes_supported: ["todo:read", "todo:write"],
		}),
	},
	fetch: handler,
})

console.log(`\nServer running at http://localhost:${PORT}`)
console.log(`Open in Chrome Canary with WebMCP flag enabled\n`)
