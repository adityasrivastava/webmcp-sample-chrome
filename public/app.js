// ---------------------------------------------------------------------------
// DOM Element References
// ---------------------------------------------------------------------------

const loginBtn = document.getElementById("login-btn")
const logoutBtn = document.getElementById("logout-btn")
const authStatus = document.getElementById("auth-status")
const webmcpStatus = document.getElementById("webmcp-status")
const addForm = document.getElementById("add-form")
const todoInput = document.getElementById("todo-input")
const todoList = document.getElementById("todo-list")
const toolsSection = document.getElementById("tools-section")
const toolsList = document.getElementById("tools-list")

// ---------------------------------------------------------------------------
// Application State
// ---------------------------------------------------------------------------

/** @type {string | null} OAuth access token for API authentication */
let authToken = null

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Redirects the browser to the server-side OAuth login endpoint
 * with the requested scopes. The server handles PKCE and redirects to ScaleKit.
 *
 * @param {string} scope - Space-separated OAuth scopes to request
 */
function login() {
	window.location.href = "/auth/login"
}

/**
 * Clears the authentication token from memory and localStorage,
 * resets all UI state, and unregisters any active WebMCP tools.
 */
function logout() {
	authToken = null
	localStorage.removeItem("auth_token")
	updateAuthUI()
	clearWebMCPTools()
	renderTodos([])
}

/**
 * Extracts the OAuth access token from the URL hash fragment
 * (set by the server after a successful OAuth callback) or
 * falls back to a previously stored token in localStorage.
 *
 * The hash fragment approach ensures the token is never sent
 * to the server in subsequent requests or referrer headers.
 */
function checkForToken() {
	const hash = window.location.hash
	console.log("[auth] hash:", hash)
	console.log("[auth] localStorage:", localStorage.getItem("auth_token") ? "present" : "empty")
	if (hash.startsWith("#token=")) {
		authToken = hash.slice(7)
		localStorage.setItem("auth_token", authToken)
		history.replaceState(null, "", "/scalekit.html")
		console.log("[auth] token captured from hash")
	} else {
		authToken = localStorage.getItem("auth_token")
		console.log("[auth] token from localStorage:", authToken ? "present" : "null")
	}
}

/**
 * Updates authentication-related UI elements (buttons, badges, form)
 * based on the current authToken state.
 */
function updateAuthUI() {
	if (authToken) {
		loginBtn.hidden = true
		logoutBtn.hidden = false
		addForm.hidden = false
		authStatus.textContent = "Authenticated"
		authStatus.className = "badge on"
	} else {
		loginBtn.hidden = false
		logoutBtn.hidden = true
		addForm.hidden = true
		authStatus.textContent = "Not authenticated"
		authStatus.className = "badge off"
	}
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

/**
 * Makes an authenticated fetch request to the server API.
 * Injects the Bearer token into the Authorization header and
 * handles 401 responses by clearing the session.
 *
 * @param {string} path - API endpoint path (e.g. "/api/todos")
 * @param {RequestInit} [options] - Additional fetch options (method, body, etc.)
 * @returns {Promise<any>} Parsed JSON response body
 * @throws {Error} On 401 (session cleared) or other non-OK responses
 */
async function apiFetch(path, options = {}) {
	const res = await fetch(path, {
		...options,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${authToken}`,
			...(options.headers || {}),
		},
	})

	if (res.status === 401) {
		// Token expired or invalid — clear session and force re-login
		authToken = null
		localStorage.removeItem("auth_token")
		updateAuthUI()
		clearWebMCPTools()
		throw new Error("Unauthorized – please log in again")
	} else if (!res.ok) {
		const body = await res.json().catch(() => ({}))
		throw new Error(body.error || `API error ${res.status}`)
	} else {
		return res.json()
	}
}

// ---------------------------------------------------------------------------
// Todo CRUD Operations
// ---------------------------------------------------------------------------

/**
 * Fetches all todos from the server and re-renders the list.
 * Catches errors gracefully to avoid breaking the UI.
 *
 * @returns {Promise<Array<{id: string, title: string, done: boolean}>>}
 */
async function fetchTodos() {
	try {
		const todos = await apiFetch("/api/todos")
		renderTodos(todos)
		return todos
	} catch (err) {
		console.error("Failed to fetch todos:", err)
		return []
	}
}

/**
 * Creates a new todo item on the server and refreshes the list.
 *
 * @param {string} title - The todo item text
 * @returns {Promise<{id: string, title: string, done: boolean}>}
 */
async function addTodo(title) {
	const todo = await apiFetch("/api/todos", {
		method: "POST",
		body: JSON.stringify({ title }),
	})
	await fetchTodos()
	return todo
}

/**
 * Toggles the done/undone status of a todo and refreshes the list.
 *
 * @param {string} id - The todo item ID
 * @returns {Promise<{id: string, title: string, done: boolean}>}
 */
async function toggleTodo(id) {
	const todo = await apiFetch(`/api/todos/${id}`, { method: "PATCH" })
	await fetchTodos()
	return todo
}

/**
 * Deletes a todo item from the server and refreshes the list.
 *
 * @param {string} id - The todo item ID
 * @returns {Promise<{id: string, title: string, done: boolean}>}
 */
async function deleteTodo(id) {
	const todo = await apiFetch(`/api/todos/${id}`, { method: "DELETE" })
	await fetchTodos()
	return todo
}

// ---------------------------------------------------------------------------
// UI Rendering
// ---------------------------------------------------------------------------

/**
 * Escapes HTML special characters to prevent XSS when inserting
 * user-provided text into the DOM via innerHTML.
 *
 * Uses the browser's built-in text encoding through the textContent
 * setter, which safely encodes &, <, >, ", and ' characters.
 *
 * @param {string} str - Raw user input string
 * @returns {string} HTML-safe escaped string
 */
function escapeHtml(str) {
	const el = document.createElement("span")
	el.textContent = str
	return el.innerHTML
}

/**
 * Renders the todo list into the DOM. Uses data-action attributes
 * for click delegation (handled by the todoList event listeners below)
 * instead of inline onclick handlers.
 *
 * @param {Array<{id: string, title: string, done: boolean}>} todos
 */
function renderTodos(todos) {
	if (todos.length === 0) {
		todoList.innerHTML = '<li class="empty-state">No todos yet</li>'
	} else {
		todoList.innerHTML = todos
			.map(
				(t) => `
        <li class="${t.done ? "done" : ""}" data-id="${t.id}">
          <input
            type="checkbox"
            class="todo-checkbox"
            ${t.done ? "checked" : ""}
            data-action="toggle"
          />
          <span class="todo-title" data-action="toggle">${escapeHtml(t.title)}</span>
          <button class="todo-delete" data-action="delete" title="Delete">&times;</button>
        </li>`,
			)
			.join("")
	}
}

/**
 * Handles the add-todo form submission. Validates that the input
 * is non-empty before creating a new todo item.
 *
 * @param {SubmitEvent} e - The form submit event
 */
function handleAdd(e) {
	e.preventDefault()
	const title = todoInput.value.trim()
	if (title) {
		todoInput.value = ""
		addTodo(title)
	}
}

// ---------------------------------------------------------------------------
// Todo List Event Delegation
//
// A single click listener on the <ul> handles all interactions with
// dynamically rendered todo items (toggle checkbox, click title, delete).
// This avoids inline onclick handlers in template-rendered HTML.
// ---------------------------------------------------------------------------

todoList.addEventListener("click", (e) => {
	const target = /** @type {HTMLElement} */ (e.target)
	const li = target.closest("li[data-id]")

	if (li) {
		const id = li.dataset.id
		const action = target.dataset.action

		if (action === "toggle") {
			// Prevent the checkbox from toggling its own checked state before
			// the API round-trip confirms the change. The re-render after
			// fetchTodos() will set the correct checked state from the server.
			if (target instanceof HTMLInputElement) {
				e.preventDefault()
			}
			toggleTodo(id)
		} else if (action === "delete") {
			deleteTodo(id)
		}
	}
})

// ---------------------------------------------------------------------------
// WebMCP Tool Registration
//
// Registers application tools with the browser's navigator.modelContext API
// (Chrome Canary with WebMCP flag). This allows AI models in the browser
// to discover and invoke these tools on behalf of the user.
// ---------------------------------------------------------------------------

/** Tool definitions exposed to AI models via navigator.modelContext */
const TOOLS = [
	{
		name: "listTodos",
		description:
			"List all todo items. Returns an array of objects with id, title, and done status.",
		annotations: { readOnlyHint: true },
		execute: async () => {
			return await apiFetch("/api/todos")
		},
	},
	{
		name: "addTodo",
		description: "Add a new todo item. Provide a title for the todo.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string", description: "The todo item text" },
			},
			required: ["title"],
		},
		execute: async (input) => {
			return await addTodo(input.title)
		},
	},
	{
		name: "toggleTodo",
		description: "Toggle a todo item between done and not done. Provide the todo ID.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "The todo item ID" },
			},
			required: ["id"],
		},
		execute: async (input) => {
			return await toggleTodo(input.id)
		},
	},
	{
		name: "deleteTodo",
		description: "Delete a todo item. Provide the todo ID.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "The todo item ID" },
			},
			required: ["id"],
		},
		execute: async (input) => {
			return await deleteTodo(input.id)
		},
	},
]

/**
 * Registers WebMCP tools with the browser's navigator.modelContext API.
 * Falls back gracefully if the API is not available (e.g. the WebMCP
 * flag is not enabled in Chrome Canary).
 */
async function registerWebMCPTools() {
	if (!navigator.modelContext) {
		console.warn(
			"navigator.modelContext not available. Enable the WebMCP flag in Chrome Canary.",
		)
		webmcpStatus.textContent = "WebMCP not available"
		webmcpStatus.className = "badge off"
	} else {
		try {
			navigator.modelContext.provideContext({ tools: TOOLS })

			webmcpStatus.textContent = `WebMCP: ${TOOLS.length} tools registered`
			webmcpStatus.className = "badge on"

			// Show the tool cards section for demo visibility
			toolsSection.hidden = false
			toolsList.innerHTML = TOOLS.map(
				(t) => `
        <div class="tool-card">
          <div class="tool-name">${escapeHtml(t.name)}</div>
          <div class="tool-desc">${escapeHtml(t.description)}</div>
        </div>`,
			).join("")

			console.log(
				"WebMCP tools registered:",
				TOOLS.map((t) => t.name),
			)
		} catch (err) {
			console.error("Failed to register WebMCP tools:", err)
			webmcpStatus.textContent = "WebMCP registration failed"
			webmcpStatus.className = "badge off"
		}
	}
}

/**
 * Unregisters all WebMCP tools and resets the tools section UI.
 * Called on logout to revoke AI model access to authenticated endpoints.
 */
function clearWebMCPTools() {
	if (navigator.modelContext) {
		try {
			navigator.modelContext.clearContext()
		} catch {
			// Silently ignore — context may already be cleared
		}
	}
	webmcpStatus.textContent = "WebMCP not registered"
	webmcpStatus.className = "badge off"
	toolsSection.hidden = true
	toolsList.innerHTML = ""
}

// ---------------------------------------------------------------------------
// Static Event Listeners
//
// Attach handlers for elements that exist in the initial HTML (login,
// logout, and add-form). These replace inline onclick/onsubmit attributes
// to keep all event wiring in JavaScript.
// ---------------------------------------------------------------------------

loginBtn.addEventListener("click", login)
logoutBtn.addEventListener("click", logout)
addForm.addEventListener("submit", handleAdd)

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

checkForToken()
updateAuthUI()

if (authToken) {
	fetchTodos()
	registerWebMCPTools()
}
