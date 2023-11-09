import { Router } from 'itty-router';
import OpenAI, { toFile } from 'openai';
import { getCorsHeaders } from './util';

const router = Router()
const encoder = new TextEncoder()

const models = {
  'gpt-3.5-turbo': 'GPT-3.5 Turbo (4k context)',
  'gpt-3.5-turbo-16k': 'GPT-3.5 Turbo (16k context)',
  'gpt-4': 'GPT-4 (8k context)',
  'gpt-4-1106-preview': 'GPT-4 Turbo (128k context)',
  'gpt-4-vision-preview': 'GPT-4V (128k context)',
}

router.get('/api/models', (request, env) => {
  return new Response(JSON.stringify(models), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env)
    }
  })
})

router.post("/api/generate", async (request, env: Env) => {
  const body: any = await request.json()
  if (!body.model) return new Response(null, { status: 400 })
  if (!body.content) return new Response(null, { status: 400 })
  if (!body.content.length) return new Response(null, { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  const stream = await client.chat.completions.create({
    model: body.model,
    messages: body.content,
    stream: true,
    max_tokens: body.model.includes('vision') ? 2000 : null,
    user: request.headers.get('CF-Connecting-IP') || undefined
  })
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  !(async () => {
    for await (const chunk of stream) {
      if (chunk.choices[0].delta.content) {
        writer.ready.then(() => writer.write(encoder.encode(chunk.choices[0].delta.content!)))
      }
    }
    writer.ready.then(() => writer.close())
  })().then(() => 'dummy').catch(e => console.error(e.stack || e))
  return new Response(readable, {
    headers: {
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/event-stream', // not really
      ...getCorsHeaders(request, env),
    }
  })
})

router.post('/api/threads/create_and_run', async (request, env) => {
  const body: any = await request.json()
  if (!body.model) return new Response('missing model', { status: 400, headers: getCorsHeaders(request, env) })
  if (!body.messages) return new Response('missing messages', { status: 400, headers: getCorsHeaders(request, env) })
  if (body.messages.length !== 1) return new Response('must have exact 1 messages', { status: 400, headers: getCorsHeaders(request, env) })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  const uploadedFiles = new Array<string>()
  try {
    for (const file of (body.files || [])) {
      uploadedFiles.push((await client.files.create({
        file: await toFile(new Uint8Array(file.data), file.name),
        purpose: 'assistants'
      })).id)
    }
    const res = await client.beta.threads.createAndRun({
      assistant_id: env.ASSISTANT_ID,
      thread: {
        messages: [{...body.messages[0], file_ids: uploadedFiles}],
      },
      model: body.model,
      instructions: body.instructions || undefined,
      tools: body.tools || [],
    })
    return new Response(JSON.stringify(res), {
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders(request, env),
      }
    })
  } catch (e) {
    for (const file of uploadedFiles) {
      try {
        await client.files.del(file)
      } catch (e2: any) {
        console.error('Error deleting file ' + file, e2.stack || e)
      }
    }
    throw e
  }
})

router.delete('/api/threads/:thread_id', async (request, env) => {
  const threadId = request.params.thread_id
  if (!threadId) return new Response(null, { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  return new Response(JSON.stringify(await client.beta.threads.del(threadId)), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    }
  })
})

router.get('/api/threads/:thread_id/messages', async (request, env) => {
  const threadId = request.params.thread_id
  if (!threadId) return new Response(null, { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  return new Response(JSON.stringify(await client.beta.threads.messages.list(threadId, { limit: 10 })), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    }
  })
})

router.post('/api/threads/:thread_id/messages', async (request, env) => {
  const threadId = request.params.thread_id
  if (!threadId) return new Response(null, { status: 400 })
  const body: any = await request.json()
  if (body.role !== 'user') return new Response('role must be "user"', { status: 400 })
  if (!body.content) return new Response('missing content', { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  const uploadedFiles = new Array<string>()
  try {
    for (const file of (body.files || [])) {
      uploadedFiles.push((await client.files.create({
        file: await toFile(new Uint8Array(file.data), file.name),
        purpose: 'assistants'
      })).id)
    }
    const res = await client.beta.threads.messages.create(threadId, {
      role: body.role,
      content: body.content,
      file_ids: uploadedFiles,
    })
    return new Response(JSON.stringify(res), {
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders(request, env),
      }
    })
  } catch (e) {
    for (const file of uploadedFiles) {
      try {
        await client.files.del(file)
      } catch (e2: any) {
        console.error('Error deleting file ' + file, e2.stack || e)
      }
    }
    throw e
  }
})

router.post('/api/threads/:thread_id/runs', async (request, env) => {
  const threadId = request.params.thread_id
  if (!threadId) return new Response(null, { status: 400 })
  const body: any = await request.json()
  if (!body.model) return new Response('missing model', { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  return new Response(JSON.stringify(await client.beta.threads.runs.create(threadId, {
    assistant_id: env.ASSISTANT_ID,
    model: body.model,
    instructions: body.instructions || undefined,
    tools: body.tools || [],
  })), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    }
  })
})

router.get('/api/threads/:thread_id/runs/:run_id', async (request, env) => {
  const threadId = request.params.thread_id
  if (!threadId) return new Response(null, { status: 400 })
  const runId = request.params.run_id
  if (!runId) return new Response(null, { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  return new Response(JSON.stringify(await client.beta.threads.runs.retrieve(threadId, runId)), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    }
  })
})

router.post('/api/threads/:thread_id/runs/:run_id/submit_tool_outputs', async (request, env) => {
  const threadId = request.params.thread_id
  if (!threadId) return new Response(null, { status: 400 })
  const runId = request.params.run_id
  if (!runId) return new Response(null, { status: 400 })
  const body: any[] = await request.json()
  if (!body.length) return new Response('missing array', { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  return new Response(JSON.stringify(await client.beta.threads.runs.submitToolOutputs(threadId, runId, { tool_outputs: body })), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    }
  })
})

router.post('/api/request', async (request, env) => {
  return await fetch(await request.text()).then(res => {
    const clone = new Response(res.body, res)
    const headers = getCorsHeaders(request, env)
    // @ts-ignore
    Object.keys(headers).forEach(key => clone.headers.set(key, headers[key]))
    return clone
  })
})

router.post('/api/search', async (request, env: Env) => {
  const key = env.CUSTOM_SEARCH_KEY
  if (!key) return new Response('{"error":"Search API is unavailable"}', { status: 503 })
  const id = env.CUSTOM_SEARCH_ID
  if (!id) return new Response('{"error":"Search API is unavailable"}', { status: 503 })
  const query = await request.text()
  const url = new URL('https://customsearch.googleapis.com/customsearch/v1')
  url.searchParams.set('key', key)
  url.searchParams.set('cx', id)
  url.searchParams.set('q', query)
  const country = request.headers.get('CF-IPCountry')
  if (country) {
    url.searchParams.set('gl', country)
  }
  return await fetch(url).then(res => {
    const clone = new Response(res.body, res)
    const headers = getCorsHeaders(request, env)
    // @ts-ignore
    Object.keys(headers).forEach(key => clone.headers.set(key, headers[key]))
    return clone
  })
})

router.get('/api/threads/:thread_id/runs/:run_id/steps', async (request, env) => {
  const threadId = request.params.thread_id
  if (!threadId) return new Response(null, { status: 400 })
  const runId = request.params.run_id
  if (!runId) return new Response(null, { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  return new Response(JSON.stringify(await client.beta.threads.runs.steps.list(threadId, runId, { limit: 20 })), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    }
  })
})

router.get('/api/files/:id', async (request, env) => {
  const id = request.params.id
  if (!id) return new Response(null, { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  return new Response(JSON.stringify(await client.files.retrieve(id)), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    }
  })
})

router.get('/api/files/:id/content', async (request, env) => {
  const id = request.params.id
  if (!id) return new Response(null, { status: 400 })
  return await fetch('https://api.openai.com/v1/files/' + id + '/content', {
    headers: {
      Authorization: 'Bearer ' + env.OPENAI_TOKEN
    }
  }).then(res => {
    const clone = new Response(res.body, res)
    const headers = getCorsHeaders(request, env)
    // @ts-ignore
    Object.keys(headers).forEach(key => clone.headers.set(key, headers[key]))
    return clone
  })
})

// 404 for everything else
router.all('*', () => new Response('Not Found.', { status: 404 }));

export default router;
