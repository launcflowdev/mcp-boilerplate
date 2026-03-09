import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GoogleHandler } from "./auth/google-handler";
import { Props } from "./auth/oauth";
import { McpAgent } from 'agents/mcp';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TicketClassifier } from './services/classifier';
import { registerKbTools } from './kb/tools';

type State = {};

type AgentProps = Props & {};

// Define our MCP agent with tools
export class BoilerplateMCP extends McpAgent<Env, State, AgentProps> {
	server = new McpServer({
		name: "Boilerplate MCP",
		version: "1.0.0",
	});

	async init() {
		// B1 KB Access Layer — Fleet Knowledge Base tools
		registerKbTools(this);
	}
}

// Create an OAuth provider instance for auth routes
const oauthProvider = new OAuthProvider({
	apiRoute: "/sse",
	apiHandler: BoilerplateMCP.mount("/sse") as any,
	defaultHandler: GoogleHandler as any,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});

// Helper functions for new endpoints

// Get user ID from either Bearer token or session cookie
async function getUserId(request: Request, env: Env): Promise<string | null> {
	// TEMPORARY DEVELOPMENT BYPASS - REMOVE AFTER OAUTH CONFIGURATION IS FIXED
	// Check if we're in development environment (localhost or DEV_MODE env var)
	const url = new URL(request.url);
	const isDevelopment = url.hostname === 'localhost' || 
	                     url.hostname === '127.0.0.1' || 
	                     env.DEV_MODE === 'true';
	
	if (isDevelopment) {
		// In development, accept any Bearer token or return dev user for cookie auth
		const authHeader = request.headers.get('Authorization');
		if (authHeader?.startsWith('Bearer ')) {
			return 'dev-user-123';
		}
		
		// Also allow cookie-based auth to work in development
		const cookies = request.headers.get('Cookie');
		if (cookies && cookies.includes('session=')) {
			return 'dev-user-123';
		}
	}
	// END DEVELOPMENT BYPASS
	
	// First try Bearer token
	const userId = await validateAuth(request, env);
	if (userId) {
		return userId;
	}
	
	// Then try session cookie
	const cookies = request.headers.get('Cookie');
	if (cookies) {
		const sessionMatch = cookies.match(/session=([^;]+)/);
		if (sessionMatch) {
			const sessionToken = sessionMatch[1];
			const sessionData = await env.OAUTH_KV.get(`session:${sessionToken}`);
			if (sessionData) {
				const session = JSON.parse(sessionData);
				if (session.expiresAt && new Date(session.expiresAt) > new Date()) {
					return session.userId;
				}
			}
		}
	}
	
	return null;
}
async function validateAuth(request: Request, env: Env): Promise<string | null> {
	// TEMPORARY DEVELOPMENT BYPASS - REMOVE AFTER OAUTH CONFIGURATION IS FIXED
	// Check if we're in development environment (localhost or DEV_MODE env var)
	const url = new URL(request.url);
	const isDevelopment = url.hostname === 'localhost' || 
	                     url.hostname === '127.0.0.1' || 
	                     env.DEV_MODE === 'true';
	
	if (isDevelopment) {
		const authHeader = request.headers.get('Authorization');
		// Allow any Bearer token in development and return consistent dev user ID
		if (authHeader?.startsWith('Bearer ')) {
			return 'dev-user-123';
		}
	}
	// END DEVELOPMENT BYPASS
	
	const authHeader = request.headers.get('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return null;
	}
	
	const token = authHeader.slice(7);
	
	try {
		// Check if token is a session token in KV
		const sessionData = await env.OAUTH_KV.get(`session:${token}`);
		if (sessionData) {
			const session = JSON.parse(sessionData);
			// Check if session is still valid (not expired)
			if (session.expiresAt && new Date(session.expiresAt) > new Date()) {
				return session.userId;
			}
			// Clean up expired session
			await env.OAUTH_KV.delete(`session:${token}`);
		}
		
		// If not a session token, try validating as OAuth token
		// Check if it's stored in our OAuth token storage
		const oauthData = await env.OAUTH_KV.get(`oauth:${token}`);
		if (oauthData) {
			const oauth = JSON.parse(oauthData);
			return oauth.userId;
		}
		
		return null;
	} catch (error) {
		console.error('Error validating auth:', error);
		return null;
	}
}

async function checkUsageQuota(userId: string, env: Env): Promise<{ allowed: boolean; used: number; limit: number }> {
	const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM format
	
	// Get current usage from D1
	const result = await env.mcp_database.prepare(
		'SELECT classifications_used FROM usage_monthly WHERE user_id = ? AND month = ?'
	).bind(userId, currentMonth).first();
	
	const used = result?.classifications_used || 0;
	const limit = 500; // 500 classifications per month
	
	return {
		allowed: used < limit,
		used,
		limit
	};
}

async function updateUsage(userId: string, env: Env): Promise<void> {
	const currentMonth = new Date().toISOString().slice(0, 7);
	
	// Insert or update usage record
	await env.mcp_database.prepare(`
		INSERT INTO usage_monthly (user_id, month, classifications_used) 
		VALUES (?, ?, 1)
		ON CONFLICT (user_id, month) 
		DO UPDATE SET classifications_used = classifications_used + 1
	`).bind(userId, currentMonth).run();
}

// Generate a secure session token
function generateSessionToken(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Create a session for web users
async function createWebSession(userId: string, userEmail: string, env: Env): Promise<string> {
	const sessionToken = generateSessionToken();
	const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
	
	const sessionData = {
		userId,
		userEmail,
		createdAt: new Date().toISOString(),
		expiresAt: expiresAt.toISOString()
	};
	
	await env.OAUTH_KV.put(`session:${sessionToken}`, JSON.stringify(sessionData), {
		expirationTtl: 7 * 24 * 60 * 60 // 7 days in seconds
	});
	
	return sessionToken;
}

// Store or update user in database
async function upsertUser(googleId: string, email: string, name: string, env: Env): Promise<string> {
	try {
		// First, try to find existing user
		const existingUser = await env.mcp_database.prepare(
			'SELECT id FROM users WHERE google_id = ? OR email = ?'
		).bind(googleId, email).first();
		
		if (existingUser) {
			// Update existing user
			await env.mcp_database.prepare(
				'UPDATE users SET email = ?, updated_at = unixepoch() WHERE id = ?'
			).bind(email, existingUser.id).run();
			return existingUser.id as string;
		} else {
			// Create new user with google_id as the primary key
			await env.mcp_database.prepare(
				'INSERT INTO users (id, google_id, email, created_at, updated_at) VALUES (?, ?, ?, unixepoch(), unixepoch())'
			).bind(googleId, googleId, email).run();
			return googleId;
		}
	} catch (error) {
		console.error('Error upserting user:', error);
		// Fallback to using google_id as user_id if database fails
		return googleId;
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;
		
		// Handle ticket classification endpoint
		if (path === "/classify" && method === "POST") {
			try {
				// Validate authentication (Bearer token or session cookie)
				const userId = await getUserId(request, env);
				if (!userId) {
					return new Response(JSON.stringify({ error: 'Unauthorized' }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' }
					});
				}

				// Check usage quota
				const quota = await checkUsageQuota(userId, env);
				if (!quota.allowed) {
					return new Response(JSON.stringify({ 
						error: 'Usage quota exceeded',
						used: quota.used,
						limit: quota.limit
					}), {
						status: 429,
						headers: { 'Content-Type': 'application/json' }
					});
				}

				// Parse request body
				const body = await request.json() as { content: string; title?: string };
				if (!body.content) {
					return new Response(JSON.stringify({ error: 'Missing ticket content' }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' }
					});
				}

				// Classify the ticket
				const classifier = new TicketClassifier(env);
				const fullContent = body.title ? `${body.title}\n\n${body.content}` : body.content;
				const result = await classifier.classify(fullContent);

				// Store classification result in D1
				const classificationId = generateSessionToken(); // Generate unique ID
				await env.mcp_database.prepare(`
					INSERT INTO classifications (id, user_id, ticket_content, classification_result, ai_provider, confidence_score, created_at)
					VALUES (?, ?, ?, ?, ?, ?, unixepoch())
				`).bind(
					classificationId,
					userId, 
					fullContent.slice(0, 1000), // Truncate for storage
					JSON.stringify({
						category: result.category,
						priority: result.priority,
						reasoning: result.reasoning
					}),
					result.provider,
					result.confidence
				).run();

				// Update usage counter
				await updateUsage(userId, env);

				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (error) {
				console.error('Classification error:', error);
				return new Response(JSON.stringify({ 
					error: 'Classification failed',
					message: error instanceof Error ? error.message : 'Unknown error'
				}), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		}

		// Handle web login initiation
		if (path === "/login" && method === "GET") {
			// Generate state for web OAuth flow
			const state = generateSessionToken();
			const redirectUri = new URL('/callback/web', request.url).href;
			
			// Store state in KV for validation
			await env.OAUTH_KV.put(`web_state:${state}`, JSON.stringify({
				createdAt: new Date().toISOString(),
				redirectUri
			}), { expirationTtl: 600 }); // 10 minutes
			
			// Redirect to Google OAuth
			const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
			googleAuthUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
			googleAuthUrl.searchParams.set('redirect_uri', redirectUri);
			googleAuthUrl.searchParams.set('response_type', 'code');
			googleAuthUrl.searchParams.set('scope', 'email profile');
			googleAuthUrl.searchParams.set('state', state);
			if (env.HOSTED_DOMAIN) {
				googleAuthUrl.searchParams.set('hd', env.HOSTED_DOMAIN);
			}
			
			return new Response('', {
				status: 302,
				headers: { 'Location': googleAuthUrl.toString() }
			});
		}
		
		// Handle web OAuth callback
		if (path === "/callback/web" && method === "GET") {
			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');
			const error = url.searchParams.get('error');
			
			if (error) {
				return new Response(`OAuth error: ${error}`, { status: 400 });
			}
			
			if (!code || !state) {
				return new Response('Missing code or state parameter', { status: 400 });
			}
			
			// Validate state
			const storedStateData = await env.OAUTH_KV.get(`web_state:${state}`);
			if (!storedStateData) {
				return new Response('Invalid or expired state', { status: 400 });
			}
			
			// Clean up used state
			await env.OAUTH_KV.delete(`web_state:${state}`);
			
			try {
				// Exchange code for access token
				const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
						'Accept': 'application/json'
					},
					body: new URLSearchParams({
						client_id: env.GOOGLE_CLIENT_ID,
						client_secret: env.GOOGLE_CLIENT_SECRET,
						code,
						grant_type: 'authorization_code',
						redirect_uri: new URL('/callback/web', request.url).href
					})
				});
				
				if (!tokenResponse.ok) {
					return new Response(`Failed to exchange code: ${await tokenResponse.text()}`, { status: 500 });
				}
				
				const tokenData = await tokenResponse.json() as { access_token: string };
				
				// Get user info from Google
				const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
					headers: {
						'Authorization': `Bearer ${tokenData.access_token}`
					}
				});
				
				if (!userResponse.ok) {
					return new Response(`Failed to get user info: ${await userResponse.text()}`, { status: 500 });
				}
				
				const userData = await userResponse.json() as {
					id: string;
					name: string;
					email: string;
				};
				
				// Store/update user in database
				const userId = await upsertUser(userData.id, userData.email, userData.name, env);
				
				// Create web session
				const sessionToken = await createWebSession(userId, userData.email, env);
				
				// Redirect to dashboard with session cookie
				return new Response('', {
					status: 302,
					headers: {
						'Location': '/dashboard',
						'Set-Cookie': `session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`
					}
				});
				
			} catch (error) {
				console.error('OAuth callback error:', error);
				return new Response('Authentication failed', { status: 500 });
			}
		}

		// Handle dashboard endpoint
		if (path === "/dashboard" && method === "GET") {
			const userId = await getUserId(request, env);
			if (!userId) {
				// Redirect to web login
				return new Response('', {
					status: 302,
					headers: { 'Location': '/login' }
				});
			}

			// Simple dashboard HTML
			const dashboardHtml = `
			<!DOCTYPE html>
			<html>
			<head>
				<title>Support Triage Dashboard</title>
				<style>
					body { font-family: Arial, sans-serif; margin: 40px; }
					.container { max-width: 800px; margin: 0 auto; }
					.form-group { margin-bottom: 20px; }
					label { display: block; margin-bottom: 5px; font-weight: bold; }
					textarea { width: 100%; height: 200px; padding: 10px; border: 1px solid #ccc; }
					input[type="text"] { width: 100%; padding: 10px; border: 1px solid #ccc; }
					button { background: #007cba; color: white; padding: 10px 20px; border: none; cursor: pointer; }
					.result { margin-top: 20px; padding: 15px; background: #f0f0f0; border-left: 4px solid #007cba; }
					.error { background: #ffe6e6; border-left-color: #ff0000; }
				</style>
			</head>
			<body>
				<div class="container">
					<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
						<div>
							<h1>Support Ticket Classifier</h1>
							<p>Classify support tickets automatically using AI.</p>
						</div>
						<div>
							<button onclick="generateApiToken()" style="margin-right: 10px; background: #28a745; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Generate API Token</button>
							<form method="post" action="/logout" style="display: inline;">
								<button type="submit" style="background: #dc3545; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Logout</button>
							</form>
						</div>
					</div>
					
					<form id="classifyForm">
						<div class="form-group">
							<label for="title">Ticket Title (optional):</label>
							<input type="text" id="title" name="title">
						</div>
						
						<div class="form-group">
							<label for="content">Ticket Content:</label>
							<textarea id="content" name="content" required placeholder="Enter the support ticket content here..."></textarea>
						</div>
						
						<button type="submit">Classify Ticket</button>
					</form>
					
					<div id="result"></div>
				</div>
				
				<script>
				async function generateApiToken() {
					try {
						const response = await fetch('/api/token', {
							method: 'POST',
							credentials: 'include'
						});
						
						const data = await response.json();
						
						if (response.ok) {
							const modal = document.createElement('div');
							modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;';
							modal.innerHTML = \`
								<div style="background: white; padding: 30px; border-radius: 8px; max-width: 500px; width: 90%;">
									<h3>API Token Generated</h3>
									<p>Copy this token and store it securely. It will not be shown again.</p>
									<textarea readonly style="width: 100%; height: 100px; font-family: monospace; margin: 10px 0;">\${data.token}</textarea>
									<p style="font-size: 12px; color: #666;">Token expires in 30 days</p>
									<button onclick="this.parentElement.parentElement.remove()" style="background: #007cba; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Close</button>
								</div>
							\`;
							document.body.appendChild(modal);
						} else {
							alert('Failed to generate token: ' + (data.error || 'Unknown error'));
						}
					} catch (error) {
						alert('Network error: ' + error.message);
					}
				}
				
				document.getElementById('classifyForm').addEventListener('submit', async (e) => {
					e.preventDefault();
					
					const title = document.getElementById('title').value;
					const content = document.getElementById('content').value;
					const resultDiv = document.getElementById('result');
					
					resultDiv.innerHTML = '<p>Classifying...</p>';
					
					try {
						const response = await fetch('/classify', {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json'
								// No Authorization header needed - using cookie-based auth
							},
							credentials: 'include', // Include cookies
							body: JSON.stringify({ title, content })
						});
						
						const data = await response.json();
						
						if (response.ok) {
							resultDiv.innerHTML = \`
								<div class="result">
									<h3>Classification Result</h3>
									<p><strong>Category:</strong> \${data.category}</p>
									<p><strong>Priority:</strong> \${data.priority}</p>
									<p><strong>Confidence:</strong> \${(data.confidence * 100).toFixed(1)}%</p>
									<p><strong>Reasoning:</strong> \${data.reasoning}</p>
									<p><strong>Provider:</strong> \${data.provider}</p>
								</div>
							\`;
						} else {
							resultDiv.innerHTML = \`<div class="result error"><p>Error: \${data.error}</p></div>\`;
						}
					} catch (error) {
						resultDiv.innerHTML = \`<div class="result error"><p>Network error: \${error.message}</p></div>\`;
					}
				});
				</script>
			</body>
			</html>
			`;

			return new Response(dashboardHtml, {
				headers: { 'Content-Type': 'text/html' }
			});
		}

		// Handle usage API endpoint
		if (path === "/api/usage" && method === "GET") {
			const userId = await getUserId(request, env);
			if (!userId) {
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			const quota = await checkUsageQuota(userId, env);
			const currentMonth = new Date().toISOString().slice(0, 7);

			// Get recent classifications
			const recentClassifications = await env.mcp_database.prepare(
				'SELECT classification_result, ai_provider, confidence_score, created_at FROM classifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
			).bind(userId).all();

			return new Response(JSON.stringify({
				month: currentMonth,
				usage: {
					used: quota.used,
					limit: quota.limit,
					remaining: quota.limit - quota.used
				},
				recentClassifications: recentClassifications.results
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		
		// Handle logout endpoint
		if (path === "/logout" && method === "POST") {
			const cookies = request.headers.get('Cookie');
			if (cookies) {
				const sessionMatch = cookies.match(/session=([^;]+)/);
				if (sessionMatch) {
					const sessionToken = sessionMatch[1];
					// Delete session from KV
					await env.OAUTH_KV.delete(`session:${sessionToken}`);
				}
			}
			
			// Clear session cookie and redirect to home
			return new Response('', {
				status: 302,
				headers: {
					'Location': '/',
					'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
				}
			});
		}
		
		// Handle API token generation for web users
		if (path === "/api/token" && method === "POST") {
			const userId = await getUserId(request, env);
			if (!userId) {
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			
			// Generate a Bearer token for API access
			const bearerToken = generateSessionToken();
			
			// Store token in KV with 30-day expiration
			await env.OAUTH_KV.put(`oauth:${bearerToken}`, JSON.stringify({
				userId,
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
			}), {
				expirationTtl: 30 * 24 * 60 * 60 // 30 days
			});
			
			return new Response(JSON.stringify({ 
				token: bearerToken,
				expiresIn: 30 * 24 * 60 * 60 // 30 days in seconds
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		
		// Handle homepage
		if (path === "/" || path === "") {
			// @ts-ignore
			const homePage = await import('./pages/index.html');
			return new Response(homePage.default, {
				headers: { "Content-Type": "text/html" },
			});
		}

		// Handle payment success page
		if (path === "/payment/success") {
			// @ts-ignore
			const successPage = await import('./pages/payment-success.html');
			return new Response(successPage.default, {
				headers: { "Content-Type": "text/html" },
			});
		}
		
		// All other routes go to OAuth provider
		return oauthProvider.fetch(request, env, ctx);
	},
};