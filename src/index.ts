import apiRouter from './router';
import { getCorsHeaders } from './util';

export default {
  // all routes starts with /api, so you can use Workers Routes to attach to existing application
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // console.log(request)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: getCorsHeaders(request, env)
      })
    }
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      return apiRouter.handle(request, env)
    }

    return new Response(null, { status: 404 })
  },
}
