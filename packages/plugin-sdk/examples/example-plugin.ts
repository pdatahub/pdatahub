/**
 * Example pdatahub plugin.
 *
 * Demonstrates:
 *  - Subclassing `Plugin`
 *  - The @Tool decorator for exposing methods
 *  - The @OAuth decorator for declaring an OAuth flow
 *  - Using `this.httpClient` for authenticated requests
 *  - Calling `.start()` to run as a JSON-RPC subprocess
 *
 * This plugin uses jsonplaceholder.typicode.com as a mock backend so it can
 * be tested without any real credentials. In a real plugin, you'd point the
 * OAuth config at the actual service.
 */
import { Plugin, Tool, OAuth, HttpClient } from '../src/index.js';

@OAuth({
  authorizationUrl: 'https://example.com/oauth/authorize',
  tokenUrl: 'https://example.com/oauth/token',
  scopes: ['posts.read', 'posts.write'],
})
export default class ExamplePlugin extends Plugin {
  name = 'example';
  version = '0.1.0';
  description = 'Example plugin demonstrating the pdatahub plugin SDK';

  /**
   * Override OAuth callback. In a real plugin, exchange `code` for a token
   * via `tokenUrl` (typically with HTTP POST + form-encoded body).
   *
   * The Hub handles most of the OAuth dance; this method is called after
   * the user grants permission. Returning the access token is enough — the
   * Hub stores it securely.
   */
  async handleOAuthCallback(code: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  }> {
    this.logger?.info(`OAuth callback received (code=${code.slice(0, 8)}...)`);
    // Demo only — a real plugin would POST to `tokenUrl`.
    return { accessToken: 'demo-token-' + Date.now() };
  }

  /**
   * Called once on `initialize`, before any tool invocations.
   * Use for setup, cache warming, etc.
   */
  async onStart(): Promise<void> {
    this.logger?.info('Example plugin starting up');
  }

  /**
   * Get a single post. Demonstrates a simple GET with a path parameter.
   */
  @Tool({ scope: 'posts.read', description: 'Fetch a single post by id' })
  async getPost(id: number) {
    if (!this.httpClient) throw new Error('HTTP client not initialized');
    const response = await this.httpClient.get(
      `https://jsonplaceholder.typicode.com/posts/${id}`,
    );
    return response.data;
  }

  /**
   * List posts with optional limit. Demonstrates query params + defaults.
   */
  @Tool({ scope: 'posts.list', description: 'List posts, optionally limited' })
  async listPosts(limit: number = 10) {
    if (!this.httpClient) throw new Error('HTTP client not initialized');
    const response = await this.httpClient.get(
      'https://jsonplaceholder.typicode.com/posts',
      { params: { _limit: limit } },
    );
    return response.data;
  }

  /**
   * Create a post. Demonstrates POST with JSON body.
   */
  @Tool({ scope: 'posts.write', description: 'Create a new post' })
  async createPost(title: string, body: string, userId: number = 1) {
    if (!this.httpClient) throw new Error('HTTP client not initialized');
    const response = await this.httpClient.post(
      'https://jsonplaceholder.typicode.com/posts',
      { title, body, userId },
    );
    return response.data;
  }
}

// Re-export so this file can be used as a TypeScript module too.
export { ExamplePlugin, HttpClient };

// Run if executed directly: `node dist/examples/example-plugin.js` or
// `npx tsx examples/example-plugin.ts`. The plugin listens on stdin.
if (require.main === module) {
  new ExamplePlugin().start().catch((err: Error) => {
    process.stderr.write(`Plugin failed: ${err.message}\n`);
    process.exit(1);
  });
}