import { Router } from 'itty-router';
import OpenAI, { toFile } from 'openai';
import {
  calculateLength,
  getCorsHeaders,
  getDefaultUserData,
  getStripe,
  getUserDataById,
  insertBQRecordUsage,
  insertBQRecordUsageAll,
  mergeDeep,
  redirectCors,
  UsageTable,
  SUMMARIZE_PROMPT
} from './util';
import Stripe from 'stripe';
import { OAuthApp, Octokit } from 'octokit';
import { Env, KeyFilter } from './index';
import { parse as parseCookie } from 'cookie';
import { imageModels, InviteCode, models } from './constants';
import { KVNamespace } from '@cloudflare/workers-types';

const router = Router()
const encoder = new TextEncoder()

const COOKIE_NAME = "sid"

export const addString = async (env: Env, kv: KeyFilter<Env, KVNamespace>, key: string, value: string) => {
  const list: string[] = (await env[kv].get(key, { type: 'json' })) || []
  if (!list.includes(value)) {
    list.push(value)
    await env[kv].put(key, JSON.stringify(list))
  }
}

export const addTrackedRuns = (env: Env, user_id: string, thread_id: string, run_id: string, usage: number) =>
  addString(env, 'KV_USERS', '__tracked_runs', `${user_id}|${thread_id}|${run_id}|${usage}`)

export const getOAuthApp = (env: Env) => {
  if (!env?.GITHUB_CLIENT_ID) throw new Error('GITHUB_CLIENT_ID is missing')
  if (!env?.GITHUB_CLIENT_SECRET) throw new Error('GITHUB_CLIENT_SECRET is missing')
  return new OAuthApp({
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
  })
}

export const getSessionId = (request: any) => {
  const cookie = parseCookie(request.headers.get('Cookie') || '')
  if (cookie[COOKIE_NAME] != null) {
    return cookie[COOKIE_NAME]
  }
  return null
}

export const getUserId = async (request: any, env: Env) => {
  const sessionId = getSessionId(request)
  if (!sessionId) return null
  return await env.KV_SESSIONS.get(sessionId)
}

export const getUserData = async (request: any, env: Env) => {
  const userId = await getUserId(request, env)
  if (!userId) return null
  const data = await env.KV_USERS.get<ReturnType<typeof getDefaultUserData>>(userId, { type: 'json' })
  if (!data) return getDefaultUserData()
  return mergeDeep(getDefaultUserData(), data)
}

export const getRemainingModelUsage = async (request: any, env: Env, model: keyof typeof models): Promise<number | null> => {
  const userData = await getUserData(request, env)
  return getRemainingModelUsageByData(userData, model)
}

export const getRemainingModelUsageByData = async (userData: ReturnType<typeof getDefaultUserData> | null, model: keyof typeof models): Promise<number | null> => {
  if (!userData || !userData.active || !userData.stripe_customer_id) return 0
  const limit = userData.limits[model]
  if (!limit) return 0
  const types: ['minute', 'day'] = ['minute', 'day']
  let calculatedLimit = null
  for (const type of types) {
    const thisLimit = limit[type]
    if (thisLimit === 0) {
      return 0
    } else if (thisLimit !== null) {
      const used = userData.used[model][type]
      if (calculatedLimit === null) {
        calculatedLimit = Math.max(0, thisLimit - used)
      } else {
        calculatedLimit = Math.min(calculatedLimit, Math.max(0, thisLimit - used))
      }
    }
  }
  return calculatedLimit
}

export const addUserIdToUsage = (env: Env, userId: string) =>
  Promise.all([addString(env, 'KV_USERS', '__usage', userId), addString(env, 'KV_USERS', '__usage_daily', userId)])

export const incrementUsage = async (env: Env, model: keyof typeof models | 'file', userId: string, userData: ReturnType<typeof getDefaultUserData>, count: number) => {
  const types: ['minute', 'day'] = ['minute', 'day']
  if (count) {
    if (typeof userData.used[model] === 'undefined') return
    for (const type of types) {
      userData.used[model][type] += count
    }
    userData.usage_text_since_last_record[model] += count
    await env.KV_USERS.put(userId, JSON.stringify(userData))
    await addUserIdToUsage(env, userId)
  }
}

/**
 * Checks if user can use the specified model.
 * @param userId
 * @param userData
 * @param env the env
 * @param model the model to check
 * @param incrementUsageBy how much the usage should be incremented
 * @returns true if allowed; false otherwise
 */
export const checkModelUsage = async (userId: string, userData: ReturnType<typeof getDefaultUserData>, env: Env, model: keyof typeof models, incrementUsageBy: number = 0): Promise<boolean> => {
  const limit = userData.limits[model]
  if (!limit) return false
  const types: ['minute', 'day'] = ['minute', 'day']
  for (const type of types) {
    const thisLimit = limit[type]
    if (thisLimit === null) continue
    if (userData.used[model][type] >= thisLimit) {
      return false
    }
  }
  if (incrementUsageBy) {
    await incrementUsage(env, model, userId, userData, incrementUsageBy)
  }
  return true
}

/**
 * Checks if user can use the specified image generation model.
 * @param userId
 * @param userData
 * @param request the request
 * @param env the env
 * @param model the model to check
 * @param incrementUsage true if method should increment the "used" count
 * @returns true if allowed; false otherwise
 */
export const checkImageModelUsage = async (userId: string, userData: ReturnType<typeof getDefaultUserData>, request: any, env: Env, model: keyof typeof imageModels, incrementUsage: boolean = false): Promise<boolean> => {
  const limit = userData.image_limits[model]
  if (!limit) return false
  const types: ['minute', 'day'] = ['minute', 'day']
  for (const type of types) {
    const thisLimit = limit[type]
    if (thisLimit === null) continue
    if (userData.image_used[model][type] >= thisLimit) {
      return false
    }
  }
  if (incrementUsage) {
    userData.usage_image_since_last_record[model]++
    for (const type of types) {
      userData.image_used[model][type]++
    }
    await env.KV_USERS.put(userId, JSON.stringify(userData))
    await addUserIdToUsage(env, userId)
  }
  return true
}

// Texts (Chat & Assistants)
router.get('/api/models', (request, env) => {
  return new Response(JSON.stringify(models), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env)
    }
  })
})

router.post("/api/generate", async (request, env: Env) => {
  const userId = (await getUserId(request, env))
  if (!userId) return new Response(null, { status: 401 })
  const userData = (await getUserDataById(env, userId))
  if (!userData || !userData.active || !userData.stripe_customer_id) return new Response(null, { status: 403 })
  const body: any = await request.json()
  if (!body.model) return new Response(null, { status: 400 })
  if (!body.content) return new Response(null, { status: 400 })
  if (!Array.isArray(body.content)) return new Response(null, { status: 400 })
  const length = calculateLength(body.content)
  if (length === 0) return new Response(null, { status: 400 })
  if (!(await checkModelUsage(userId, userData, env, body.model, 0))) return new Response(null, { status: 429 })
  const remainingUsage = await getRemainingModelUsage(request, env, body.model)
  if (remainingUsage !== null && remainingUsage <= 0) return new Response(null, { status: 429 })
  const max_tokens =
    body.model.includes('vision')
      ? Math.min(remainingUsage === null ? 2000 : remainingUsage, 2000)
      : (remainingUsage === null || remainingUsage > 2000 ? null : remainingUsage)
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  if ((await client.moderations.create({input: JSON.stringify(body.content[body.content.length - 1])})).results.some(e => e.flagged)) {
    return new Response('flagged', { status: 403 })
  }
  const stream = await client.chat.completions.create({
    model: body.model,
    messages: body.content,
    stream: true,
    max_tokens,
    user: request.headers.get('CF-Connecting-IP') || undefined
  })
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  ;(async () => {
    let count = 0
    await insertBQRecordUsage(env, userId, userData.stripe_customer_id, 'generate_chat_by_user', body.model, length)
    await incrementUsage(env, body.model, userId, userData, length)
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content
      if (content) {
        count += content.length
        writer.ready.then(() => writer.write(encoder.encode(content)))
      }
    }
    writer.ready.then(async () => {
      await insertBQRecordUsage(env, userId, userData.stripe_customer_id, 'generated_chat_by_assistant', body.model, count)
      await incrementUsage(env, body.model, userId, userData, count)
      await writer.close()
    })
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

router.post('/api/summarize', async (request, env: Env) => {
  const content = await request.text()
  if (!content || content.length > 1000) return new Response(null, { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  let summary = await client.chat.completions.create({
    model: 'gpt-4-1106-preview',
    messages: [{role: 'system', content: SUMMARIZE_PROMPT}, {role: 'user', content}],
    max_tokens: 40,
    temperature: 0,
    stop: '\n',
    user: request.headers.get('CF-Connecting-IP') || undefined
  }).then(res => res.choices[0].message.content)
  if (!summary) {
    return new Response(null, { headers: getCorsHeaders(request, env) })
  }
  if ((summary.startsWith('"') && summary.endsWith('"')) || (summary.startsWith('「') && summary.endsWith('」'))) {
    summary = summary.substring(1, summary.length - 1)
  }
  return new Response(summary, { headers: getCorsHeaders(request, env) })
})

router.post('/api/threads/create_and_run', async (request, env) => {
  const userId = (await getUserId(request, env))
  if (!userId) return new Response(null, { status: 401 })
  const userData = (await getUserDataById(env, userId))
  if (!userData || !userData.active || !userData.stripe_customer_id) return new Response(null, { status: 403 })
  const body: any = await request.json()
  if (!body.model) return new Response('missing model', { status: 400, headers: getCorsHeaders(request, env) })
  if (!body.messages) return new Response('missing messages', { status: 400, headers: getCorsHeaders(request, env) })
  if (body.messages.length !== 1) return new Response('must have exact 1 messages', { status: 400, headers: getCorsHeaders(request, env) })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  if ((await client.moderations.create({input: body.messages[0].content})).results.some(e => e.flagged)) {
    return new Response('flagged', { status: 403 })
  }
  const tools = !body.tools ? [] : (userData.allow_retrieval_tool ? body.tools : body.tools.filter((e: any) => e.type !== 'retrieval'))
  if (!(await checkModelUsage(userId, userData, env, body.model, 0))) return new Response(null, { status: 429 })
  const uploadedFiles = new Array<{id: string, bytes: number}>()
  try {
    for (const file of (body.files || [])) {
      const uploaded = await client.files.create({
        file: await toFile(new Uint8Array(file.data), file.name),
        purpose: 'assistants'
      })
      uploadedFiles.push({id: uploaded.id, bytes: uploaded.bytes})
    }
    const res = await client.beta.threads.createAndRun({
      assistant_id: env.ASSISTANT_ID,
      thread: {
        messages: [{...body.messages[0], file_ids: uploadedFiles.map(e => e.id)}],
      },
      model: body.model,
      instructions: body.instructions || undefined,
      tools,
    })
    const bqUsage: UsageTable[] = uploadedFiles.map(({id}) => ({
      user_id: userId,
      stripe_customer_id: userData.stripe_customer_id,
      action: 'upload_file',
      timestamp: Date.now(),
      model: body.model,
      count: 1,
      extra: id,
    }))
    bqUsage.push({
      user_id: userId,
      stripe_customer_id: userData.stripe_customer_id,
      action: 'create_and_run',
      timestamp: Date.now(),
      model: body.model,
      count: 0,
      extra: null,
    })
    await insertBQRecordUsageAll(env, bqUsage)
    await addTrackedRuns(env, userId, res.thread_id, res.id, 0)
    await incrementUsage(env, 'file', userId, userData, uploadedFiles.length * 1000)
    return new Response(JSON.stringify(res), {
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders(request, env),
      }
    })
  } catch (e) {
    for (const file of uploadedFiles) {
      try {
        await client.files.del(file.id)
      } catch (e2: any) {
        console.error('Error deleting file ' + file, e2.stack || e)
      }
    }
    throw e
  }
})

router.delete('/api/threads/:thread_id', async (request, env) => {
  if ((() => true)()) return new Response(null, { status: 200, headers: getCorsHeaders(request, env) })
  // following code will not run
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
  const userId = (await getUserId(request, env))
  if (!userId) return new Response(null, { status: 401 })
  const userData = (await getUserDataById(env, userId))
  if (!userData || !userData.active || !userData.stripe_customer_id) return new Response(null, { status: 403 })
  const threadId = request.params.thread_id
  if (!threadId) return new Response(null, { status: 400 })
  const body: any = await request.json()
  if (body.role !== 'user') return new Response('role must be "user"', { status: 400 })
  if (!body.content) return new Response('missing content', { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  if ((await client.moderations.create({input: body.content})).results.some(e => e.flagged)) {
    return new Response('flagged', { status: 403 })
  }
  const uploadedFiles = new Array<{id: string, bytes: number}>()
  try {
    for (const file of (body.files || [])) {
      const uploaded = await client.files.create({
        file: await toFile(new Uint8Array(file.data), file.name),
        purpose: 'assistants'
      })
      uploadedFiles.push({id: uploaded.id, bytes: uploaded.bytes})
    }
    const res = await client.beta.threads.messages.create(threadId, {
      role: body.role,
      content: body.content,
      file_ids: uploadedFiles.map(e => e.id),
    })
    const bqUsage: UsageTable[] = uploadedFiles.map(({id}) => ({
      user_id: userId,
      stripe_customer_id: userData.stripe_customer_id,
      action: 'upload_file',
      timestamp: Date.now(),
      model: body.model,
      count: 1,
      extra: id,
    }))
    await insertBQRecordUsageAll(env, bqUsage)
    await incrementUsage(env, 'file', userId, userData, uploadedFiles.length * 1000)
    return new Response(JSON.stringify(res), {
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders(request, env),
      }
    })
  } catch (e) {
    for (const file of uploadedFiles) {
      try {
        await client.files.del(file.id)
      } catch (e2: any) {
        console.error('Error deleting file ' + file, e2.stack || e)
      }
    }
    throw e
  }
})

router.post('/api/threads/:thread_id/runs', async (request, env) => {
  const userId = (await getUserId(request, env))
  if (!userId) return new Response(null, { status: 401 })
  const userData = (await getUserDataById(env, userId))
  if (!userData || !userData.active || !userData.stripe_customer_id) return new Response(null, { status: 403 })
  const threadId = request.params.thread_id
  if (!threadId) return new Response(null, { status: 400 })
  const body: any = await request.json()
  if (!body.model) return new Response('missing model', { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  const tools = !body.tools ? [] : (userData.allow_retrieval_tool ? body.tools : body.tools.filter((e: any) => e.type !== 'retrieval'))
  const res = await client.beta.threads.runs.create(threadId, {
    assistant_id: env.ASSISTANT_ID,
    model: body.model,
    instructions: body.instructions || undefined,
    tools,
  })
  await addTrackedRuns(env, userId, res.thread_id, res.id, 0)
  return new Response(JSON.stringify(res), {
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
  const userId = (await getUserId(request, env))
  if (!userId) return new Response(null, { status: 401 })
  const userData = (await getUserDataById(env, userId))
  if (!userData || !userData.active || !userData.stripe_customer_id) return new Response(null, { status: 403 })
  const threadId = request.params.thread_id
  if (!threadId) return new Response(null, { status: 400 })
  const runId = request.params.run_id
  if (!runId) return new Response(null, { status: 400 })
  const body: any[] = await request.json()
  if (!body.length) return new Response('missing array', { status: 400 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  const model = (await client.beta.threads.runs.retrieve(threadId, runId)).model as keyof typeof models
  return new Response(JSON.stringify(
    await client.beta.threads.runs.submitToolOutputs(threadId, runId, { tool_outputs: body }).then(async res => {
      const length = calculateLength(body.map((e: any) => e.output))
      await insertBQRecordUsage(env, userId, userData.stripe_customer_id, 'submit_tool_outputs', model, length, JSON.stringify({
        thread_id: threadId,
        run_id: runId,
      }))
      await incrementUsage(env, model, userId, userData, length)
      return res
    })
  ), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    }
  })
})

router.post('/api/search', async (request, env: Env) => {
  const userId = (await getUserId(request, env))
  if (!userId) return new Response(null, { status: 401 })
  const userData = (await getUserDataById(env, userId))
  if (!userData || !userData.active || !userData.stripe_customer_id) return new Response(null, { status: 403 })
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
  const userId = (await getUserId(request, env))
  if (!userId) return new Response(null, { status: 401 })
  const userData = (await getUserDataById(env, userId))
  if (!userData || !userData.active || !userData.stripe_customer_id) return new Response(null, { status: 403 })
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
  const userId = (await getUserId(request, env))
  if (!userId) return new Response(null, { status: 401 })
  const userData = (await getUserDataById(env, userId))
  if (!userData || !userData.active || !userData.stripe_customer_id) return new Response(null, { status: 403 })
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

// Images
router.get('/api/image_models', (request, env) => {
  return new Response(JSON.stringify(imageModels), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env)
    }
  })
})

router.post('/api/generate_image', async (request, env) => {
  const userId = (await getUserId(request, env))
  if (!userId) return new Response(null, { status: 401 })
  const userData = (await getUserDataById(env, userId))
  if (!userData || !userData.active || !userData.stripe_customer_id) return new Response(null, { status: 403 })
  const body = await request.json()
  if (!body.prompt) return new Response(null, { status: 400 })
  if (!(await checkImageModelUsage(userId, userData, request, env, body.model))) return new Response(null, { status: 429 })
  const client = new OpenAI({ apiKey: env.OPENAI_TOKEN })
  return new Response(JSON.stringify(await client.images.generate({
    ...body,
    response_format: 'b64_json',
    user: request.headers.get('CF-Connecting-IP') || undefined,
  })), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    }
  })
})

// Users
router.post('/api/update_default_instruction', async (request, env) => {
  const userId = await getUserId(request, env)
  if (!userId) return new Response(null, { status: 401, headers: getCorsHeaders(request, env) })
  const userData = await getUserDataById(env, userId)
  if (!userData) return new Response(null, { status: 401, headers: getCorsHeaders(request, env) })
  const instruction = await request.text()
  if (userData.default_instruction !== instruction) {
    userData.default_instruction = instruction
    await env.KV_USERS.put(userId, JSON.stringify(userData))
  }
  return new Response(null, { status: 200 })
})

router.get('/api/login/:provider', async (request, env: Env) => {
  if (request.params.provider === 'github') {
    return Response.redirect(`https://github.com/login/oauth/authorize?scope=user&client_id=${env.GITHUB_CLIENT_ID}`, 303)
  } else if (request.params.provider === 'discord') {
    return Response.redirect(`https://discord.com/oauth2/authorize?response_type=code&client_id=${env.DISCORD_CLIENT_ID}&scope=identify&redirect_uri=${encodeURI(env.DISCORD_REDIRECT_URL)}`, 303)
  } else {
    return new Response(null, { status: 400 })
  }
})

router.get('/api/callback/:provider', async (request, env: Env) => {
  const loggedUserId = await getUserId(request, env)
  const isLocal = request.headers.get('Host').includes('localhost')
  const redirectTo = isLocal ? 'http://localhost:3000/' : `https://${request.headers.get('Host')}/`
  const sessionId = crypto.randomUUID()
  if (request.params.provider === 'github') {
    const app = getOAuthApp(env)
    const { authentication: { token } } = await app.createToken({ code: String(request.query.code) })
    const octokit = new Octokit({ auth: token })
    const { data: github } = await octokit.rest.users.getAuthenticated()
    const twoFactorAuthentication = (github as unknown as any).two_factor_authentication
    if (!twoFactorAuthentication) return Response.redirect(redirectTo + '#no2fa', 303)
    let userId: string
    const existingUserId = await env.KV_GITHUB.get(github.id.toString())
    if (existingUserId) {
      userId = existingUserId
    } else {
      userId = loggedUserId || crypto.randomUUID()
      await env.KV_GITHUB.put(github.id.toString(), userId)
      if (userId !== loggedUserId) {
        // newly created user
        const userData = getDefaultUserData()
        if (!env.REQUIRE_INVITE) {
          userData.active = true
        }
        await env.KV_USERS.put(userId, JSON.stringify(userData))
      }
    }
    await env.KV_SESSIONS.put(sessionId, userId, { expirationTtl: 2592000 })
    return new Response('<html lang="en"><head><meta http-equiv="refresh" content="0;URL=\'' + redirectTo + '\'"><title>Redirecting...</title></head></html>', {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'Set-Cookie': `${COOKIE_NAME}=${sessionId}; Max-Age=2592000; Secure; SameSite=${isLocal ? 'None' : 'Lax'}; HttpOnly; Path=/`,
      },
    })
  } else if (request.params.provider === 'discord') {
    if (!request.query.code) return Response.redirect(redirectTo + '#invalid_code', 303)
    const token: any = await fetch(`https://discord.com/api/oauth2/token`, {
      method: 'POST',
      body: `client_id=${env.DISCORD_CLIENT_ID}&client_secret=${env.DISCORD_CLIENT_SECRET}&grant_type=authorization_code&code=${request.query.code}&redirect_uri=${encodeURI(env.DISCORD_REDIRECT_URL)}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }).then(r => r.json())
    if (!token.access_token) return Response.redirect(redirectTo + '#invalid_response', 303)
    const user: any = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
      },
    }).then(r => r.json())
    if (!user.id) return Response.redirect(redirectTo + '#invalid_response', 303)
    if (user.mfa_enabled !== true) return Response.redirect(redirectTo + '#no2fa', 303)
    let userId: string
    const existingUserId = await env.KV_DISCORD.get(user.id.toString())
    if (existingUserId) {
      userId = existingUserId
    } else {
      userId = loggedUserId || crypto.randomUUID()
      await env.KV_DISCORD.put(user.id.toString(), userId)
      if (userId !== loggedUserId) {
        // newly created user
        const userData = getDefaultUserData()
        if (!env.REQUIRE_INVITE) {
          userData.active = true
        }
        await env.KV_USERS.put(userId, JSON.stringify(userData))
      }
    }
    await env.KV_SESSIONS.put(sessionId, userId, { expirationTtl: 2592000 })
    return new Response('<html lang="en"><head><meta http-equiv="refresh" content="0;URL=\'' + redirectTo + '\'"><title>Redirecting...</title></head></html>', {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'Set-Cookie': `${COOKIE_NAME}=${sessionId}; Max-Age=2592000; Secure; SameSite=${isLocal ? 'None' : 'Lax'}; HttpOnly; Path=/`,
      },
    })
  } else {
    return new Response(null, { status: 400 })
  }
})

router.get('/api/me', async (request, env: Env) => {
  const userId = await getUserId(request, env)
  if (!userId) return new Response('no user', { status: 401, headers: getCorsHeaders(request, env) })
  const userData = await getUserData(request, env)
  if (!userData) return new Response('no user data', { status: 401, headers: getCorsHeaders(request, env) })
  const stripeData = {
    stripe: {
      not_subscribed: new Array<string>(),
      subscribed: new Array<string>(),
    }
  }
  if (userData.stripe_customer_id && userData.stripe_customer_id !== 'DONT_CHARGE_ME') {
    const stripe = getStripe(env)
    const prices = await stripe.prices.list({
      expand: ['data.product'],
    })
    const subscriptions = await stripe.subscriptions.list({
      customer: userData.stripe_customer_id!
    })
    const alreadySubscribed =
      subscriptions.data
        .flatMap(e => e.items.data.map(item => item.price.product)) as string[]
    const products =
      prices.data.filter(e => (e.product as Stripe.Product).active && e.recurring?.usage_type === 'metered')
        .map(e => e.product as Stripe.Product)
    stripeData.stripe.not_subscribed = products.filter(e => !alreadySubscribed.includes(e.id)).map(e => e.id)
    stripeData.stripe.subscribed = alreadySubscribed
  }
  return Response.json({
    ...userData,
    ...stripeData,
    id: userId,
  }, {
    headers: {
      ...getCorsHeaders(request, env),
    }
  })
})

router.post('/api/activate_account', async (request, env: Env) => {
  if (!env.REQUIRE_INVITE) return new Response(null, { status: 400, headers: getCorsHeaders(request, env) })
  const code = String(request.query.code)
  if (!code) return new Response(null, { status: 400, headers: getCorsHeaders(request, env) })
  const userId = await getUserId(request, env)
  if (!userId) return new Response('no user id', { status: 401, headers: getCorsHeaders(request, env) })
  const userData = await getUserDataById(env, userId)
  if (!userData) return new Response('no user data', { status: 401, headers: getCorsHeaders(request, env) })
  if (userData.active) return new Response(null, { status: 400, headers: getCorsHeaders(request, env) })
  const inviteCode = await env.KV_INVITE_CODES.get<InviteCode>(code, { type: 'json' })
  if (!inviteCode) return new Response(null, { status: 403, headers: getCorsHeaders(request, env) })
  if (inviteCode.used >= inviteCode.limit) return new Response(null, { status: 403 })
  inviteCode.used++;
  userData.active = true
  userData.invite_code = code
  await env.KV_USERS.put(userId, JSON.stringify(userData))
  await env.KV_INVITE_CODES.put(code, JSON.stringify(inviteCode))
  return new Response(null, { status: 200, headers: getCorsHeaders(request, env) })
})

router.get('/api/logout', async (request, env: Env) => {
  const sessionId = getSessionId(request)
  if (sessionId) {
    await env.KV_SESSIONS.delete(sessionId)
  }
  const isLocal = request.headers.get('Host').includes('localhost')
  const redirectTo = isLocal ? 'http://localhost:3000' : '/'
  return new Response('<html lang="en"><head><meta http-equiv="refresh" content="0;URL=\'' + redirectTo + '\'"><title>Redirecting...</title></head></html>', {
    status: 200,
    headers: {
      'Content-Type': 'text/html',
      'Set-Cookie': `${COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`,
    },
  })
})

router.get('/api/checkout', async (request, env: Env) => {
  const userData = await getUserData(request, env)
  if (!userData || !userData.active) return new Response(null, { status: 401 })
  const isLocal = request.headers.get('Host').includes('localhost')
  const scheme = isLocal ? 'http://' : 'https://'
  const stripe = getStripe(env)
  const prices = await stripe.prices.list({
    expand: ['data.product'],
  })
  const filteredPrices =
    prices.data.filter(e => (e.product as Stripe.Product).active && e.recurring?.usage_type === 'metered')
  if (userData.stripe_customer_id) {
    // user is an existing customer
    // try to update current subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: userData.stripe_customer_id!
    })
    const alreadySubscribed =
      subscriptions.data.flatMap(e => e.items.data.map(item => item.price.product))
    const pricesToSubscribe = filteredPrices.filter(e => !alreadySubscribed.includes((e.product as Stripe.Product).id))
    for (const price of pricesToSubscribe) {
      await stripe.subscriptionItems.create({
        subscription: subscriptions.data[0].id,
        price: price.id,
      })
    }
    return Response.redirect(scheme + request.headers.get('Host') + '/api/checkout/portal', 303)
  }
  const session = await stripe.checkout.sessions.create({
    customer: userData.stripe_customer_id || undefined,
    billing_address_collection: 'auto',
    line_items: filteredPrices.map(e => ({ price: e.id })),
    mode: 'subscription',
    success_url: scheme + request.headers.get('Host') + '/api/checkout/success/cross_origin_redirect?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: scheme + request.headers.get('Host'),
  })
  return Response.redirect(session.url!, 303)
})

router.get('/api/checkout/success', async (request, env: Env) => {
  const userId = await getUserId(request, env)
  if (!userId) return new Response(null, { status: 401 })
  const userData = await getUserData(request, env)
  if (!userData) return new Response(null, { status: 401 })
  if (userData.stripe_customer_id) return new Response(null, { status: 400 })
  const stripeSessionId = request.query.session_id as string
  if (!stripeSessionId) return new Response(null, { status: 400 })
  const stripe = getStripe(env)
  const stripeSession = await stripe.checkout.sessions.retrieve(stripeSessionId)
  if (typeof stripeSession.customer === 'string') {
    userData.stripe_customer_id = stripeSession.customer
  } else {
    userData.stripe_customer_id = stripeSession.customer?.id || ''
  }
  await env.KV_USERS.put(userId, JSON.stringify(userData))
  return Response.redirect(stripeSession.cancel_url!, 303)
})

router.get('/api/checkout/success/cross_origin_redirect', async (request) => {
  const stripeSessionId = request.query.session_id as string
  if (!stripeSessionId) return new Response(null, { status: 400 })
  const isLocal = request.headers.get('Host').includes('localhost')
  const redirectTo = (isLocal ? 'http://localhost:3000' : '') + `/api/checkout/success?session_id=${stripeSessionId}`
  return new Response('<html lang="en"><head><meta http-equiv="refresh" content="0;URL=\'' + redirectTo + '\'"><title>Redirecting...</title></head></html>', {
    status: 200,
    headers: {
      'Content-Type': 'text/html',
    },
  })
})

router.get('/api/checkout/portal', async (request, env: Env) => {
  const isLocal = request.headers.get('Host').includes('localhost')
  const scheme = isLocal ? 'http://' : 'https://'
  const userData = await getUserData(request, env)
  if (!userData || !userData.stripe_customer_id) return new Response(null, { status: 401 })
  const stripe = getStripe(env)
  const session = await stripe.billingPortal.sessions.create({
    customer: userData.stripe_customer_id,
    return_url: scheme + request.headers.get('Host'),
  })
  return Response.redirect(session.url, 303)
})

// misc
router.get('/api/terms', (request, env: Env) => redirectCors(request, env, env.TOS_URL, 303))
router.get('/api/privacy-policy', (request, env: Env) => redirectCors(request, env, env.PRIVACY_POLICY_URL, 303))
router.get('/api/sct', (request, env: Env) => redirectCors(request, env, env.SCT_URL, 303))
router.get('/api/pricing', (request, env: Env) => redirectCors(request, env, env.PRICING_URL, 303))

// 404 for everything else
router.all('*', () => new Response('Not Found.', { status: 404 }));

export default router;
